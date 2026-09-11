import { useState, useEffect, useRef, useCallback } from "react";
import { io, type Socket } from "socket.io-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");
const API_ORIGIN = window.location.origin;

interface Question {
  text: string;
  time: number;
  pts: string;
  answers: { text: string }[];
  /** 'voice' ise soru bir ses kaydıyla birlikte gelir. */
  questionType?: string;
  audioData?: string | null;
  audioAutoplay?: boolean;
  audioDurationSec?: number;
}

type Phase = "join" | "lobby" | "question" | "reveal" | "leaderboard" | "end";

interface LeaderboardEntry {
  rank: number;
  name: string;
  score: number;
  pid?: string;
}

interface PersonalResult {
  rank: number | null;
  totalPlayers: number;
  correct: number;
  wrong: number;
  blank: number;
  score: number;
}

const COLORS = ["bg-red-500", "bg-blue-500", "bg-yellow-500", "bg-green-500"];
const SHAPES = ["▲", "◆", "●", "■"];
const SESSION_KEY = "quiz-player-session";
const PID_KEY = "quiz-player-pid";

/**
 * KALICI OYUNCU KİMLİĞİ.
 * Eskiden bir katılımcı yalnızca ADIYLA tanınıyordu; bağlantısı kopup geri
 * geldiğinde sunucu onu yeni biri sanabiliyor (puanı 0'lanıyor) ya da aynı ismi
 * yazan bir başkasıyla aynı kayda düşebiliyordu. Artık her tarayıcı, isimden
 * bağımsız kalıcı bir kimlik taşıyor ve yeniden bağlanmada kendi kaydını —
 * puanı ve cevaplarıyla birlikte — geri alıyor.
 */
function getPlayerId(): string {
  try {
    let v = localStorage.getItem(PID_KEY);
    if (!v) {
      v = typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `p-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      localStorage.setItem(PID_KEY, v);
    }
    return v;
  } catch {
    return `p-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

function saveSession(pin: string, name: string) {
  try { sessionStorage.setItem(SESSION_KEY, JSON.stringify({ pin, name })); } catch { /* storage unavailable */ }
}
function loadSession(): { pin: string; name: string } | null {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}
function clearSession() {
  try { sessionStorage.removeItem(SESSION_KEY); } catch { /* storage unavailable */ }
}

export default function PlayerPage() {
  const [pin, setPin] = useState("");
  const [name, setName] = useState("");
  const [phase, setPhase] = useState<Phase>("join");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [question, setQuestion] = useState<Question | null>(null);
  const [qIdx, setQIdx] = useState(0);
  const [total, setTotal] = useState(0);
  const [selected, setSelected] = useState<number | null>(null);
  const [answerState, setAnswerState] = useState<"idle" | "pending" | "ok" | "failed">("idle");
  const [correctIndexes, setCorrectIndexes] = useState<number[]>([]);
  const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[]>([]);
  const [timeLeft, setTimeLeft] = useState(0);
  const [myScore, setMyScore] = useState(0);
  const [connected, setConnected] = useState(true);
  const [hostAway, setHostAway] = useState(false);
  const [personal, setPersonal] = useState<PersonalResult | null>(null);
  const [feedback, setFeedback] = useState<{ message: string; imageUrl: string | null }[]>([]);
  const [audioBlocked, setAudioBlocked] = useState(false);

  const socketRef = useRef<Socket | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const pidRef = useRef<string>(getPlayerId());
  // Olay dinleyicileri bir kez kurulduğu için güncel değerlere ref üzerinden
  // erişiyoruz (aksi halde "stale closure" ile eski PIN/isim gönderilir).
  const pinRef = useRef("");
  const nameRef = useRef("");
  const qIdxRef = useRef(0);
  const phaseRef = useRef<Phase>("join");
  const answerStateRef = useRef<"idle" | "pending" | "ok" | "failed">("idle");
  // Sunucu saatiyle yerel saat arasındaki fark ve sorunun sunucuya göre bitiş
  // anı. Geri sayım bunlardan hesaplanır.
  const skewRef = useRef(0);
  const endsAtRef = useRef(0);

  useEffect(() => { pinRef.current = pin; }, [pin]);
  useEffect(() => { nameRef.current = name; }, [name]);
  useEffect(() => { qIdxRef.current = qIdx; }, [qIdx]);
  useEffect(() => { phaseRef.current = phase; }, [phase]);
  useEffect(() => { answerStateRef.current = answerState; }, [answerState]);

  const emitJoin = useCallback((p: string, n: string) => {
    socketRef.current?.emit("join-session", {
      pin: p,
      name: n,
      pid: pidRef.current,
      avatar: { style: "avataaars", seed: n },
    });
  }, []);

  // `haveQIdx`: elimizdeki sorunun sırası. Sunucu bununla aynıysa soru gövdesini
  // tekrar göndermez — sesli sorularda 150-500KB'lık ses verisinin her
  // senkronizasyonda yeniden inmesini önler.
  const haveQIdxRef = useRef(-1);
  const requestSync = useCallback(() => {
    const p = pinRef.current;
    if (!p || !socketRef.current?.connected) return;
    socketRef.current.emit("sync-request", { pin: p, pid: pidRef.current, haveQIdx: haveQIdxRef.current });
  }, []);

  // ── Sunucu saatiyle çalışan geri sayım ────────────────────────────────────
  // Eskiden sayaç saf `setInterval` ile 1'er azalıyordu. Mobil tarayıcılar arka
  // plandaki sekmede setInterval'ı kıstığı (hatta durdurduğu) için sayaç
  // kayıyor, kişi kendi ekranında süre varken sunucuda süre bitmiş oluyordu.
  // Artık her tikte "sunucuya göre kalan süre" yeniden hesaplanıyor; sekme geri
  // geldiğinde sayaç kendini anında düzeltiyor.
  useEffect(() => {
    const id = setInterval(() => {
      if (!endsAtRef.current) return;
      const remaining = Math.max(0, Math.ceil((endsAtRef.current - (Date.now() + skewRef.current)) / 1000));
      setTimeLeft((prev) => (prev === remaining ? prev : remaining));
    }, 250);
    return () => clearInterval(id);
  }, []);

  const applyClock = useCallback((d: { serverNow?: number; qEndsAt?: number; timeLeft?: number }) => {
    if (typeof d.serverNow === "number") skewRef.current = d.serverNow - Date.now();
    if (typeof d.qEndsAt === "number" && d.qEndsAt > 0) {
      endsAtRef.current = d.qEndsAt;
      setTimeLeft(Math.max(0, Math.ceil((d.qEndsAt - (Date.now() + skewRef.current)) / 1000)));
    } else if (typeof d.timeLeft === "number") {
      endsAtRef.current = Date.now() + skewRef.current + d.timeLeft * 1000;
      setTimeLeft(d.timeLeft);
    }
  }, []);

  const playAudio = useCallback((auto: boolean) => {
    const el = audioRef.current;
    if (!el || !el.getAttribute("src")) return;
    try { el.currentTime = 0; } catch { /* henüz yüklenmemiş olabilir */ }
    const p = el.play();
    if (p && typeof p.catch === "function") {
      p.then(() => setAudioBlocked(false)).catch(() => {
        // Mobil tarayıcılar kullanıcı etkileşimi olmadan sesi engelleyebilir.
        // ÖNEMLİ: bu durumda bile soru metni ve şıklar ekranda kalır; sadece
        // "Sesi çal" düğmesi gösterilir.
        if (auto) setAudioBlocked(true);
      });
    }
  }, []);

  const applyQuestion = useCallback((q: Question | null, idx: number, tot: number) => {
    setQuestion(q);
    haveQIdxRef.current = q ? idx : -1;
    setQIdx(idx);
    if (tot) setTotal(tot);
    setSelected(null);
    setAnswerState("idle");
    setCorrectIndexes([]);
    setAudioBlocked(false);
    setPhase("question");
    if (q?.questionType === "voice" && q.audioData) {
      // Ses ayrı bir katman: yüklenmesi/çalması SORUNUN GÖRÜNMESİNİ engellemez.
      window.setTimeout(() => { if (q.audioAutoplay !== false) playAudio(true); }, 60);
    }
  }, [playAudio]);

  /** Sunucudan gelen otoriter durumu ekrana uygular (rejoin + sync ortak yolu). */
  const applyServerState = useCallback((d: Record<string, unknown>) => {
    const st = d as unknown as {
      pin: string; name?: string; phase: Phase; qIdx: number; total: number; score?: number;
      question?: Question | null; selected?: number | null; correctIndexes?: number[];
      leaderboard?: LeaderboardEntry[]; timeLeft?: number; serverNow?: number; qEndsAt?: number;
    };
    // Not: qIdxRef bir sonraki render'da güncellendiği için, "aynı soruda
    // mıyız?" karşılaştırmasını daha en baştan yakalıyoruz.
    const prevQIdx = qIdxRef.current;
    if (st.pin) { setPin(st.pin); pinRef.current = st.pin; }
    if (st.name) { setName(st.name); nameRef.current = st.name; saveSession(st.pin, st.name); }
    if (typeof st.score === "number") setMyScore(st.score);
    if (typeof st.total === "number") setTotal(st.total);
    if (typeof st.qIdx === "number") setQIdx(st.qIdx);
    applyClock(st);
    setError("");

    if (st.question !== undefined && st.question !== null) {
      setQuestion(st.question);
      haveQIdxRef.current = st.qIdx;
    }
    if (st.selected !== undefined) {
      // Yolda olan bir cevabı ezme: senkronizasyon yanıtı, biz cevabı
      // göndermeden ÖNCE hazırlanmış olabilir. Böyle bir durumda seçimi
      // sıfırlamak, kişinin ikinci kez dokunmasına yol açardı.
      const sameQuestion = st.qIdx === prevQIdx;
      const answerInFlight = sameQuestion &&
        (answerStateRef.current === "pending" || answerStateRef.current === "ok");
      if (st.selected !== null) {
        setSelected(st.selected);
        setAnswerState("ok");
      } else if (!answerInFlight) {
        setSelected(null);
        setAnswerState("idle");
      }
    }
    setCorrectIndexes(st.correctIndexes || []);
    if (st.leaderboard) setLeaderboard(st.leaderboard);
    if (st.phase) setPhase(st.phase);
  }, [applyClock]);

  useEffect(() => {
    const socket = io(API_ORIGIN, {
      path: `${BASE}/api/socket.io`,
      transports: ["websocket", "polling"],
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 500,
      reconnectionDelayMax: 3000,
      timeout: 10000,
    });
    socketRef.current = socket;

    socket.on("connect", () => {
      setConnected(true);
      const saved = loadSession();
      if (saved) {
        setPin(saved.pin); pinRef.current = saved.pin;
        setName(saved.name); nameRef.current = saved.name;
        // Kimliğimizle birlikte katıl: sunucu bizi eski kaydımıza bağlar.
        emitJoin(saved.pin, saved.name);
      }
    });

    socket.on("disconnect", () => setConnected(false));
    socket.io.on("reconnect", () => { setConnected(true); requestSync(); });

    socket.on("join-success", (d: { pin: string; name: string }) => {
      saveSession(d.pin, d.name);
      setName(d.name); nameRef.current = d.name;
      setPhase("lobby");
      setError("");
    });

    socket.on("join-error", (d: { message: string }) => {
      clearSession();
      setError(d.message);
      setPhase("join");
    });

    // Yeniden bağlanma / durum senkronizasyonu — ikisi de aynı otoriter durumu taşır.
    socket.on("rejoin-player-success", applyServerState);
    socket.on("state-sync", applyServerState);

    // Sunucu bizi tanımıyor (ör. eski bir kayıt düşmüş): kendimizi yeniden kaydet.
    socket.on("resync-required", () => {
      if (pinRef.current && nameRef.current) emitJoin(pinRef.current, nameRef.current);
    });

    socket.on("game-started", (d: { qIdx: number; question: Question; total: number; serverNow?: number; qEndsAt?: number }) => {
      applyQuestion(d.question, d.qIdx, d.total);
      applyClock(d);
    });

    socket.on("question-shown", (d: { qIdx: number; question: Question; total: number; serverNow?: number; qEndsAt?: number }) => {
      applyQuestion(d.question, d.qIdx, d.total);
      applyClock(d);
    });

    socket.on("timer-sync", (d: { qIdx: number; serverNow: number; qEndsAt: number }) => {
      if (d.qIdx === qIdxRef.current) applyClock(d);
    });

    // Sesli soruda host "şimdi çal" dediğinde
    socket.on("voice-playback-triggered", () => playAudio(false));

    // Cevap muhasebesi: artık sunucudan ONAY bekliyoruz. Eskiden ekranda
    // "Cevabın kaydedildi!" yazıyordu ama sunucu cevabı reddetmiş olabiliyordu —
    // kişi doğru cevap verdiğini sanıp 0 puan alıyordu.
    socket.on("answer-recorded", (d: { qIdx: number; choice: number }) => {
      if (d.qIdx !== qIdxRef.current) return;
      setSelected(d.choice);
      setAnswerState("ok");
    });

    socket.on("answer-rejected", (d: { qIdx: number; reason: string }) => {
      if (d.qIdx !== qIdxRef.current) return;
      if (d.reason === "closed" || d.reason === "wrong-question") {
        setAnswerState("failed");
        setNotice("Cevabın süre dolduktan sonra ulaştı, sayılmadı.");
      } else {
        // Yeniden denenebilir bir red: seçimi geri aç.
        setAnswerState("idle");
        setSelected(null);
        setNotice("Cevabın gönderilemedi, tekrar dokun.");
      }
      window.setTimeout(() => setNotice(""), 4000);
    });

    socket.on("answer-revealed", (d: { qIdx: number; correctIndexes: number[]; playerScores: Record<string, number> }) => {
      setCorrectIndexes(d.correctIndexes);
      setPhase("reveal");
      endsAtRef.current = 0;
      const mine = d.playerScores?.[nameRef.current];
      if (typeof mine === "number") setMyScore(mine);
    });

    socket.on("leaderboard-shown", (d: { leaderboard: LeaderboardEntry[] }) => {
      setLeaderboard(d.leaderboard);
      setPhase("leaderboard");
      endsAtRef.current = 0;
    });

    socket.on("game-ended", (d: { leaderboard: LeaderboardEntry[] }) => {
      setLeaderboard(d.leaderboard);
      setPhase("end");
      endsAtRef.current = 0;
    });

    socket.on("personal-result", (d: PersonalResult) => setPersonal(d));
    socket.on("feedback-shown", (d: { items: { message: string; imageUrl: string | null }[] }) => setFeedback(d.items || []));

    // Host'un bağlantısı koptu — ekranı hemen sıfırlamıyoruz, uyarı gösterip
    // geri dönmesini bekliyoruz (eskiden anında giriş ekranına atılıyordu).
    socket.on("host-reconnecting", () => setHostAway(true));
    socket.on("host-reconnected", () => { setHostAway(false); requestSync(); });

    socket.on("game-stopped", (d: { message: string }) => {
      setError(d.message);
      setPhase("join");
      clearSession();
    });

    socket.on("host-disconnected", () => {
      setError("Oturum yöneticisi bağlantıyı kesti.");
      setPhase("join");
      clearSession();
    });

    // ── İKİNCİ HATANIN PANZEHİRİ ─────────────────────────────────────────────
    // Bir yayın kaybolduğunda (soket "bağlı" görünürken paketlerin ulaşmaması)
    // ekran donuyor ve ancak bir sonraki yayında düzeliyordu. Artık:
    //  • sekmeye geri dönüldüğünde,
    //  • ağ geri geldiğinde,
    //  • ve düzenli aralıklarla
    // sunucuya "şu an ne olmalıyım?" diye soruyoruz.
    const onVisible = () => { if (document.visibilityState === "visible") requestSync(); };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    window.addEventListener("online", onVisible);
    const heartbeat = setInterval(() => {
      if (phaseRef.current === "join") return;
      requestSync();
    }, 8000);

    return () => {
      clearInterval(heartbeat);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
      window.removeEventListener("online", onVisible);
      socket.disconnect();
    };
  }, [applyServerState, applyQuestion, applyClock, emitJoin, requestSync, playAudio]);

  // Soru fazındayız ama elimizde soru yok → yayını kaçırmışız. Ekranı boş
  // bırakmak yerine ısrarla senkronizasyon iste.
  useEffect(() => {
    if (phase !== "question" || question) return;
    haveQIdxRef.current = -1; // soru elimizde yok: sunucu tam gövdeyi göndersin
    requestSync();
    const id = setInterval(requestSync, 2000);
    return () => clearInterval(id);
  }, [phase, question, requestSync]);

  function joinGame() {
    setError("");
    if (!pin.trim() || !name.trim()) {
      setError("PIN ve isim zorunludur.");
      return;
    }
    pinRef.current = pin.trim();
    nameRef.current = name.trim();
    emitJoin(pin.trim(), name.trim());
  }

  function submitAnswer(choice: number) {
    if (selected !== null || answerState === "pending") return;
    setSelected(choice);
    setAnswerState("pending");
    const send = () => socketRef.current?.emit("submit-answer", {
      pin: pinRef.current, name: nameRef.current, pid: pidRef.current, qIdx: qIdxRef.current, choice,
    });
    send();
    // Onay gelmezse bir kez daha dene (sunucuda mükerrer cevap zaten güvenli).
    window.setTimeout(() => { if (answerStateRef.current === "pending") send(); }, 1200);
    window.setTimeout(() => { if (answerStateRef.current === "pending") requestSync(); }, 3000);
  }

  const statusBar = (
    <div className="flex flex-wrap items-center justify-center gap-2 min-h-[24px]">
      {!connected && <Badge variant="destructive" className="animate-pulse">Bağlantı yeniden kuruluyor…</Badge>}
      {connected && hostAway && <Badge variant="secondary">Sunum bilgisayarı yeniden bağlanıyor…</Badge>}
      {notice && <Badge variant="secondary">{notice}</Badge>}
    </div>
  );

  if (phase === "join") {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-violet-600 to-indigo-700 p-4">
        <Card className="w-full max-w-sm shadow-2xl">
          <CardHeader className="text-center">
            <div className="text-5xl mb-2">🎯</div>
            <CardTitle className="text-xl">Oyuna Katıl</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <Input placeholder="Oyun PIN'i" value={pin} onChange={e => setPin(e.target.value)} maxLength={6} inputMode="numeric" />
            <Input placeholder="Adınız" value={name} onChange={e => setName(e.target.value)} maxLength={30} />
            {error && <p className="text-sm text-red-500">{error}</p>}
            <Button className="w-full" onClick={joinGame}>Katıl</Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (phase === "lobby") {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-violet-600 to-indigo-700 p-4">
        <div className="text-center text-white space-y-4">
          <div className="text-6xl">⏳</div>
          <h2 className="text-2xl font-bold">Oyun başlaması bekleniyor...</h2>
          <p className="text-violet-200">Hoş geldin, <span className="font-bold">{name}</span>!</p>
          {statusBar}
        </div>
      </div>
    );
  }

  // ── SORU EKRANI ───────────────────────────────────────────────────────────
  // ÖNEMLİ: Eskiden bu blok `phase === "question" && question` koşuluna bağlıydı
  // ve soru bir şekilde gelmediyse bileşen `null` döndürüyordu — yani ekran
  // TAMAMEN BOŞ kalıyordu (2. hatadaki tablo). Artık soru yoksa bile bir
  // "yükleniyor" ekranı gösteriliyor ve arka planda sunucudan durum isteniyor.
  if (phase === "question") {
    if (!question) {
      return (
        <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-violet-600 to-indigo-700 p-4">
          <div className="text-center text-white space-y-3">
            <div className="text-5xl animate-pulse">⏳</div>
            <p className="font-semibold">Soru yükleniyor…</p>
            <p className="text-violet-200 text-sm">Bağlantı yenileniyor, birkaç saniye içinde açılacak.</p>
            <Button variant="secondary" onClick={requestSync}>Şimdi yenile</Button>
            {statusBar}
          </div>
        </div>
      );
    }

    const isVoice = question.questionType === "voice" && !!question.audioData;
    return (
      <div className="min-h-screen bg-gradient-to-br from-violet-600 to-indigo-700 p-4 flex flex-col">
        {isVoice && (
          <audio ref={audioRef} src={question.audioData || undefined} preload="auto" playsInline className="hidden" />
        )}
        <div className="flex justify-between items-center text-white mb-3">
          <Badge variant="secondary">Soru {qIdx + 1}/{total}</Badge>
          <div className={`text-2xl font-bold ${timeLeft <= 5 ? "text-red-300 animate-pulse" : ""}`}>
            ⏱ {timeLeft}s
          </div>
        </div>
        {statusBar}
        <Card className="mb-3 mt-1">
          <CardContent className="pt-6 text-center space-y-3">
            {isVoice && (
              <div className="flex flex-col items-center gap-2">
                <div className="text-3xl">🔊</div>
                <Button size="sm" variant={audioBlocked ? "default" : "outline"} onClick={() => playAudio(false)}>
                  {audioBlocked ? "Sesi çal" : "Sesi tekrar çal"}
                </Button>
                {audioBlocked && (
                  <p className="text-xs text-muted-foreground">Tarayıcı sesi otomatik başlatmadı — düğmeye dokunun.</p>
                )}
              </div>
            )}
            {/* Soru metni ve şıklar, sesin durumundan BAĞIMSIZ olarak her zaman
                render edilir. 2. hatanın çekirdeği tam olarak buydu. */}
            <p className="text-xl font-bold">{question.text}</p>
          </CardContent>
        </Card>
        <div className="grid grid-cols-2 gap-3 flex-1">
          {(question.answers || []).map((ans, i) => (
            <button
              key={i}
              onClick={() => submitAnswer(i)}
              disabled={selected !== null}
              className={`${COLORS[i]} rounded-xl p-4 text-white text-lg font-semibold flex flex-col items-center justify-center gap-2 transition-all ${
                selected === i ? "ring-4 ring-white ring-offset-2 scale-95" : "hover:brightness-110 active:scale-95"
              } ${selected !== null && selected !== i ? "opacity-50" : ""}`}
            >
              <span className="text-2xl">{SHAPES[i]}</span>
              <span className="text-sm text-center leading-tight">{ans.text}</span>
            </button>
          ))}
        </div>
        {answerState === "pending" && <p className="text-center text-white mt-4 font-semibold">Gönderiliyor…</p>}
        {answerState === "ok" && <p className="text-center text-white mt-4 font-semibold">✓ Cevabın kaydedildi! Sonuç bekleniyor...</p>}
        {answerState === "failed" && <p className="text-center text-yellow-200 mt-4 font-semibold">Cevabın kaydedilemedi.</p>}
      </div>
    );
  }

  if (phase === "reveal") {
    return (
      <div className="min-h-screen bg-gradient-to-br from-violet-600 to-indigo-700 p-4 flex flex-col">
        <div className="text-white text-center mb-4">
          <p className="text-lg font-semibold">Sonuçlar</p>
          {statusBar}
        </div>
        <div className="grid grid-cols-2 gap-3">
          {(question?.answers || []).map((ans, i) => (
            <div
              key={i}
              className={`${COLORS[i]} rounded-xl p-4 text-white flex flex-col items-center justify-center gap-2 ${
                correctIndexes.includes(i) ? "ring-4 ring-white" : "opacity-40"
              }`}
            >
              <span className="text-2xl">{correctIndexes.includes(i) ? "✓" : SHAPES[i]}</span>
              <span className="text-sm text-center">{ans.text}</span>
            </div>
          ))}
        </div>
        {selected !== null && (
          <div className="text-center text-white mt-6">
            {answerState === "failed"
              ? <p className="text-xl">⚠️ Cevabın sunucuya ulaşmadı, bu soru boş sayıldı.</p>
              : correctIndexes.includes(selected)
                ? <p className="text-2xl">✅ Doğru!</p>
                : <p className="text-2xl">❌ Yanlış!</p>}
          </div>
        )}
        {selected === null && <p className="text-center text-white mt-6 text-lg">⏳ Cevap vermedin.</p>}
      </div>
    );
  }

  if (phase === "leaderboard" || phase === "end") {
    const myEntry = leaderboard.find((e) => e.pid === pidRef.current) || leaderboard.find((e) => e.name === name);
    return (
      <div className="min-h-screen bg-gradient-to-br from-violet-600 to-indigo-700 p-4">
        <div className="text-center text-white mb-6">
          <div className="text-4xl mb-2">{phase === "end" ? "🏆" : "📊"}</div>
          <h2 className="text-2xl font-bold">{phase === "end" ? "Oyun Bitti!" : "Sıralama"}</h2>
          {myEntry
            ? <p className="text-violet-200 mt-1">Sıralamanız: #{myEntry.rank} · {myEntry.score} puan</p>
            : <p className="text-violet-200 mt-1">Puanınız: {myScore}</p>}
          {statusBar}
        </div>

        {phase === "end" && personal && (
          <Card className="max-w-md mx-auto mb-4">
            <CardContent className="pt-6 text-center">
              <p className="font-semibold mb-2">
                {personal.rank ? `${personal.totalPlayers} kişi arasında ${personal.rank}. sıradasın` : "Sonucun"}
              </p>
              <div className="flex justify-center gap-4 text-sm">
                <span className="text-green-600 font-bold">✓ {personal.correct} doğru</span>
                <span className="text-red-600 font-bold">✗ {personal.wrong} yanlış</span>
                <span className="text-gray-500 font-bold">– {personal.blank} boş</span>
              </div>
              <p className="mt-2 font-mono text-lg">{personal.score} puan</p>
            </CardContent>
          </Card>
        )}

        {phase === "end" && feedback.length > 0 && (
          <div className="max-w-md mx-auto mb-4 space-y-3">
            {feedback.map((f, i) => (
              <Card key={i}>
                <CardContent className="pt-6 space-y-2">
                  <p className="text-sm">{f.message}</p>
                  {f.imageUrl && <img src={f.imageUrl} alt="" className="rounded-lg w-full" />}
                </CardContent>
              </Card>
            ))}
          </div>
        )}

        <div className="space-y-2 max-w-md mx-auto">
          {leaderboard.slice(0, 10).map((e) => (
            <div
              key={e.pid || e.name}
              className={`flex items-center gap-3 rounded-xl p-3 ${
                (e.pid && e.pid === pidRef.current) || e.name === name ? "bg-white text-violet-700 font-bold" : "bg-white/20 text-white"
              }`}
            >
              <span className="text-lg w-8 text-center">{e.rank <= 3 ? ["🥇","🥈","🥉"][e.rank-1] : `#${e.rank}`}</span>
              <span className="flex-1">{e.name}</span>
              <span className="font-mono">{e.score}</span>
            </div>
          ))}
        </div>

        {phase === "end" && (
          <div className="text-center mt-6">
            <Button
              variant="secondary"
              onClick={() => { clearSession(); setPhase("join"); setPersonal(null); setFeedback([]); setLeaderboard([]); }}
            >
              Yeni oyuna katıl
            </Button>
          </div>
        )}
      </div>
    );
  }

  return null;
}
