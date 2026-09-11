import { useState, useEffect, useRef, useCallback } from "react";
import { io, type Socket } from "socket.io-client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/context/AuthContext";
import type { QuestionSet } from "@/lib/api";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");
const API_ORIGIN = window.location.origin;
const HOST_TOKEN_KEY = "quiz-host-token";

interface Player {
  pid?: string;
  name: string;
  score: number;
  connected?: boolean;
  avatar: { style: string; seed: string };
}

interface AnswerCount {
  [key: number]: number;
}

type Phase = "setup" | "lobby" | "question" | "reveal" | "leaderboard" | "end";

interface LeaderboardEntry {
  rank: number;
  name: string;
  score: number;
  pid?: string;
}

const COLORS = ["bg-red-500", "bg-blue-500", "bg-yellow-500", "bg-green-500"];
const LABELS = ["A", "B", "C", "D"];

/**
 * HOST'UN KALICI KİMLİĞİ.
 * Bağlantı koptuğunda socket.io yeni bir soketle otomatik geri döner. Eskiden
 * istemci bu durumda `create-session`'ı tekrar gönderiyor ve sunucu bunu YENİ
 * BİR OTURUM sanıyordu: ya PIN değişiyor ya da aynı PIN'de SIFIR oyunculu bir
 * oturum kuruluyordu — lobide sayının bir anda 0'a düşmesinin nedeni buydu.
 * Bu token sayesinde sunucu "bu, aynı host'un geri dönüşü" diyebiliyor.
 */
function getHostToken(): string {
  try {
    let v = localStorage.getItem(HOST_TOKEN_KEY);
    if (!v) {
      v = typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `h-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      localStorage.setItem(HOST_TOKEN_KEY, v);
    }
    return v;
  } catch {
    return `h-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

export default function HostGame({ questionSets }: { questionSets: QuestionSet[] }) {
  const { user } = useAuth();
  const [selectedSetId, setSelectedSetId] = useState<string>("");
  const [pin, setPin] = useState("");
  const [phase, setPhase] = useState<Phase>("setup");
  const [players, setPlayers] = useState<Player[]>([]);
  const [qIdx, setQIdx] = useState(0);
  const [total, setTotal] = useState(0);
  const [currentQ, setCurrentQ] = useState<{
    text: string; time: number; answers: { text: string }[];
    questionType?: string; audioData?: string | null; audioAutoplay?: boolean;
  } | null>(null);
  const [answerCounts, setAnswerCounts] = useState<AnswerCount>({});
  const [answeredCount, setAnsweredCount] = useState(0);
  const [correctIndexes, setCorrectIndexes] = useState<number[]>([]);
  const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[]>([]);
  const [isLast, setIsLast] = useState(false);
  const [timeLeft, setTimeLeft] = useState(0);
  const [allAnswered, setAllAnswered] = useState(false);
  const [connected, setConnected] = useState(true);

  const socketRef = useRef<Socket | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const hostTokenRef = useRef<string>(getHostToken());
  const pinRef = useRef("");
  const qIdxRef = useRef(0);
  const setRef = useRef<QuestionSet | null>(null);
  const endsAtRef = useRef(0);
  const skewRef = useRef(0);

  const selectedSet = questionSets.find(s => String(s.id) === selectedSetId);
  useEffect(() => { setRef.current = selectedSet || null; }, [selectedSet]);
  useEffect(() => { pinRef.current = pin; }, [pin]);
  useEffect(() => { qIdxRef.current = qIdx; }, [qIdx]);

  useEffect(() => {
    return () => {
      socketRef.current?.disconnect();
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, []);

  // Sunucu saatiyle senkron geri sayım (mobil/arka plan kısıtlamalarına dayanıklı).
  useEffect(() => {
    const id = setInterval(() => {
      if (!endsAtRef.current) return;
      const remaining = Math.max(0, Math.ceil((endsAtRef.current - (Date.now() + skewRef.current)) / 1000));
      setTimeLeft(prev => (prev === remaining ? prev : remaining));
    }, 250);
    return () => clearInterval(id);
  }, []);

  const applyClock = useCallback((d: { serverNow?: number; qEndsAt?: number; timeLeft?: number }) => {
    if (typeof d.serverNow === "number") skewRef.current = d.serverNow - Date.now();
    if (typeof d.qEndsAt === "number" && d.qEndsAt > 0) {
      endsAtRef.current = d.qEndsAt;
      setTimeLeft(Math.max(0, Math.ceil((d.qEndsAt - (Date.now() + skewRef.current)) / 1000)));
    }
  }, []);

  function generatePin() {
    return String(Math.floor(100000 + Math.random() * 900000));
  }

  function questionView(idx: number) {
    const q = setRef.current?.questions?.[idx];
    if (!q) return null;
    return {
      text: String(q.text),
      time: Number(q.time) || 20,
      answers: (q.answers || []).map(a => ({ text: a.text })),
      questionType: q.questionType,
      audioData: q.audioData ?? null,
      audioAutoplay: q.audioAutoplay,
    };
  }

  function playHostAudio() {
    const el = audioRef.current;
    if (!el || !el.getAttribute("src")) return;
    try { el.currentTime = 0; } catch { /* yüklenmemiş olabilir */ }
    void el.play()?.catch(() => { /* tarayıcı engelledi — düğmeyle çalınabilir */ });
  }

  function startSession() {
    if (!selectedSet) return;

    const newPin = generatePin();
    setPin(newPin); pinRef.current = newPin;
    setPhase("lobby");
    setPlayers([]);
    setQIdx(0);
    setAnsweredCount(0);
    setAllAnswered(false);

    const socket = io(API_ORIGIN, {
      path: `${BASE}/api/socket.io`,
      transports: ["websocket", "polling"],
      // Host yetkisi soket katmanında da doğrulanıyor: giriş sırasında alınan
      // imzalı token el sıkışmada gönderiliyor. Katılımcı tarafı token
      // göndermez — onlar yalnızca PIN ile katılır.
      auth: { token: user?.token },
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 500,
      reconnectionDelayMax: 3000,
    });
    socketRef.current = socket;

    socket.on("connect", () => {
      setConnected(true);
      // Aynı hostToken ile gönderilen create-session, sunucuda "yeniden
      // bağlanma" olarak işleniyor: PIN korunur, katılımcı listesi korunur.
      socket.emit("create-session", {
        pin: pinRef.current || newPin,
        questions: setRef.current?.questions ?? selectedSet.questions,
        title: setRef.current?.name ?? selectedSet.name,
        category: setRef.current?.category ?? selectedSet.category ?? null,
        // hostSicil artık gönderilmiyor — sunucu bunu token'dan okuyor.
        hostToken: hostTokenRef.current,
      });
    });

    socket.on("disconnect", () => setConnected(false));

    socket.on("session-error", (d: { message: string }) => {
      setConnected(true);
      alert(d?.message || "Oturum oluşturulamadı. Lütfen çıkış yapıp tekrar giriş yapın.");
      resetGame();
    });

    // Sunucu son sözü söyler: gerçekte kullanılan PIN buradan gelir.
    socket.on("session-created", (d: { pin: string; resumed?: boolean }) => {
      if (d?.pin) { setPin(d.pin); pinRef.current = d.pin; }
    });

    // Yeniden bağlanma sonrası otoriter durum: faz, soru, katılımcılar, sayaç.
    const applyHostState = (d: {
      pin: string; qIdx: number; phase: string; total: number;
      players: Player[]; answeredCount: number; answerCounts: AnswerCount;
      leaderboard: LeaderboardEntry[]; correctIndexes: number[];
      serverNow?: number; qEndsAt?: number;
    }) => {
      if (!d) return;
      if (d.pin) { setPin(d.pin); pinRef.current = d.pin; }
      setPlayers([...(d.players || [])]);
      setQIdx(d.qIdx); qIdxRef.current = d.qIdx;
      if (d.total) setTotal(d.total);
      setAnsweredCount(d.answeredCount || 0);
      setAnswerCounts({ ...(d.answerCounts || {}) });
      setLeaderboard(d.leaderboard || []);
      setCorrectIndexes(d.correctIndexes || []);
      setCurrentQ(questionView(d.qIdx));
      setIsLast(d.qIdx >= ((setRef.current?.questions.length ?? 1) - 1));
      applyClock(d);
      setPhase(d.phase === "end" ? "end" : (d.phase as Phase));
      setConnected(true);
    };
    socket.on("session-rejoined", applyHostState);
    socket.on("state-sync", applyHostState);

    // TEK KAYNAK: katılımcı listesi yalnızca buradan gelir. Eskiden liste üç
    // ayrı olaydan besleniyor ve geç gelen bir güncelleme yenisini eziyordu.
    socket.on("players-updated", (d: { players: Player[] }) => setPlayers([...(d.players || [])]));
    // Eski olay adları da destekleniyor (sunucu ikisini de yolluyor).
    socket.on("player-joined", (d: { players: Player[] }) => { if (d?.players) setPlayers([...d.players]); });
    socket.on("player-left", (d: { players: Player[] }) => { if (d?.players) setPlayers([...d.players]); });

    socket.on("player-answered", (d: { answeredCount: number; answerCounts: AnswerCount }) => {
      setAnsweredCount(d.answeredCount);
      setAnswerCounts({ ...d.answerCounts });
    });

    socket.on("all-answered", () => setAllAnswered(true));

    socket.on("leaderboard-shown", (d: { leaderboard: LeaderboardEntry[] }) => setLeaderboard(d.leaderboard));
    socket.on("game-ended", (d: { leaderboard: LeaderboardEntry[] }) => setLeaderboard(d.leaderboard));

    socket.on("question-shown", (d: { qIdx: number; serverNow?: number; qEndsAt?: number }) => applyClock(d));
    socket.on("game-started", (d: { serverNow?: number; qEndsAt?: number }) => applyClock(d));
    socket.on("timer-sync", (d: { qIdx: number; serverNow?: number; qEndsAt?: number }) => applyClock(d));

    // Bağlantı geri geldiğinde durumu tazele.
    socket.io.on("reconnect", () => {
      setConnected(true);
      if (pinRef.current) socket.emit("sync-request", { pin: pinRef.current });
    });
  }

  /** Soruyu ekrana koyar, sunucu saatini bu ana göre kurar ve sesli soruyu çalar. */
  function presentQuestion(idx: number) {
    const view = questionView(idx);
    setCurrentQ(view);
    setQIdx(idx); qIdxRef.current = idx;
    setAnsweredCount(0);
    setAnswerCounts({});
    setAllAnswered(false);
    setCorrectIndexes([]);
    setPhase("question");
    // Sunucudaki geri sayım tam da ekranın açıldığı andan başlasın.
    socketRef.current?.emit("question-timer-started", { pin: pinRef.current, qIdx: idx });
    if (view?.questionType === "voice" && view.audioData && view.audioAutoplay !== false) {
      window.setTimeout(() => playHostAudio(), 80);
    }
  }

  function startGame() {
    if (!selectedSet) return;
    socketRef.current?.emit("start-game", { pin: pinRef.current });
    setTotal(selectedSet.questions.length);
    presentQuestion(0);
  }

  function revealAnswer() {
    endsAtRef.current = 0;
    socketRef.current?.emit("reveal-answer", { pin: pinRef.current, qIdx: qIdxRef.current });
    setPhase("reveal");
    const q = setRef.current?.questions[qIdxRef.current];
    setCorrectIndexes((q?.answers || []).map((a, i) => (a.correct ? i : -1)).filter(i => i !== -1));
  }

  function showLeaderboard() {
    socketRef.current?.emit("show-leaderboard", { pin: pinRef.current });
    setPhase("leaderboard");
    setIsLast(qIdxRef.current >= ((setRef.current?.questions.length ?? 1) - 1));
  }

  function nextQuestion() {
    const nextIdx = qIdxRef.current + 1;
    // qIdx'i açıkça gönderiyoruz: yeniden bağlanma sonrası oluşabilecek
    // "fazladan next" durumunda soruların atlanmasını engeller.
    socketRef.current?.emit("next-question", { pin: pinRef.current, qIdx: nextIdx });
    presentQuestion(nextIdx);
  }

  function endGame() {
    socketRef.current?.emit("end-game", { pin: pinRef.current });
    setPhase("end");
    endsAtRef.current = 0;
  }

  function resetGame() {
    // Oyun BİTTİYSE oturumu iptal etmiyoruz: sunucu onu kısa bir süre daha
    // saklıyor ki geç bağlanan katılımcılar kendi sonuçlarını görebilsin.
    // Yarıda bırakılan bir oturumsa iptal edip sunucudan düşürüyoruz.
    if (phase !== "end") socketRef.current?.emit("host-cancel", { pin: pinRef.current });
    socketRef.current?.disconnect();
    socketRef.current = null;
    setPhase("setup");
    setPlayers([]);
    setPin(""); pinRef.current = "";
    setLeaderboard([]);
    endsAtRef.current = 0;
  }

  const onlineCount = players.filter(p => p.connected !== false).length;
  const connBadge = !connected && (
    <Badge variant="destructive" className="animate-pulse">Bağlantı yeniden kuruluyor…</Badge>
  );
  const voiceControls = currentQ?.questionType === "voice" && currentQ.audioData ? (
    <div className="flex items-center gap-2">
      <audio ref={audioRef} src={currentQ.audioData} preload="auto" className="hidden" />
      <Button size="sm" variant="outline" onClick={() => { playHostAudio(); socketRef.current?.emit("trigger-voice-play", { pin: pinRef.current }); }}>
        🔊 Sesi çal
      </Button>
    </div>
  ) : null;

  if (phase === "setup") {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Oyun Başlat</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {questionSets.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-4">Henüz soru seti yok. Önce soru seti yükleyin.</p>
          ) : (
            <>
              <div className="space-y-1">
                <Label>Soru Seti Seç</Label>
                <Select value={selectedSetId} onValueChange={setSelectedSetId}>
                  <SelectTrigger>
                    <SelectValue placeholder="Soru seti seçin..." />
                  </SelectTrigger>
                  <SelectContent>
                    {questionSets.map(s => (
                      <SelectItem key={s.id} value={String(s.id)}>
                        {s.name} ({s.questions.length} soru)
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <Button className="w-full" disabled={!selectedSetId} onClick={startSession}>
                Oturum Oluştur
              </Button>
            </>
          )}
        </CardContent>
      </Card>
    );
  }

  if (phase === "lobby") {
    return (
      <Card>
        <CardHeader>
          <div className="flex justify-between items-center">
            <CardTitle className="text-base">Bekleme Odası</CardTitle>
            <div className="flex items-center gap-2">{connBadge}<Button variant="outline" size="sm" onClick={resetGame}>Vazgeç</Button></div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="text-center p-6 bg-violet-50 rounded-xl border-2 border-violet-200">
            <p className="text-sm text-muted-foreground mb-1">Oyun PIN'i</p>
            <p className="text-5xl font-bold tracking-widest text-violet-700">{pin}</p>
            <p className="text-xs text-muted-foreground mt-2">Oyuncular bu PIN ile katılabilir</p>
          </div>
          <div>
            <p className="text-sm font-medium mb-2">
              Katılımcılar ({players.length})
              {onlineCount !== players.length && (
                <span className="text-muted-foreground font-normal"> · {players.length - onlineCount} kişi geçici olarak çevrimdışı</span>
              )}
            </p>
            <div className="grid grid-cols-2 gap-2">
              {players.map(p => (
                <div key={p.pid || p.name} className={`flex items-center gap-2 p-2 rounded-lg border text-sm ${p.connected === false ? "bg-gray-100 opacity-60" : "bg-gray-50"}`}>
                  <span>{p.connected === false ? "🔌" : "👤"}</span>
                  <span className="truncate">{p.name}</span>
                </div>
              ))}
              {players.length === 0 && (
                <p className="col-span-2 text-sm text-muted-foreground text-center py-4">Oyuncular bekleniyor...</p>
              )}
            </div>
            {/* Çevrimdışı görünenler oyundan ATILMAZ; kayıtları, puanları ve
                rapordaki satırları korunur, bağlantı gelince kaldıkları yerden
                devam ederler. */}
          </div>
          <Button className="w-full" disabled={players.length === 0} onClick={startGame}>
            Oyunu Başlat ({players.length} oyuncu)
          </Button>
        </CardContent>
      </Card>
    );
  }

  if (phase === "question" && currentQ) {
    return (
      <Card>
        <CardHeader>
          <div className="flex justify-between items-center">
            <CardTitle className="text-base">Soru {qIdx + 1} / {total}</CardTitle>
            <div className="flex items-center gap-2">
              {connBadge}
              <Badge variant="secondary">{answeredCount}/{onlineCount} cevapladı</Badge>
              <div className={`text-lg font-bold ${timeLeft <= 5 ? "text-red-500 animate-pulse" : "text-gray-700"}`}>
                ⏱ {timeLeft}s
              </div>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="p-4 bg-gray-50 rounded-xl text-center space-y-2">
            {voiceControls && <div className="flex justify-center">{voiceControls}</div>}
            <p className="text-xl font-bold">{currentQ.text}</p>
          </div>
          <div className="grid grid-cols-2 gap-2">
            {currentQ.answers.map((ans, i) => (
              <div key={i} className={`${COLORS[i]} text-white rounded-xl p-3 flex items-center gap-2`}>
                <span className="font-bold text-lg w-6">{LABELS[i]}</span>
                <span className="text-sm">{ans.text}</span>
                <span className="ml-auto font-bold">{answerCounts[i] || 0}</span>
              </div>
            ))}
          </div>
          <div className="flex gap-2">
            {allAnswered || timeLeft === 0 ? (
              <Button className="flex-1" onClick={revealAnswer}>Cevabı Göster</Button>
            ) : (
              <Button className="flex-1" variant="outline" onClick={revealAnswer}>Cevabı Erken Göster</Button>
            )}
          </div>
        </CardContent>
      </Card>
    );
  }

  if (phase === "reveal" && currentQ) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Cevap — Soru {qIdx + 1} / {total}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="p-4 bg-gray-50 rounded-xl text-center">
            <p className="text-xl font-bold">{currentQ.text}</p>
          </div>
          <div className="grid grid-cols-2 gap-2">
            {currentQ.answers.map((ans, i) => (
              <div
                key={i}
                className={`${COLORS[i]} text-white rounded-xl p-3 flex items-center gap-2 transition-all ${correctIndexes.includes(i) ? "ring-4 ring-white scale-105" : "opacity-40"}`}
              >
                <span className="font-bold text-lg w-6">{correctIndexes.includes(i) ? "✓" : LABELS[i]}</span>
                <span className="text-sm">{ans.text}</span>
                <span className="ml-auto font-bold">{answerCounts[i] || 0}</span>
              </div>
            ))}
          </div>
          <Button className="w-full" onClick={showLeaderboard}>Sıralamayı Göster</Button>
        </CardContent>
      </Card>
    );
  }

  if (phase === "leaderboard") {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Sıralama — Soru {qIdx + 1} / {total}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            {leaderboard.slice(0, 5).map(e => (
              <div key={e.pid || e.name} className="flex items-center gap-3 p-3 rounded-xl bg-gray-50 border">
                <span className="text-lg w-8 text-center">{e.rank <= 3 ? ["🥇","🥈","🥉"][e.rank-1] : `#${e.rank}`}</span>
                <span className="flex-1 font-medium">{e.name}</span>
                <span className="font-mono font-bold">{e.score}</span>
              </div>
            ))}
          </div>
          {isLast ? (
            <Button className="w-full" onClick={endGame}>Oyunu Bitir</Button>
          ) : (
            <Button className="w-full" onClick={nextQuestion}>Sonraki Soru</Button>
          )}
        </CardContent>
      </Card>
    );
  }

  if (phase === "end") {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">🏆 Oyun Bitti!</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            {leaderboard.map(e => (
              <div key={e.pid || e.name} className="flex items-center gap-3 p-3 rounded-xl bg-gray-50 border">
                <span className="text-lg w-8 text-center">{e.rank <= 3 ? ["🥇","🥈","🥉"][e.rank-1] : `#${e.rank}`}</span>
                <span className="flex-1 font-medium">{e.name}</span>
                <span className="font-mono font-bold">{e.score}</span>
              </div>
            ))}
          </div>
          <p className="text-xs text-muted-foreground text-center">
            Sonuçlar kaydedildi — Excel raporunu Raporlar bölümünden indirebilirsiniz.
          </p>
          <Button className="w-full" onClick={resetGame}>Yeni Oyun</Button>
        </CardContent>
      </Card>
    );
  }

  return null;
}
