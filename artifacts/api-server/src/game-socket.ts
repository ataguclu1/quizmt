import { Server as SocketIOServer, type Socket } from "socket.io";
import type { Server as HttpServer } from "node:http";
import { randomUUID } from "node:crypto";
import { logger } from "./lib/logger";
import { verifyToken, type AuthPayload } from "./middlewares/auth";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

/**
 * ============================================================================
 * OYUN OTURUMU (SOCKET) KATMANI
 * ============================================================================
 *
 * BU DOSYADA DÜZELTİLEN ÜÇ KÖK NEDEN
 * ---------------------------------------------------------------------------
 * (1) HAYALET DISCONNECT — Önceki sürümde `disconnect` olayı, kopan soketin
 *     hâlâ o oyuncunun GÜNCEL soketi olup olmadığına bakmadan işlem yapıyordu.
 *     Mobil bir cihazın bağlantısı "sessizce" öldüğünde (FIN paketi gelmez;
 *     sunucu bunu ancak ping timeout ile ~20-30 sn sonra fark eder) istemci çok
 *     daha erken yeniden bağlanır. Sıra şöyle oluyordu:
 *         t=0   Ali'nin soketi S1 sessizce ölür
 *         t=5   Ali S2 ile geri gelir, sunucu kaydını günceller (her şey yolunda)
 *         t=25  Sunucu NİHAYET S1'in öldüğünü fark eder ve `disconnect` çalışır:
 *               lobide `players.delete("Ali")` → CANLI oyuncu listeden silinir
 *     Ali'nin telefonu bunu hiç bilmez: `socket.join(room)` hâlâ geçerli olduğu
 *     için soruları görmeye devam eder, cevaplar, ekranında "Doğru!" yazar —
 *     ama sunucudaki `players` Map'inde artık yoktur. Sonuç: puanı işlenmez,
 *     leaderboard'da görünmez, rapora yazılmaz. ÜÇ BELİRTİ DE BUNDAN. Artık:
 *     soket eşleşmesi kontrol ediliyor ve oyuncu kaydı ASLA silinmiyor,
 *     yalnızca "çevrimdışı" işaretleniyor.
 *
 * (2) KİMLİK = İSİM — Oyuncular yalnızca isimle tanınıyordu. "Ali" ile "ali "
 *     ayrı kişi sayılıyor, aynı ismi yazan iki kişi tek kayda biniyordu
 *     (ikincisinin cevabı `answers[qIdx] !== undefined` kontrolüne takılıp
 *     sessizce çöpe gidiyordu). Artık her cihaz kalıcı bir `pid` taşıyor; isim
 *     yalnızca yedek eşleştirme anahtarı ve normalize ediliyor.
 *
 * (3) SESSİZ VERİ KAYBI — `submit-answer` reddedildiğinde istemciye hiçbir şey
 *     söylenmiyordu. Artık her cevap ya `answer-recorded` ya da
 *     `answer-rejected` ile yanıtlanıyor; sunucu oyuncuyu tanımıyorsa istemciye
 *     `resync-required` gönderip kendini yeniden kaydettiriyor.
 * ============================================================================
 */

interface PlayerAnswer {
  choice: number;
  ts: number;
  /** Bu cevap için puan zaten işlendi mi (çift puanlamayı önler). */
  scored: boolean;
  points: number;
}

interface PlayerData {
  /** Cihaz başına kalıcı, isimden bağımsız kimlik. Tek gerçek kimlik budur. */
  pid: string;
  name: string;
  /** Eşleştirme için normalize edilmiş isim (büyük/küçük harf, boşluk farkı önemsiz). */
  nameKey: string;
  avatar: { style: string; seed: string };
  score: number;
  answers: Record<number, PlayerAnswer>;
  /** Şu anki soket. Çevrimdışıyken null. */
  socketId: string | null;
  connected: boolean;
  /**
   * "Sahneye çıktı" mı? Katılımcı adını yazdığında kayıt oluşur ama HAZIR
   * sayılmaz; avatarını seçip "Sahneye Çık" dediğinde bu bayrak true olur.
   * Host ekranındaki katılımcı sayısı yalnızca hazır VE bağlı olanları sayar,
   * oyuna da yalnızca onlar alınır. Oyun başladıktan sonra sahneye çıkan biri
   * sıradaki sorudan itibaren yarışmaya dahil olur.
   */
  ready: boolean;
  joinedAt: number;
  lastSeen: number;
}

interface GameSession {
  pin: string;
  hostSocketId: string;
  /** Host tarayıcısının kalıcı kimliği — yeniden bağlanmayı güvenli kılar. */
  hostToken?: string;
  hostSicil?: string;
  title?: string;
  category?: string;
  phase: "lobby" | "question" | "reveal" | "leaderboard" | "end";
  qIdx: number;
  questions: unknown[];
  /** pid → oyuncu. İsimle DEĞİL, kalıcı kimlikle anahtarlanır. */
  players: Map<string, PlayerData>;
  qStartTs: number;
  qEndsAt: number;
  /** Cevabın açıklandığı an — gecikmeli cevaplara tanınan süre bundan sayılır. */
  revealTs: number;
  /** Puanı işlenmiş soru indeksleri — tekrar tekrar puanlamayı önler. */
  scoredQuestions: Set<number>;
  startedAt?: Date;
  endedAt?: number;
  savedToDb: boolean;
  // Host isteğe bağlı olarak kurar: belirli sorulara yanlış cevap veren
  // oyunculara sınav sonunda özel bir geribildirim mesajı/görseli gösterilir.
  // Boş/undefined ise özellik bu oturumda hiç devrede değildir.
  feedbackRules?: { qIdxs: number[]; message: string; imageUrl?: string }[];
}

const sessions = new Map<string, GameSession>();
const hostReconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** Host'un geri dönmesi için tanınan süre. */
const HOST_GRACE_MS = 45_000;
/** Cevap açıklandıktan sonra "yolda olan" cevaplara tanınan tolerans. */
const LATE_ANSWER_GRACE_MS = 2_500;
/** Lobide bu süreden uzun çevrimdışı kalan ve hiç cevabı olmayan oyuncu listeden düşer. */
const LOBBY_PRUNE_MS = 150_000;
/** Biten oturum, geç bağlanan katılımcılar sonucunu görebilsin diye bu kadar bellekte tutulur. */
const ENDED_SESSION_RETENTION_MS = 10 * 60_000;

export function setupSocketIO(httpServer: HttpServer) {
  const io = new SocketIOServer(httpServer, {
    path: "/api/socket.io",
    cors: { origin: "*", methods: ["GET", "POST"] },
    // Yarı-açık bağlantıları (soket "bağlı" görünür ama yayınlar ulaşmaz)
    // hızlı tespit etmek için sık ping. Kalabalık sınıf wifi'sinde gerçek
    // tıkanmayı ~30 sn içinde yakalar, kısa titremeleri kopma saymaz.
    pingTimeout: 20_000,
    pingInterval: 10_000,
    // Socket.IO'nun kendi kurtarma mekanizması: kısa kopmalarda oturum durumu
    // ve KAÇIRILAN YAYINLAR yeniden bağlanınca istemciye teslim edilir.
    // 2. hatanın (ekranın donup ancak sonraki soruda düzelmesi) doğrudan
    // panzehiri; alttaki `sync-request` ile birlikte iki katmanlı koruma.
    connectionStateRecovery: {
      maxDisconnectionDuration: 2 * 60_000,
      skipMiddlewares: true,
    },
    // Sesli sorular (base64 ses verisi, soru başına ~150-500KB) tüm soru
    // dizisiyle birlikte tek bir "create-session" mesajında gidiyor.
    maxHttpBufferSize: 25 * 1024 * 1024,
  });

  // ── SOKET KİMLİK DOĞRULAMASI ──────────────────────────────────────────────
  // GÜVENLİK DÜZELTMESİ: Önceden soket katmanında hiçbir kimlik doğrulaması
  // yoktu. "create-session" dahil bütün host olayları, PIN'i bilen ya da
  // doğrudan sokete bağlanan HERKESE açıktı. Sonuç: internetten herhangi biri
  // sunucu üzerinde oturum açabiliyor, `hostSicil` alanına istediği sicili
  // yazıp raporları başkasının üzerine kaydedebiliyordu.
  // Artık host tarafı, giriş sırasında alınan JWT'yi el sıkışmada (handshake)
  // gönderiyor. Katılımcılar için kimlik doğrulaması YOK — onlar eskisi gibi
  // yalnızca PIN ile katılıyor; değişen tek şey host yetkisi.
  io.use((socket, next) => {
    const raw = (socket.handshake?.auth as { token?: unknown } | undefined)?.token;
    if (typeof raw === "string" && raw.length > 0) {
      const payload = verifyToken(raw);
      if (payload) socket.data.user = payload;
    }
    next();
  });

  io.on("connection", (socket) => {
    logger.info({ socketId: socket.id, recovered: socket.recovered }, "Socket connected");

    // ── HOST: Create session ──────────────────────────────────────────────
    socket.on("create-session", (data: {
      pin: string; questions: unknown[]; title?: string; category?: string;
      hostSicil?: string; hostToken?: string; token?: string;
      feedbackRules?: { qIdxs: number[]; message: string; imageUrl?: string }[];
    }) => {
      let { pin } = data;
      const { questions, title, category, hostToken, feedbackRules } = data;

      // Oturum açma yetkisi yalnızca giriş yapmış kullanıcılarda.
      // Token iki yoldan gelebilir: bağlantı el sıkışmasında ya da bu olayın
      // yükünde. İkinci yol, soketin giriş yapılmadan ÖNCE kurulduğu (sayfa
      // açılışında tek bir soket açan) istemciler için gereklidir.
      const user = resolveUser(socket, (data as { token?: string }).token);
      if (!user) {
        socket.emit("session-error", { message: "Oturum oluşturmak için giriş yapmanız gerekiyor." });
        logger.warn({ socketId: socket.id }, "Unauthenticated create-session rejected");
        return;
      }
      // `hostSicil` ARTIK İSTEMCİDEN ALINMIYOR: raporların hangi eğitmene
      // yazılacağı, imzalı token'daki sicilden belirleniyor.
      const hostSicil = user.sicil;

      // KRİTİK DÜZELTME (3. hata — "sayı bir anda 0'a düşüyor"):
      // Host istemcisi her `connect` olayında `create-session` gönderiyordu.
      // Bağlantı bir an koptuğunda (laptop uykuya geçince, wifi titreyince,
      // Render free tier'da olağan) socket.io otomatik yeniden bağlanıyor,
      // `connect` tekrar tetikleniyor ve sunucu bunu YEPYENİ BİR OTURUM
      // sanıyordu:
      //   • PIN doluysa → başka bir PIN üretiliyordu (host ekranda eski PIN'i
      //     gösterdiği için kimse katılamıyordu),
      //   • PIN boşaldıysa (grace süresi dolup eski oturum silindiyse) →
      //     aynı PIN'de SIFIR oyunculu yeni bir oturum kuruluyordu.
      // Host artık kalıcı bir `hostToken` taşıyor: aynı token ile gelen
      // `create-session`, yeni oturum değil YENİDEN BAĞLANMA olarak işleniyor.
      if (hostToken) {
        const existing = [...sessions.values()].find(
          (s) => s.hostToken === hostToken && s.hostSicil === user.sicil && s.phase !== "end",
        );
        if (existing) {
          adoptHost(io, socket, existing);
          socket.emit("session-created", { pin: existing.pin, resumed: true });
          logger.info({ pin: existing.pin }, "Host re-created session → adopted as reconnect");
          return;
        }
      }

      // İstemci rastgele bir PIN öneriyor ama son sözü sunucu söylüyor.
      while (sessions.has(pin)) {
        pin = String(Math.floor(100000 + Math.random() * 900000));
      }

      sessions.set(pin, {
        pin,
        hostSocketId: socket.id,
        hostToken,
        hostSicil,
        title,
        category,
        phase: "lobby",
        qIdx: 0,
        questions,
        players: new Map(),
        qStartTs: 0,
        qEndsAt: 0,
        revealTs: 0,
        scoredQuestions: new Set(),
        startedAt: new Date(),
        savedToDb: false,
        feedbackRules: Array.isArray(feedbackRules) && feedbackRules.length ? feedbackRules : undefined,
      });
      socket.join(`game-${pin}`);
      socket.data.pin = pin;
      socket.data.isHost = true;
      socket.emit("session-created", { pin });
      logger.info({ pin, hasFeedbackRules: !!feedbackRules?.length }, "Game session created");
    });

    // ── PLAYER: Join / rejoin session ─────────────────────────────────────
    socket.on("join-session", (data: {
      pin: string; name: string; avatar: { style: string; seed: string }; pid?: string; ready?: boolean;
    }) => {
      const { pin, name, avatar } = data;
      const session = sessions.get(pin);

      if (!session) {
        socket.emit("join-error", { message: "Geçersiz PIN. Böyle bir oturum bulunamadı." });
        return;
      }

      const cleanName = String(name || "").trim().slice(0, 30);
      if (!cleanName) {
        socket.emit("join-error", { message: "İsim boş olamaz." });
        return;
      }

      const { player, isNew } = resolvePlayer(session, {
        pid: data.pid,
        name: cleanName,
        avatar,
        socketId: socket.id,
      });

      socket.join(`game-${pin}`);
      socket.data.pin = pin;
      socket.data.pid = player.pid;
      socket.data.name = player.name;

      // Yeniden bağlanan biri daha önce sahneye çıkmışsa o durumu geri al.
      if (data.ready === true) player.ready = true;

      // Oturum bittiyse: biten oturum bir süre bellekte tutuluyor ve geç
      // bağlanana final durumu gönderiliyor.
      if (session.phase === "end") {
        socket.emit("rejoin-player-success", buildPlayerState(session, player));
        emitPersonalResult(io, session, player);
        return;
      }

      // ★ SAHNEYE ÇIKMA AKIŞI ★
      // Henüz sahneye çıkmamış biri (adını yeni yazdı ya da avatar ekranında)
      // oyuna DAHİL DEĞİLDİR: soru ekranına düşmez, sayılmaz. İstemci
      // "join-success" ile avatar/sahne ekranını gösterir. Bu, oyun başladıktan
      // sonra katılan biri için de aynı şekilde çalışır — böylece geç katılım
      // bozulmadan korunur.
      if (!player.ready) {
        socket.emit("join-success", {
          pin, name: player.name, pid: player.pid,
          phase: session.phase,
          inProgress: session.phase !== "lobby",
        });
      } else {
        socket.emit("rejoin-player-success", buildPlayerState(session, player));
      }

      broadcastPlayers(io, session, { joinedName: player.name, avatar: player.avatar });
      logger.info(
        { pin, name: player.name, pid: player.pid, isNew, phase: session.phase },
        isNew ? "Player joined" : "Player rejoined",
      );
    });

    // ── PLAYER/HOST: Durum senkronizasyonu ────────────────────────────────
    // 2. HATANIN ANA PANZEHİRİ. Yarı-açık bir sokette yayın kaybolduğunda
    // istemci "donuyor" ve ancak bir sonraki yayın ulaştığında düzeliyordu.
    // Artık istemci; sekmeye geri dönünce, ağ değişince ve düzenli aralıkla
    // sunucuya "şu an ne olmalıyım?" diye soruyor ve otoriter durumu alıyor.
    socket.on("sync-request", (data: { pin: string; pid?: string; haveQIdx?: number }) => {
      const session = sessions.get(data?.pin);
      if (!session) {
        socket.emit("sync-failed", { message: "Oturum bulunamadı." });
        return;
      }
      if (socket.data.isHost || session.hostSocketId === socket.id) {
        socket.emit("state-sync", buildHostState(session));
        return;
      }
      const pid = data.pid || (socket.data.pid as string | undefined);
      const player = pid ? session.players.get(pid) : undefined;
      if (!player) {
        // Sunucu bu kişiyi tanımıyor: istemciden kendini yeniden kaydetmesini iste.
        socket.emit("resync-required", {});
        return;
      }
      // Soket odada olmayabilir (kurtarılmış bağlantı) — garantiye al.
      socket.join(`game-${data.pin}`);
      socket.data.pid = player.pid;
      socket.data.pin = data.pin;
      if (player.socketId !== socket.id) {
        player.socketId = socket.id;
        player.connected = true;
        player.lastSeen = Date.now();
        broadcastPlayers(io, session);
      }
      // BANT GENİŞLİĞİ KORUMASI: istemci zaten bu sorunun elinde olduğunu
      // söylüyorsa soruyu tekrar göndermiyoruz. Sesli sorularda soru gövdesi
      // base64 ses verisiyle birlikte 150-500KB olabiliyor; düzenli
      // senkronizasyonda bunu her seferinde yollamak, kalabalık bir sınıfta
      // sunucuyu tek başına boğardı.
      const upToDate =
        typeof data.haveQIdx === "number" &&
        data.haveQIdx === session.qIdx &&
        (session.phase === "question" || session.phase === "reveal");
      socket.emit("state-sync", buildPlayerState(session, player, { omitQuestion: upToDate }));
    });

    // ── PLAYER: Sahneye çık ───────────────────────────────────────────────
    // Katılımcı avatarını seçip "Sahneye Çık" dediğinde gelir. Kişi bu andan
    // itibaren "hazır" sayılır: host ekranında yarışmaya hazır katılımcı olarak
    // görünür ve oyuna dahil edilir. Oyun çoktan başlamışsa, o anki duruma göre
    // (sıradaki soruyu bekleyerek) hemen katılır.
    socket.on("enter-stage", (data: { pin: string; pid?: string; avatar?: { style: string; seed: string } }) => {
      const session = sessions.get(data?.pin);
      if (!session) return;
      const pid = (socket.data.pid as string | undefined) || data.pid;
      const player = pid ? session.players.get(pid) : undefined;
      if (!player) {
        socket.emit("resync-required", {});
        return;
      }
      if (data.avatar) player.avatar = data.avatar;
      player.ready = true;
      player.lastSeen = Date.now();

      // Kişiye o anki otoriter durumu gönder: lobideyse bekleme ekranında
      // kalır, oyun sürüyorsa doğrudan güncel soruya/faza girer.
      socket.emit("rejoin-player-success", {
        ...buildPlayerState(session, player),
        isLateJoin: session.phase !== "lobby",
      });

      broadcastPlayers(io, session, { joinedName: player.name, avatar: player.avatar });
      logger.info({ pin: data.pin, name: player.name, phase: session.phase }, "Player entered the stage");
    });

    // ── PLAYER: Update avatar ─────────────────────────────────────────────
    socket.on("update-avatar", (data: { pin: string; pid?: string; name?: string; avatar: { style: string; seed: string } }) => {
      const session = sessions.get(data.pin);
      if (!session) return;
      // Kimlik yalnızca soketten (bkz. submit-answer'daki güvenlik notu).
      const pid = socket.data.pid as string | undefined;
      const player = pid ? session.players.get(pid) : undefined;
      if (!player) return;
      player.avatar = data.avatar;
      // ÖNEMLİ: Yalnızca "players-updated" yayınlamak yetmiyordu — host
      // istemcisi bu olayı dinlemediği için avatar değişikliği ekrana
      // yansımıyordu. Eski olay adıyla da yayınlıyoruz.
      broadcastPlayers(io, session, { joinedName: player.name, avatar: player.avatar });
    });

    // ── HOST: Start game ──────────────────────────────────────────────────
    socket.on("start-game", (data: { pin: string }) => {
      const session = sessions.get(data.pin);
      if (!isHostOf(session, socket)) return;

      session.phase = "question";
      session.qIdx = 0;
      session.startedAt = new Date();
      armQuestionClock(session, 0);

      io.to(`game-${data.pin}`).emit("game-started", {
        qIdx: 0,
        question: getQuestionForPlayers(session, 0),
        total: session.questions.length,
        title: session.title,
        ...clockPayload(session),
      });
      logger.info({ pin: data.pin, players: session.players.size }, "Game started");
    });

    // ── HOST: Gerçek cevap süresi şimdi başladı ────────────────────────────
    // Host ekranındaki 3-2-1 animasyonu / sesli soru çalma süresi bittikten
    // sonra gönderilir; sunucu saatini o ANA göre kurar ve tüm odaya yeni
    // bitiş zamanını yayınlar, böylece herkesin sayacı aynı ana dayanır.
    socket.on("question-timer-started", (data: { pin: string; qIdx: number }) => {
      const session = sessions.get(data.pin);
      if (!isHostOf(session, socket)) return;
      if (data.qIdx !== session.qIdx) return;
      armQuestionClock(session, session.qIdx);
      io.to(`game-${data.pin}`).emit("timer-sync", { qIdx: session.qIdx, ...clockPayload(session) });
    });

    // ── HOST: Show question ───────────────────────────────────────────────
    socket.on("show-question", (data: { pin: string; qIdx: number }) => {
      const session = sessions.get(data.pin);
      if (!isHostOf(session, socket)) return;

      session.phase = "question";
      session.qIdx = data.qIdx;
      armQuestionClock(session, data.qIdx);

      io.to(`game-${data.pin}`).emit("question-shown", {
        qIdx: data.qIdx,
        question: getQuestionForPlayers(session, data.qIdx),
        total: session.questions.length,
        ...clockPayload(session),
      });
    });

    // ── PLAYER: Submit answer ─────────────────────────────────────────────
    socket.on("submit-answer", (data: { pin: string; name?: string; pid?: string; qIdx: number; choice: number }) => {
      const { pin, qIdx, choice } = data;
      const session = sessions.get(pin);
      if (!session) {
        socket.emit("answer-rejected", { qIdx, reason: "no-session" });
        return;
      }

      // ★ GÜVENLİK DÜZELTMESİ (kimlik sahteciliği) ★
      // Kimlik ARTIK yalnızca soketin kendi oturumundan okunuyor. Önceden
      // istemcinin gönderdiği `pid`/`name` alanlarına güveniliyordu; bu,
      // oturumdaki bir katılımcının başka bir katılımcının adına cevap
      // göndermesine (onun puanını bozmasına) izin veriyordu.
      const pid = socket.data.pid as string | undefined;
      const player = pid ? session.players.get(pid) : undefined;

      // Sunucu bu kişiyi tanımıyor: eskiden cevap SESSİZCE çöpe gidiyordu
      // (1. hatanın görünmez yarısı). Artık istemciye "kendini yeniden kaydet"
      // deniyor; istemci join-session gönderip cevabı tekrarlıyor.
      if (!player) {
        logger.warn({ pin, pid, name: data.name, qIdx }, "Answer from unknown player — asking client to resync");
        socket.emit("resync-required", {});
        socket.emit("answer-rejected", { qIdx, reason: "unknown-player" });
        return;
      }

      player.lastSeen = Date.now();
      if (player.socketId !== socket.id) {
        player.socketId = socket.id;
        player.connected = true;
      }

      if (!player.ready) {
        // Sahneye çıkmamış biri yarışmanın parçası değildir.
        socket.emit("answer-rejected", { qIdx, reason: "not-on-stage" });
        return;
      }

      if (qIdx !== session.qIdx) {
        socket.emit("answer-rejected", { qIdx, reason: "wrong-question" });
        return;
      }

      // Aynı cevabın tekrarı (istemci yeniden denemiş olabilir) → hata değil,
      // olumlu onay dön ki istemci "kaydedilmedi" sanıp döngüye girmesin.
      if (player.answers[qIdx] !== undefined) {
        socket.emit("answer-recorded", { qIdx, choice: player.answers[qIdx].choice });
        return;
      }

      const now = Date.now();
      const inQuestionPhase = session.phase === "question";
      // Ağ gecikmesi yüzünden cevabın açıklanmasından hemen SONRA ulaşan
      // cevaplar da kabul edilir. Kalabalık bir sınıfta 25 kişinin cevabı aynı
      // saniyede geldiğinde son birkaçının paketi, host "Cevabı Göster"e
      // bastıktan sonra ulaşabiliyor ve eskiden tamamen kayboluyordu.
      const inGrace =
        (session.phase === "reveal" || session.phase === "leaderboard") &&
        session.revealTs > 0 &&
        now - session.revealTs <= LATE_ANSWER_GRACE_MS;

      if (!inQuestionPhase && !inGrace) {
        socket.emit("answer-rejected", { qIdx, reason: "closed" });
        return;
      }

      const q = session.questions[qIdx] as Record<string, unknown> | undefined;
      const optionCount = ((q?.["answers"] as unknown[]) || []).length;
      if (!Number.isInteger(choice) || choice < 0 || (optionCount > 0 && choice >= optionCount)) {
        socket.emit("answer-rejected", { qIdx, reason: "invalid-choice" });
        return;
      }

      player.answers[qIdx] = { choice, ts: now, scored: false, points: 0 };

      // Soru zaten puanlandıysa (grace ile gelen geç cevap) bu cevabı tek
      // başına puanla — yoksa puanı hiç işlenmezdi.
      if (session.scoredQuestions.has(qIdx)) {
        scoreSingleAnswer(session, qIdx, player);
        io.to(session.hostSocketId).emit("players-updated", playersPayload(session));
      }

      socket.emit("answer-recorded", { qIdx, choice });

      const answeredCount = countAnswered(session, qIdx);
      const onlineCount = countReadyOnline(session);
      io.to(session.hostSocketId).emit("player-answered", {
        name: player.name, pid: player.pid, qIdx, choice, answeredCount,
        totalPlayers: onlineCount,
        onlinePlayers: onlineCount,
        answerCounts: getAnswerCounts(session, qIdx),
      });

      // "Herkes cevapladı" artık ÇEVRİMİÇİ oyuncuya göre hesaplanıyor. Eskiden
      // kopan tek bir kişi bu sinyali sonsuza kadar engelliyordu.
      if (answeredCount >= Math.max(1, onlineCount)) {
        io.to(session.hostSocketId).emit("all-answered", { qIdx });
      }
    });

    // ── HOST: Manually trigger voice-question playback ──────────────────────
    socket.on("trigger-voice-play", (data: { pin: string }) => {
      const session = sessions.get(data.pin);
      if (!isHostOf(session, socket)) return;
      io.to(`game-${data.pin}`).emit("voice-playback-triggered", { qIdx: session.qIdx });
    });

    // ── HOST: Reveal answer ───────────────────────────────────────────────
    socket.on("reveal-answer", (data: { pin: string; qIdx: number }) => {
      const session = sessions.get(data.pin);
      if (!isHostOf(session, socket)) return;
      if (session.phase === "reveal" || session.phase === "leaderboard") return;

      session.phase = "reveal";
      session.revealTs = Date.now();
      const q = session.questions[data.qIdx] as Record<string, unknown>;

      calculateScores(session, data.qIdx);

      io.to(`game-${data.pin}`).emit("answer-revealed", {
        qIdx: data.qIdx,
        correctIndexes: getCorrectIndexes(q),
        playerScores: getPlayersScores(session),
        answerCounts: getAnswerCounts(session, data.qIdx),
      });
      io.to(session.hostSocketId).emit("players-updated", playersPayload(session));
      logger.info({ pin: data.pin, qIdx: data.qIdx }, "Answer revealed");
    });

    // ── HOST: Show leaderboard ────────────────────────────────────────────
    socket.on("show-leaderboard", (data: { pin: string }) => {
      const session = sessions.get(data.pin);
      if (!isHostOf(session, socket)) return;

      session.phase = "leaderboard";
      io.to(`game-${data.pin}`).emit("leaderboard-shown", {
        leaderboard: getSortedLeaderboard(session),
        qIdx: session.qIdx,
        isLast: session.qIdx >= session.questions.length - 1,
      });
    });

    // ── HOST: Next question ───────────────────────────────────────────────
    socket.on("next-question", (data: { pin: string; qIdx?: number }) => {
      const session = sessions.get(data.pin);
      if (!isHostOf(session, socket)) return;

      // Host ekranı hangi soruda olduğunu biliyor; varsa onu otorite kabul et.
      // Eskiden yalnızca `qIdx++` vardı: yeniden bağlanma sonrası gönderilen
      // tek bir fazladan "next" soruların atlanmasına yol açardı.
      const nextIdx = typeof data.qIdx === "number" ? data.qIdx : session.qIdx + 1;
      if (nextIdx >= session.questions.length) return;

      session.qIdx = nextIdx;
      session.phase = "question";
      armQuestionClock(session, nextIdx);

      io.to(`game-${data.pin}`).emit("question-shown", {
        qIdx: session.qIdx,
        question: getQuestionForPlayers(session, session.qIdx),
        total: session.questions.length,
        ...clockPayload(session),
      });
    });

    // ── HOST: End game ────────────────────────────────────────────────────
    socket.on("end-game", (data: { pin: string }) => {
      const session = sessions.get(data.pin);
      if (!isHostOf(session, socket)) return;
      finishGame(io, session);
    });

    // ── HOST: Cancel/Stop mid-game ────────────────────────────────────────
    socket.on("host-cancel", (data: { pin: string }) => {
      const session = sessions.get(data.pin);
      if (!session) return;
      // GÜVENLİK DÜZELTMESİ: Önceki kontrol "kendi oturumunun host'u olan
      // herhangi biri" için geçiyordu; yani bir kişi kendi oturumunu açıp
      // ardından BAŞKASININ PIN'iyle bu olayı göndererek onun canlı oturumunu
      // kapatabiliyordu. Artık yalnızca oturumun güncel host soketi iptal
      // edebilir.
      if (session.hostSocketId !== socket.id) {
        logger.warn({ pin: data.pin, socketId: socket.id }, "Unauthorized host-cancel attempt");
        return;
      }

      io.to(`game-${data.pin}`).emit("game-stopped", {
        message: "Oturum yöneticisi tarafından durduruldu.",
      });

      // Yarıda kesilse bile, oynanmış sorular varsa sonuçlar kaybolmasın.
      if (session.phase !== "lobby") {
        void persistSession(session, getSortedLeaderboard(session));
      }
      sessions.delete(data.pin);
      logger.info({ pin: data.pin }, "Game cancelled by host");
    });

    // ── HOST: Rejoin after reconnect ─────────────────────────────────────
    socket.on("rejoin-session", (data: { pin: string; hostToken?: string; token?: string }) => {
      const session = sessions.get(data.pin);
      if (!session) {
        socket.emit("rejoin-failed", {});
        return;
      }
      // ★ GÜVENLİK DÜZELTMESİ (oturum ele geçirme) ★
      // Önceki kontrol yalnızca "token GÖNDERİLDİYSE eşleşsin" diyordu; hiç
      // token göndermeyen bir istemci kontrolden geçip oturumu devralabiliyordu.
      // PIN projeksiyonda herkesin gözü önünde durduğu için bu, sınıftaki
      // herhangi birinin oturumun yönetimini ele geçirebilmesi demekti.
      // Artık devralma için hem giriş yapmış olmak, hem oturumu açan sicil
      // olmak, hem de aynı host token'ı taşımak gerekiyor.
      const rejoinUser = resolveUser(socket, data.token);
      const authorized =
        !!rejoinUser &&
        (session.hostSicil ? session.hostSicil === rejoinUser.sicil : true) &&
        (!session.hostToken || session.hostToken === data.hostToken);

      if (!authorized) {
        socket.emit("rejoin-failed", { message: "Bu oturumu devralma yetkiniz yok." });
        logger.warn({ pin: data.pin, socketId: socket.id }, "Unauthorized rejoin-session attempt");
        return;
      }
      if (data.hostToken && !session.hostToken) session.hostToken = data.hostToken;

      adoptHost(io, socket, session);
      logger.info({ pin: data.pin }, "Host rejoined session");
    });

    // ── PLAYER: bilerek ayrılma ───────────────────────────────────────────
    socket.on("leave-session", (data: { pin: string; pid?: string }) => {
      const session = sessions.get(data?.pin);
      if (!session) return;
      // Kimlik yalnızca soketten: aksi hâlde bir katılımcı, başka birinin
      // kimliğiyle "ayrılıyorum" diyerek onu lobiden düşürebilirdi.
      const pid = socket.data.pid as string | undefined;
      if (!pid) return;
      const player = session.players.get(pid);
      if (!player) return;
      // Yalnızca lobide ve hiç cevabı yoksa tamamen sil; oyun başladıysa kaydı
      // korumak zorundayız (rapor bütünlüğü).
      if (session.phase === "lobby" && Object.keys(player.answers).length === 0) {
        session.players.delete(pid);
      } else {
        player.connected = false;
        player.socketId = null;
      }
      broadcastPlayers(io, session, { leftName: player.name });
    });

    // ── Disconnect ────────────────────────────────────────────────────────
    socket.on("disconnect", (reason) => {
      const pin = socket.data.pin as string | undefined;
      const pid = socket.data.pid as string | undefined;
      const isHost = socket.data.isHost as boolean | undefined;

      if (pin) {
        const session = sessions.get(pin);
        if (session) {
          if (isHost) {
            // Sadece GÜNCEL host soketi koptuysa işlem yap. Eski bir soketin
            // geç gelen disconnect'i, yeni host bağlantısını düşürmemeli.
            if (session.hostSocketId === socket.id) {
              io.to(`game-${pin}`).emit("host-reconnecting", { timeoutSec: Math.round(HOST_GRACE_MS / 1000) });
              logger.info({ pin, reason }, "Host disconnected — starting grace timer");

              const previous = hostReconnectTimers.get(pin);
              if (previous) clearTimeout(previous);

              const timer = setTimeout(() => {
                const s = sessions.get(pin);
                if (s && s.hostSocketId === socket.id) {
                  io.to(`game-${pin}`).emit("host-disconnected");
                  // Host bir daha dönmedi: oynanmış her şey raporlanabilsin diye
                  // oturumu yine de kaydet (eskiden tamamen kayboluyordu).
                  if (s.phase !== "lobby") void persistSession(s, getSortedLeaderboard(s));
                  sessions.delete(pin);
                  logger.info({ pin }, "Grace period expired — session destroyed");
                }
                hostReconnectTimers.delete(pin);
              }, HOST_GRACE_MS);
              hostReconnectTimers.set(pin, timer);
            }
          } else if (pid) {
            const player = session.players.get(pid);
            // ★ 1. VE 3. HATANIN KÖK NEDENİNİN DÜZELTİLDİĞİ YER ★
            // Yalnızca kopan soket, oyuncunun GÜNCEL soketiyse çevrimdışı
            // işaretle. Oyuncu kaydı HİÇBİR koşulda silinmez: puanı, cevapları
            // ve rapordaki satırı ayakta kalır.
            if (player && player.socketId === socket.id) {
              player.connected = false;
              player.socketId = null;
              player.lastSeen = Date.now();
              broadcastPlayers(io, session, { leftName: player.name });
              logger.info({ pin, name: player.name, reason }, "Player went offline — record preserved");
            } else {
              logger.info({ pin, pid, reason }, "Stale socket disconnect ignored (player already reconnected)");
            }
          }
        }
      }
      logger.info({ socketId: socket.id, reason }, "Socket disconnected");
    });
  });

  // ── Bakım döngüsü ────────────────────────────────────────────────────────
  // • Lobide uzun süre çevrimdışı kalan ve hiç cevabı olmayan kayıtları düşer
  //   (gerçekten ayrılanlar listeyi şişirmesin).
  // • Biten oturumları saklama süresi dolunca bellekten siler.
  const sweeper = setInterval(() => {
    const now = Date.now();
    for (const [pin, session] of sessions) {
      if (session.phase === "end") {
        if (session.endedAt && now - session.endedAt > ENDED_SESSION_RETENTION_MS) {
          sessions.delete(pin);
        }
        continue;
      }
      if (session.phase !== "lobby") continue;
      let changed = false;
      for (const [pid, player] of session.players) {
        if (
          !player.connected &&
          now - player.lastSeen > LOBBY_PRUNE_MS &&
          Object.keys(player.answers).length === 0
        ) {
          session.players.delete(pid);
          changed = true;
        }
      }
      if (changed) broadcastPlayers(io, session);
    }
  }, 30_000);
  sweeper.unref?.();

  return io;
}

// ─── Host yardımcıları ──────────────────────────────────────────────────────

/**
 * Soketin kimliğini çözer. Token el sıkışmasında gelmişse zaten çözülmüştür;
 * gelmediyse olay yükündeki token doğrulanır ve sokete iliştirilir.
 */
function resolveUser(socket: Socket, tokenFromPayload?: string): AuthPayload | undefined {
  const existing = socket.data.user as AuthPayload | undefined;
  if (existing) return existing;
  if (typeof tokenFromPayload === "string" && tokenFromPayload.length > 0) {
    const payload = verifyToken(tokenFromPayload);
    if (payload) {
      socket.data.user = payload;
      return payload;
    }
  }
  return undefined;
}

function isHostOf(session: GameSession | undefined, socket: Socket): session is GameSession {
  return !!session && session.hostSocketId === socket.id;
}

function adoptHost(io: SocketIOServer, socket: Socket, session: GameSession) {
  const timer = hostReconnectTimers.get(session.pin);
  if (timer) { clearTimeout(timer); hostReconnectTimers.delete(session.pin); }

  session.hostSocketId = socket.id;
  socket.join(`game-${session.pin}`);
  socket.data.pin = session.pin;
  socket.data.isHost = true;

  io.to(`game-${session.pin}`).emit("host-reconnected", {});
  socket.emit("session-rejoined", buildHostState(session));
}

function buildHostState(session: GameSession) {
  return {
    pin: session.pin,
    qIdx: session.qIdx,
    phase: session.phase,
    total: session.questions.length,
    playerCount: countReadyOnline(session),
    readyCount: countReadyOnline(session),
    waitingCount: countWaitingOnline(session),
    onlineCount: countOnline(session),
    totalCount: session.players.size,
    players: getPlayersArray(session),
    answeredCount: countAnswered(session, session.qIdx),
    answerCounts: getAnswerCounts(session, session.qIdx),
    leaderboard: getSortedLeaderboard(session),
    correctIndexes:
      session.phase === "reveal" || session.phase === "leaderboard"
        ? getCorrectIndexes(session.questions[session.qIdx] as Record<string, unknown>)
        : [],
    ...clockPayload(session),
  };
}

// ─── Oyuncu yardımcıları ────────────────────────────────────────────────────

function normalizeName(name: string): string {
  return name.trim().replace(/\s+/g, " ").toLocaleLowerCase("tr-TR");
}

/**
 * Bir katılım isteğini var olan bir oyuncuya bağlar ya da yeni kayıt açar.
 * Sıra: (1) kalıcı pid, (2) aynı isimli ÇEVRİMDIŞI kayıt (yeniden bağlanan kişi
 * odur), (3) yeni oyuncu. Aynı ismi taşıyan biri hâlâ çevrimiçiyse bu gerçekten
 * farklı bir kişidir; kayıtlar birbirine karışmasın diye görünen isim "(2)"
 * ekiyle ayrıştırılır.
 */
function resolvePlayer(
  session: GameSession,
  input: { pid?: string; name: string; avatar: { style: string; seed: string }; socketId: string },
): { player: PlayerData; isNew: boolean } {
  const nameKey = normalizeName(input.name);

  let player = input.pid ? session.players.get(input.pid) : undefined;

  if (!player) {
    const sameName = [...session.players.values()].filter((p) => p.nameKey === nameKey);
    // pid'i olmayan (eski istemci / depolaması silinmiş) biri geri dönüyorsa,
    // aynı isimli çevrimdışı kaydı devralsın: puanı ve cevapları korunur.
    player = sameName.find((p) => !p.connected);
  }

  if (player) {
    player.socketId = input.socketId;
    player.connected = true;
    player.lastSeen = Date.now();
    if (input.avatar) player.avatar = input.avatar;
    return { player, isNew: false };
  }

  // Yeni kişi. Aynı isim başka biri tarafından kullanılıyorsa görünen ismi ayır.
  let displayName = input.name;
  const sameNameTaken = [...session.players.values()].filter((p) => p.nameKey === nameKey);
  if (sameNameTaken.length > 0) {
    displayName = `${input.name} (${sameNameTaken.length + 1})`;
  }

  const created: PlayerData = {
    pid: input.pid && !session.players.has(input.pid) ? input.pid : randomUUID(),
    name: displayName,
    nameKey: normalizeName(displayName),
    avatar: input.avatar || { style: "avataaars", seed: displayName },
    score: 0,
    answers: {},
    socketId: input.socketId,
    connected: true,
    ready: false,
    joinedAt: Date.now(),
    lastSeen: Date.now(),
  };
  session.players.set(created.pid, created);
  return { player: created, isNew: true };
}

function buildPlayerState(session: GameSession, player: PlayerData, opts?: { omitQuestion?: boolean }) {
  const payload: Record<string, unknown> = {
    pin: session.pin,
    pid: player.pid,
    name: player.name,
    title: session.title,
    score: player.score,
    qIdx: session.qIdx,
    phase: session.phase,
    total: session.questions.length,
    ...clockPayload(session),
  };

  if (session.phase === "question" || session.phase === "reveal") {
    if (!opts?.omitQuestion) payload["question"] = getQuestionForPlayers(session, session.qIdx);
    payload["timeLeft"] = remainingSeconds(session);
    const myAnswer = player.answers[session.qIdx];
    payload["selected"] = myAnswer ? myAnswer.choice : null;
  }
  if (session.phase === "reveal") {
    payload["correctIndexes"] = getCorrectIndexes(session.questions[session.qIdx] as Record<string, unknown>);
  }
  if (session.phase === "leaderboard" || session.phase === "end") {
    payload["leaderboard"] = getSortedLeaderboard(session);
  }
  return payload;
}

function playersPayload(session: GameSession) {
  const ready = countReadyOnline(session);
  return {
    players: getPlayersArray(session),
    // Host ekranındaki ANA sayı: sahneye çıkmış VE o an bağlı olanlar.
    // F5 atan biri artık listeyi şişirmiyor; bağlantısı kopan da sayılmıyor.
    playerCount: ready,
    readyCount: ready,
    // Adını yazmış ama henüz sahneye çıkmamış, o an bağlı olanlar.
    waitingCount: countWaitingOnline(session),
    onlineCount: countOnline(session),
    totalCount: session.players.size,
  };
}

/**
 * Host'un katılımcı listesi TEK bir yerden üretilir. Eskiden liste üç ayrı
 * olaydan (player-joined / player-left / update-avatar) besleniyordu ve her biri
 * farklı bir anlık görüntü taşıyordu; geç gelen bir "player-left", güncel
 * listeyi eski ve eksik bir listeyle ezebiliyordu. Artık tek olay, tek payload —
 * 3. hatadaki "sayı oynaması" kısmen de bundan kaynaklanıyordu.
 */
function broadcastPlayers(
  io: SocketIOServer,
  session: GameSession,
  extra?: { joinedName?: string; avatar?: { style: string; seed: string }; leftName?: string },
) {
  const payload = playersPayload(session);
  io.to(session.hostSocketId).emit("players-updated", payload);
  // Eski istemcilerle uyum için aynı bilgi eski olay adlarıyla da gider.
  if (extra?.joinedName) {
    io.to(session.hostSocketId).emit("player-joined", { name: extra.joinedName, avatar: extra.avatar, ...payload });
  } else if (extra?.leftName) {
    io.to(session.hostSocketId).emit("player-left", { name: extra.leftName, ...payload });
  }
}

function countOnline(session: GameSession): number {
  let n = 0;
  session.players.forEach((p) => { if (p.connected) n++; });
  return n;
}

/** Sahneye çıkmış VE bağlı olanlar — oyunun gerçek katılımcı sayısı. */
function countReadyOnline(session: GameSession): number {
  let n = 0;
  session.players.forEach((p) => { if (p.connected && p.ready) n++; });
  return n;
}

/** Adını yazmış, henüz sahneye çıkmamış, bağlı olanlar. */
function countWaitingOnline(session: GameSession): number {
  let n = 0;
  session.players.forEach((p) => { if (p.connected && !p.ready) n++; });
  return n;
}

function countAnswered(session: GameSession, qIdx: number): number {
  let n = 0;
  session.players.forEach((p) => { if (p.answers[qIdx] !== undefined) n++; });
  return n;
}

// ─── Saat / zamanlayıcı ─────────────────────────────────────────────────────

function questionSeconds(session: GameSession, qIdx: number): number {
  const q = session.questions[qIdx] as Record<string, unknown> | undefined;
  const t = Number(q?.["time"]);
  return Number.isFinite(t) && t > 0 ? t : 20;
}

function armQuestionClock(session: GameSession, qIdx: number) {
  session.qStartTs = Date.now();
  session.qEndsAt = session.qStartTs + questionSeconds(session, qIdx) * 1000;
  session.revealTs = 0;
}

function remainingSeconds(session: GameSession): number {
  if (!session.qEndsAt) return questionSeconds(session, session.qIdx);
  return Math.max(0, Math.ceil((session.qEndsAt - Date.now()) / 1000));
}

/**
 * İstemcilerin sayacı kendi `setInterval`'ıyla değil SUNUCU SAATİYLE
 * yürütebilmesi için her soru yayınına eklenir. Mobil tarayıcılar arka plandaki
 * sekmede setInterval'ı kıstığı için yerel sayaç kayıyordu; artık istemci her
 * tikte `qEndsAt - now` hesaplayıp kendini düzeltebiliyor.
 */
function clockPayload(session: GameSession) {
  return {
    serverNow: Date.now(),
    qEndsAt: session.qEndsAt,
    timeLeft: remainingSeconds(session),
  };
}

// ─── Oyun sonu / kalıcılık ──────────────────────────────────────────────────

function finishGame(io: SocketIOServer, session: GameSession) {
  session.phase = "end";
  session.endedAt = Date.now();
  const leaderboard = getSortedLeaderboard(session);
  io.to(`game-${session.pin}`).emit("game-ended", { leaderboard });

  session.players.forEach((player) => emitPersonalResult(io, session, player, leaderboard));

  void persistSession(session, leaderboard);
  // Oturum HEMEN silinmiyor: geç bağlanan katılımcılar sonucunu görebilsin diye
  // bakım döngüsü tarafından saklama süresi sonunda temizlenir.
  logger.info({ pin: session.pin, players: session.players.size }, "Game ended");
}

function emitPersonalResult(
  io: SocketIOServer,
  session: GameSession,
  player: PlayerData,
  leaderboardArg?: ReturnType<typeof getSortedLeaderboard>,
) {
  if (!player.socketId) return;
  const leaderboard = leaderboardArg || getSortedLeaderboard(session);
  const rankByPid = new Map(leaderboard.map((p, i) => [p.pid, i + 1]));

  let correct = 0, wrong = 0, blank = 0;
  session.questions.forEach((q, qIdx) => {
    const correctIndexes = getCorrectIndexes(q as Record<string, unknown>);
    const ans = player.answers[qIdx];
    if (ans === undefined) { blank++; return; }
    if (correctIndexes.includes(ans.choice)) correct++; else wrong++;
  });

  io.to(player.socketId).emit("personal-result", {
    rank: rankByPid.get(player.pid) || null,
    totalPlayers: leaderboard.length,
    correct, wrong, blank,
    score: player.score,
  });

  if (session.feedbackRules?.length) {
    const items = session.feedbackRules
      .filter((rule) => rule.qIdxs.every((qIdx) => {
        const ans = player.answers[qIdx];
        const q = session.questions[qIdx] as Record<string, unknown>;
        if (!q) return false;
        const correctIndexes = getCorrectIndexes(q);
        // Cevap vermemiş olmak da "doğru cevaplamamış" sayılır.
        return ans === undefined || !correctIndexes.includes(ans.choice);
      }))
      .map((rule) => ({ message: rule.message, imageUrl: rule.imageUrl || null }));
    if (items.length) io.to(player.socketId).emit("feedback-shown", { items });
  }
}

async function persistSession(session: GameSession, leaderboard: unknown[]) {
  if (session.savedToDb) return;
  session.savedToDb = true;
  try {
    await db.execute(sql`
      INSERT INTO game_sessions (pin, title, category, host_sicil, question_count, player_count, questions, results, started_at, ended_at)
      VALUES (
        ${session.pin},
        ${session.title || null},
        ${session.category || null},
        ${session.hostSicil || null},
        ${session.questions.length},
        ${competingPlayers(session).length},
        ${JSON.stringify(session.questions)}::jsonb,
        ${JSON.stringify({
          leaderboard,
          playerAnswers: competingPlayers(session).map((p) => ({
            pid: p.pid,
            name: p.name,
            score: p.score,
            connectedAtEnd: p.connected,
            answers: p.answers,
          })),
        })}::jsonb,
        ${session.startedAt?.toISOString() || new Date().toISOString()},
        ${new Date().toISOString()}
      )
    `);
    logger.info({ pin: session.pin }, "Game session saved to DB");
  } catch (e) {
    // Kaydetme başarısız olduysa bayrağı geri al ki sonraki bir tetikleme
    // (ör. host-cancel) tekrar denesin.
    session.savedToDb = false;
    logger.error({ err: e, pin: session.pin }, "Failed to save game session to DB");
  }
}

// ─── Genel yardımcılar ──────────────────────────────────────────────────────

function getPlayersArray(session: GameSession) {
  return [...session.players.values()]
    .sort((a, b) => a.joinedAt - b.joinedAt)
    .map((p) => ({
      pid: p.pid,
      name: p.name,
      avatar: p.avatar,
      score: p.score,
      connected: p.connected,
      ready: p.ready,
    }));
}

function getPlayersScores(session: GameSession) {
  const result: Record<string, number> = {};
  session.players.forEach((p) => { result[p.name] = p.score; });
  return result;
}

/** Yarışmanın gerçek katılımcıları: sahneye çıkmış ya da en az bir cevabı olanlar. */
function competingPlayers(session: GameSession): PlayerData[] {
  return [...session.players.values()].filter(
    (p) => p.ready || Object.keys(p.answers).length > 0,
  );
}

function getSortedLeaderboard(session: GameSession) {
  return competingPlayers(session)
    .sort((a, b) => (b.score - a.score) || a.name.localeCompare(b.name, "tr"))
    .map((p, i) => ({ rank: i + 1, pid: p.pid, name: p.name, avatar: p.avatar, score: p.score, connected: p.connected }));
}

function getCorrectIndexes(q: Record<string, unknown>): number[] {
  const answers = q?.["answers"] as Array<{ text: string; correct: boolean }> | undefined;
  if (!answers) return [];
  return answers.map((a, i) => (a.correct ? i : -1)).filter((i) => i !== -1);
}

function getAnswerCounts(session: GameSession, qIdx: number): Record<number, number> {
  const counts: Record<number, number> = { 0: 0, 1: 0, 2: 0, 3: 0 };
  session.players.forEach((p) => {
    const ans = p.answers[qIdx];
    if (ans !== undefined) counts[ans.choice] = (counts[ans.choice] || 0) + 1;
  });
  return counts;
}

/** Tek bir oyuncunun tek bir sorudaki puanı (çift puanlamaya karşı korumalı). */
function scoreSingleAnswer(session: GameSession, qIdx: number, player: PlayerData) {
  const q = session.questions[qIdx] as Record<string, unknown>;
  if (!q) return;
  const ans = player.answers[qIdx];
  if (!ans || ans.scored) return;
  ans.scored = true;

  const correctIndexes = getCorrectIndexes(q);
  if (!correctIndexes.includes(ans.choice)) return;

  const pts = (q["pts"] as string) || "standard";
  const multiplier = pts === "double" ? 2 : pts === "none" ? 0 : 1;
  const maxTime = questionSeconds(session, qIdx) * 1000;

  const elapsed = Math.min(Math.max(0, ans.ts - session.qStartTs), maxTime);
  const speed = Math.max(0, 1 - elapsed / maxTime);
  const earned = Math.round(1000 * multiplier * (0.5 + 0.5 * speed));
  ans.points = earned;
  player.score += earned;
}

function calculateScores(session: GameSession, qIdx: number) {
  // Aynı soru iki kez puanlanmasın (host çift tıklarsa / olay tekrarlanırsa).
  session.scoredQuestions.add(qIdx);
  session.players.forEach((player) => scoreSingleAnswer(session, qIdx, player));
}

function getQuestionForPlayers(session: GameSession, qIdx: number) {
  const q = session.questions[qIdx] as Record<string, unknown>;
  if (!q) return null;
  const answers = q["answers"] as Array<{ text: string; correct: boolean }>;
  return {
    text: q["text"],
    time: q["time"],
    pts: q["pts"],
    answers: answers?.map((a) => ({ text: a.text })),
    // Sesli soru alanları — sadece questionType 'voice' ise anlamlı, diğer
    // türde undefined kalır ve istemci normal metin sorusu gibi davranır.
    questionType: q["questionType"],
    audioData: q["audioData"],
    audioAutoplay: q["audioAutoplay"],
    audioDurationSec: q["audioDurationSec"],
  };
}
