import { Server as SocketIOServer } from "socket.io";
import type { Server as HttpServer } from "node:http";
import { logger } from "./lib/logger";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

interface PlayerData {
  name: string;
  avatar: { style: string; seed: string };
  score: number;
  answers: Record<number, { choice: number; ts: number }>;
  socketId: string;
}

interface GameSession {
  pin: string;
  hostSocketId: string;
  hostSicil?: string;
  title?: string;
  category?: string;
  phase: "lobby" | "question" | "reveal" | "leaderboard" | "end";
  qIdx: number;
  questions: unknown[];
  players: Map<string, PlayerData>;
  qStartTs: number;
  startedAt?: Date;
  // Host isteğe bağlı olarak kurar: belirli sorulara yanlış cevap veren
  // oyunculara sınav sonunda özel bir geribildirim mesajı/görseli gösterilir.
  // Boş/undefined ise özellik bu oturumda hiç devrede değildir.
  feedbackRules?: { qIdxs: number[]; message: string; imageUrl?: string }[];
}

const sessions = new Map<string, GameSession>();
const hostReconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();

const HOST_GRACE_MS = 18_000; // 18 seconds for host to reconnect

export function setupSocketIO(httpServer: HttpServer) {
  const io = new SocketIOServer(httpServer, {
    path: "/api/socket.io",
    cors: { origin: "*", methods: ["GET", "POST"] },
    pingTimeout: 60_000,
    pingInterval: 25_000,
    // Sesli sorular (ElevenLabs'ten üretilen base64 ses verisi, soru başına
    // ~150-500KB olabiliyor) tüm soru dizisiyle birlikte tek bir socket
    // mesajında ("create-session") gidiyor. Varsayılan 1MB limiti, birkaç
    // sesli soru içeren bir sınavı sessizce bozabilirdi — bunu makul bir
    // güvenlik payıyla (tek bir sınavda onlarca sesli soru olsa bile
    // sorun çıkarmayacak kadar) yükseltiyoruz.
    maxHttpBufferSize: 25 * 1024 * 1024,
  });

  io.on("connection", (socket) => {
    logger.info({ socketId: socket.id }, "Socket connected");

    // ── HOST: Create session ──────────────────────────────────────────────
    socket.on("create-session", (data: { pin: string; questions: unknown[]; title?: string; category?: string; hostSicil?: string; feedbackRules?: { qIdxs: number[]; message: string; imageUrl?: string }[] }) => {
      let { pin } = data;
      const { questions, title, category, hostSicil, feedbackRules } = data;

      // İstemci rastgele bir PIN öneriyor ama son sözü sunucu söylüyor:
      // aynı PIN'de zaten aktif bir oturum varsa (çok düşük ama sıfır olmayan
      // bir ihtimal — birden fazla host aynı anda oturum açtığında), o
      // oturumun sessizce üzerine yazmak yerine çakışmayan yeni bir PIN
      // üretiyoruz ve gerçekte kullanılan PIN'i istemciye geri bildiriyoruz.
      while (sessions.has(pin)) {
        pin = String(Math.floor(100000 + Math.random() * 900000));
      }

      sessions.set(pin, {
        pin,
        hostSocketId: socket.id,
        hostSicil,
        title,
        category,
        phase: "lobby",
        qIdx: 0,
        questions,
        players: new Map(),
        qStartTs: 0,
        startedAt: new Date(),
        feedbackRules: Array.isArray(feedbackRules) && feedbackRules.length ? feedbackRules : undefined,
      });
      socket.join(`game-${pin}`);
      socket.data.pin = pin;
      socket.data.isHost = true;
      socket.emit("session-created", { pin });
      logger.info({ pin, hasFeedbackRules: !!feedbackRules?.length }, "Game session created");
    });

    // ── PLAYER: Join session ──────────────────────────────────────────────
    socket.on("join-session", (data: { pin: string; name: string; avatar: { style: string; seed: string } }) => {
      const { pin, name, avatar } = data;
      const session = sessions.get(pin);

      if (!session) {
        socket.emit("join-error", { message: "Geçersiz PIN. Böyle bir oturum bulunamadı." });
        return;
      }

      // Oyun devam ederken katılma: daha önce bu oturuma katılmış birinin
      // yeniden bağlanması (F5 / kopma) YA DA hiç katılmamış birinin geç
      // katılması — ikisi de aynı "mevcut duruma göre kaldığı/olduğu yerden
      // başlat" mantığını kullanıyor. Oturum tamamen bittiyse (end) yeni
      // katılım anlamsız, o zaman engelliyoruz.
      if (session.phase !== "lobby") {
        if (session.phase === "end") {
          socket.emit("join-error", { message: "Bu oturum sona erdi." });
          return;
        }

        let player = session.players.get(name);
        const isNewLateJoin = !player;
        if (!player) {
          // Geç katılan biri — puanı 0'dan başlar, geçmiş sorulara cevabı yok
          // (zaten o sorular sorulurken ortada değildi).
          player = { name, avatar, score: 0, answers: {}, socketId: socket.id };
          session.players.set(name, player);
        } else {
          player.socketId = socket.id;
        }

        socket.join(`game-${pin}`);
        socket.data.pin = pin;
        socket.data.name = name;

        const payload: Record<string, unknown> = {
          pin,
          name,
          score: player.score,
          qIdx: session.qIdx,
          phase: session.phase,
          total: session.questions.length,
          isLateJoin: isNewLateJoin,
        };

        if (session.phase === "question" || session.phase === "reveal") {
          const q = session.questions[session.qIdx] as Record<string, unknown>;
          payload.question = getQuestionForPlayers(session, session.qIdx);
          const qTime = (q?.["time"] as number) || 20;
          const elapsedSec = Math.floor((Date.now() - session.qStartTs) / 1000);
          payload.timeLeft = Math.max(0, qTime - elapsedSec);
          const myAnswer = player.answers[session.qIdx];
          payload.selected = myAnswer ? myAnswer.choice : null;
        }
        if (session.phase === "reveal") {
          const q = session.questions[session.qIdx] as Record<string, unknown>;
          payload.correctIndexes = getCorrectIndexes(q);
        }
        if (session.phase === "leaderboard") {
          payload.leaderboard = getSortedLeaderboard(session);
        }

        socket.emit("rejoin-player-success", payload);

        // Let the host know this player is here (updates the connected-player list live)
        io.to(session.hostSocketId).emit("player-joined", {
          name, avatar: player.avatar, playerCount: session.players.size, players: getPlayersArray(session),
        });

        logger.info({ pin, name, isNewLateJoin }, isNewLateJoin ? "Player joined late (game in progress)" : "Player rejoined in-progress session");
        return;
      }
      // Lobide de aynı ismin tekrar bağlanmasına izin ver (F5 / bağlantı kopması) —
      // önceden bu sadece oyun başladıktan sonraki fazlarda destekleniyordu, lobide
      // "isim zaten kullanımda" diye reddediliyordu; oysa çoğu zaman o isim zaten
      // az önce düşen kişinin kendisidir.
      const existingInLobby = session.players.get(name);
      if (existingInLobby) {
        existingInLobby.socketId = socket.id;
        existingInLobby.avatar = avatar;
        socket.join(`game-${pin}`);
        socket.data.pin = pin;
        socket.data.name = name;
        socket.emit("join-success", { pin, name });
        io.to(session.hostSocketId).emit("player-joined", {
          name, avatar, playerCount: session.players.size, players: getPlayersArray(session),
        });
        logger.info({ pin, name }, "Player rejoined lobby");
        return;
      }

      const player: PlayerData = { name, avatar, score: 0, answers: {}, socketId: socket.id };
      session.players.set(name, player);
      socket.join(`game-${pin}`);
      socket.data.pin = pin;
      socket.data.name = name;

      socket.emit("join-success", { pin, name });

      io.to(session.hostSocketId).emit("player-joined", {
        name, avatar, playerCount: session.players.size, players: getPlayersArray(session),
      });

      logger.info({ pin, name }, "Player joined session");
    });

    // ── PLAYER: Update avatar ─────────────────────────────────────────────
    socket.on("update-avatar", (data: { pin: string; name: string; avatar: { style: string; seed: string } }) => {
      const session = sessions.get(data.pin);
      if (!session) return;
      const player = session.players.get(data.name);
      if (!player) return;
      player.avatar = data.avatar;
      io.to(session.hostSocketId).emit("player-joined", {
        name: data.name, avatar: data.avatar,
        playerCount: session.players.size, players: getPlayersArray(session),
      });
    });

    // ── HOST: Start game ──────────────────────────────────────────────────
    socket.on("start-game", (data: { pin: string }) => {
      const session = sessions.get(data.pin);
      if (!session || session.hostSocketId !== socket.id) return;

      session.phase = "question";
      session.qIdx = 0;
      session.qStartTs = Date.now();
      session.startedAt = new Date();

      const q = getQuestionForPlayers(session, 0);
      io.to(`game-${data.pin}`).emit("game-started", {
        qIdx: 0, question: q, total: session.questions.length, title: session.title,
      });
      logger.info({ pin: data.pin }, "Game started");
    });

    // ── HOST: Show question ───────────────────────────────────────────────
    socket.on("show-question", (data: { pin: string; qIdx: number }) => {
      const session = sessions.get(data.pin);
      if (!session || session.hostSocketId !== socket.id) return;

      session.phase = "question";
      session.qIdx = data.qIdx;
      session.qStartTs = Date.now();

      io.to(`game-${data.pin}`).emit("question-shown", {
        qIdx: data.qIdx, question: getQuestionForPlayers(session, data.qIdx), total: session.questions.length,
      });
    });

    // ── PLAYER: Submit answer ─────────────────────────────────────────────
    socket.on("submit-answer", (data: { pin: string; name: string; qIdx: number; choice: number }) => {
      const { pin, name, qIdx, choice } = data;
      const session = sessions.get(pin);
      if (!session) return;

      // Only accept answers during active question phase
      if (session.phase !== "question") return;

      const player = session.players.get(name);
      if (!player || player.answers[qIdx] !== undefined) return;

      player.answers[qIdx] = { choice, ts: Date.now() };

      const answeredCount = [...session.players.values()].filter(p => p.answers[qIdx] !== undefined).length;

      socket.emit("answer-recorded", { qIdx, choice });

      io.to(session.hostSocketId).emit("player-answered", {
        name, qIdx, choice, answeredCount,
        totalPlayers: session.players.size,
        answerCounts: getAnswerCounts(session, qIdx),
      });

      if (answeredCount >= session.players.size) {
        io.to(session.hostSocketId).emit("all-answered", { qIdx });
      }
    });

    // ── HOST: Manually trigger voice-question playback ──────────────────────
    // Sesli sorularda "otomatik çalma" kapalıysa, host bu butona basana kadar
    // ses hiçbir istemcide çalmaz. Host bastığında tüm odaya (host dahil)
    // aynı anda "şimdi çal" sinyali gidiyor ki herkes eşzamanlı duysun.
    socket.on("trigger-voice-play", (data: { pin: string }) => {
      const session = sessions.get(data.pin);
      if (!session || session.hostSocketId !== socket.id) return;
      io.to(`game-${data.pin}`).emit("voice-playback-triggered", { qIdx: session.qIdx });
    });

    // ── HOST: Reveal answer ───────────────────────────────────────────────
    socket.on("reveal-answer", (data: { pin: string; qIdx: number }) => {
      const session = sessions.get(data.pin);
      if (!session || session.hostSocketId !== socket.id) return;

      // Guard: ignore duplicate reveal requests
      if (session.phase === "reveal" || session.phase === "leaderboard") return;

      session.phase = "reveal";
      const q = session.questions[data.qIdx] as Record<string, unknown>;

      calculateScores(session, data.qIdx);

      io.to(`game-${data.pin}`).emit("answer-revealed", {
        qIdx: data.qIdx,
        correctIndexes: getCorrectIndexes(q),
        playerScores: getPlayersScores(session),
      });
      logger.info({ pin: data.pin, qIdx: data.qIdx }, "Answer revealed");
    });

    // ── HOST: Show leaderboard ────────────────────────────────────────────
    socket.on("show-leaderboard", (data: { pin: string }) => {
      const session = sessions.get(data.pin);
      if (!session || session.hostSocketId !== socket.id) return;

      session.phase = "leaderboard";
      io.to(`game-${data.pin}`).emit("leaderboard-shown", {
        leaderboard: getSortedLeaderboard(session),
        isLast: session.qIdx >= session.questions.length - 1,
      });
    });

    // ── HOST: Next question ───────────────────────────────────────────────
    socket.on("next-question", (data: { pin: string }) => {
      const session = sessions.get(data.pin);
      if (!session || session.hostSocketId !== socket.id) return;

      session.qIdx++;
      session.phase = "question";
      session.qStartTs = Date.now();

      io.to(`game-${data.pin}`).emit("question-shown", {
        qIdx: session.qIdx, question: getQuestionForPlayers(session, session.qIdx), total: session.questions.length,
      });
    });

    // ── HOST: End game ────────────────────────────────────────────────────
    socket.on("end-game", (data: { pin: string }) => {
      const session = sessions.get(data.pin);
      if (!session || session.hostSocketId !== socket.id) return;

      session.phase = "end";
      const leaderboard = getSortedLeaderboard(session);
      io.to(`game-${data.pin}`).emit("game-ended", { leaderboard });

      // Her oyuncuya sınav sonunda kendi sırasını ve doğru/yanlış/boş sayısını
      // (rakam olarak) kişiye özel gönder — leaderboard'daki gibi broadcast
      // değil, sadece kendi ekranında görünsün.
      const rankByName = new Map(leaderboard.map((p, i) => [p.name, i + 1]));
      session.players.forEach(player => {
        let correct = 0, wrong = 0, blank = 0;
        session.questions.forEach((q, qIdx) => {
          const question = q as Record<string, unknown>;
          const correctIndexes = getCorrectIndexes(question);
          const ans = player.answers[qIdx];
          if (ans === undefined) { blank++; return; }
          if (correctIndexes.includes(ans.choice)) correct++; else wrong++;
        });
        io.to(player.socketId).emit("personal-result", {
          rank: rankByName.get(player.name) || null,
          totalPlayers: leaderboard.length,
          correct, wrong, blank,
          score: player.score,
        });
      });

      // Host bu sınav için geribildirim kuralları kurduysa, her oyuncuya —
      // yalnızca kendi yanlış yaptığı sorulara karşılık gelen kuralları,
      // kişiye özel olarak (broadcast değil, doğrudan kendi socket'ine) yolla.
      if (session.feedbackRules?.length) {
        session.players.forEach(player => {
          const items = session.feedbackRules!
            .filter(rule => rule.qIdxs.every(qIdx => {
              const ans = player.answers[qIdx];
              const q = session.questions[qIdx] as Record<string, unknown>;
              if (!q) return false;
              const correctIndexes = getCorrectIndexes(q);
              // Cevap vermemiş olmak da "doğru cevaplamamış" sayılır.
              return ans === undefined || !correctIndexes.includes(ans.choice);
            }))
            .map(rule => ({ message: rule.message, imageUrl: rule.imageUrl || null }));

          if (items.length) {
            io.to(player.socketId).emit("feedback-shown", { items });
          }
        });
      }

      saveGameSession(session, leaderboard).catch(e => logger.error({ err: e }, "Failed to save session"));
      sessions.delete(data.pin);
      logger.info({ pin: data.pin }, "Game ended");
    });

    // ── HOST: Cancel/Stop mid-game ────────────────────────────────────────
    socket.on("host-cancel", (data: { pin: string }) => {
      const session = sessions.get(data.pin);
      if (!session) return;

      io.to(`game-${data.pin}`).emit("game-stopped", {
        message: "Oturum yöneticisi tarafından durduruldu.",
      });

      sessions.delete(data.pin);
      logger.info({ pin: data.pin }, "Game cancelled by host");
    });

    // ── HOST: Rejoin after reconnect ─────────────────────────────────────
    socket.on("rejoin-session", (data: { pin: string }) => {
      const session = sessions.get(data.pin);
      if (!session) {
        socket.emit("rejoin-failed", {});
        return;
      }

      // Cancel pending destruction timer
      const timer = hostReconnectTimers.get(data.pin);
      if (timer) { clearTimeout(timer); hostReconnectTimers.delete(data.pin); }

      // Update host's socket reference
      session.hostSocketId = socket.id;
      socket.join(`game-${data.pin}`);
      socket.data.pin = data.pin;
      socket.data.isHost = true;

      // Tell players the host is back
      io.to(`game-${data.pin}`).emit("host-reconnected", {});

      // Send current state back to host
      socket.emit("session-rejoined", {
        pin: data.pin,
        qIdx: session.qIdx,
        phase: session.phase,
        playerCount: session.players.size,
        players: getPlayersArray(session),
      });
      logger.info({ pin: data.pin }, "Host rejoined session");
    });

    // ── Disconnect ────────────────────────────────────────────────────────
    socket.on("disconnect", () => {
      const pin = socket.data.pin as string | undefined;
      const name = socket.data.name as string | undefined;
      const isHost = socket.data.isHost as boolean | undefined;

      if (pin) {
        const session = sessions.get(pin);
        if (session) {
          if (isHost) {
            // Grace period: notify players but wait before destroying
            io.to(`game-${pin}`).emit("host-reconnecting", { timeoutSec: Math.round(HOST_GRACE_MS / 1000) });
            logger.info({ pin }, "Host disconnected — starting grace timer");

            const timer = setTimeout(() => {
              const s = sessions.get(pin);
              // Only destroy if no new host has taken over
              if (s && s.hostSocketId === socket.id) {
                io.to(`game-${pin}`).emit("host-disconnected");
                sessions.delete(pin);
                logger.info({ pin }, "Grace period expired — session destroyed");
              }
              hostReconnectTimers.delete(pin);
            }, HOST_GRACE_MS);
            hostReconnectTimers.set(pin, timer);
          } else if (name) {
            if (session.phase === "lobby") {
              // Lobby'de oyuncu çıktıysa listeden sil
              session.players.delete(name);
              io.to(session.hostSocketId).emit("player-left", {
                name, playerCount: session.players.size, players: getPlayersArray(session),
              });
            } else {
              // Oyun devam ederken: oyuncuyu MAP'te tut (yeniden bağlanabilsin)
              // Sadece host'a bildir
              logger.info({ pin, name }, "Player disconnected mid-game — kept in session for rejoin");
              io.to(session.hostSocketId).emit("player-left", {
                name, playerCount: session.players.size, players: getPlayersArray(session),
              });
            }
          }
        }
      }
      logger.info({ socketId: socket.id }, "Socket disconnected");
    });
  });

  return io;
}

async function saveGameSession(session: GameSession, leaderboard: unknown[]) {
  try {
    await db.execute(sql`
      INSERT INTO game_sessions (pin, title, category, host_sicil, question_count, player_count, questions, results, started_at, ended_at)
      VALUES (
        ${session.pin},
        ${session.title || null},
        ${session.category || null},
        ${session.hostSicil || null},
        ${session.questions.length},
        ${session.players.size},
        ${JSON.stringify(session.questions)}::jsonb,
        ${JSON.stringify({
          leaderboard,
          playerAnswers: [...session.players.entries()].map(([name, p]) => ({
            name,
            score: p.score,
            answers: p.answers,
          })),
        })}::jsonb,
        ${session.startedAt?.toISOString() || new Date().toISOString()},
        ${new Date().toISOString()}
      )
    `);
  } catch (e) {
    logger.error({ err: e }, "Failed to save game session to DB");
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function getPlayersArray(session: GameSession) {
  return [...session.players.values()].map(p => ({ name: p.name, avatar: p.avatar, score: p.score }));
}

function getPlayersScores(session: GameSession) {
  const result: Record<string, number> = {};
  session.players.forEach(p => { result[p.name] = p.score; });
  return result;
}

function getSortedLeaderboard(session: GameSession) {
  return [...session.players.values()]
    .sort((a, b) => b.score - a.score)
    .map((p, i) => ({ rank: i + 1, name: p.name, avatar: p.avatar, score: p.score }));
}

function getCorrectIndexes(q: Record<string, unknown>): number[] {
  const answers = q["answers"] as Array<{ text: string; correct: boolean }>;
  if (!answers) return [];
  return answers.map((a, i) => a.correct ? i : -1).filter(i => i !== -1);
}

function getAnswerCounts(session: GameSession, qIdx: number): Record<number, number> {
  const counts: Record<number, number> = { 0: 0, 1: 0, 2: 0, 3: 0 };
  session.players.forEach(p => {
    const ans = p.answers[qIdx];
    if (ans !== undefined) counts[ans.choice] = (counts[ans.choice] || 0) + 1;
  });
  return counts;
}

function calculateScores(session: GameSession, qIdx: number) {
  const q = session.questions[qIdx] as Record<string, unknown>;
  const correctIndexes = getCorrectIndexes(q);
  const pts = (q["pts"] as string) || "standard";
  const multiplier = pts === "double" ? 2 : pts === "none" ? 0 : 1;
  const maxTime = ((q["time"] as number) || 20) * 1000;
  const qStart = session.qStartTs;

  session.players.forEach(player => {
    const ans = player.answers[qIdx];
    if (ans === undefined) return;
    if (!correctIndexes.includes(ans.choice)) return;

    const elapsed = Math.max(0, ans.ts - qStart);
    const speed = Math.max(0, 1 - elapsed / maxTime);
    const base = 1000 * multiplier;
    const pts_earned = Math.round(base * (0.5 + 0.5 * speed));
    player.score += pts_earned;
  });
}

function getQuestionForPlayers(session: GameSession, qIdx: number) {
  const q = session.questions[qIdx] as Record<string, unknown>;
  if (!q) return null;
  const answers = q["answers"] as Array<{ text: string; correct: boolean }>;
  return {
    text: q["text"],
    time: q["time"],
    pts: q["pts"],
    answers: answers?.map(a => ({ text: a.text })),
    // Sesli soru alanları — sadece questionType 'voice' ise anlamlı, diğer
    // türde undefined kalır ve istemci normal metin sorusu gibi davranır.
    questionType: q["questionType"],
    audioData: q["audioData"],
    audioAutoplay: q["audioAutoplay"],
  };
}
