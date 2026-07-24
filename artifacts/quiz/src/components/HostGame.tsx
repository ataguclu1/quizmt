import { useState, useEffect, useRef } from "react";
import { io, type Socket } from "socket.io-client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import type { QuestionSet } from "@/lib/api";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");
const API_ORIGIN = window.location.origin;

interface Player {
  name: string;
  score: number;
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
}

const COLORS = ["bg-red-500", "bg-blue-500", "bg-yellow-500", "bg-green-500"];
const LABELS = ["A", "B", "C", "D"];

export default function HostGame({ questionSets }: { questionSets: QuestionSet[] }) {
  const [selectedSetId, setSelectedSetId] = useState<string>("");
  const [pin, setPin] = useState("");
  const [phase, setPhase] = useState<Phase>("setup");
  const [players, setPlayers] = useState<Player[]>([]);
  const [qIdx, setQIdx] = useState(0);
  const [total, setTotal] = useState(0);
  const [currentQ, setCurrentQ] = useState<{ text: string; time: number; answers: { text: string }[] } | null>(null);
  const [answerCounts, setAnswerCounts] = useState<AnswerCount>({});
  const [answeredCount, setAnsweredCount] = useState(0);
  const [correctIndexes, setCorrectIndexes] = useState<number[]>([]);
  const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[]>([]);
  const [isLast, setIsLast] = useState(false);
  const [timeLeft, setTimeLeft] = useState(0);
  const [allAnswered, setAllAnswered] = useState(false);
  const socketRef = useRef<Socket | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const selectedSet = questionSets.find(s => String(s.id) === selectedSetId);

  useEffect(() => {
    return () => {
      socketRef.current?.disconnect();
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, []);

  function generatePin() {
    return String(Math.floor(100000 + Math.random() * 900000));
  }

  function startSession() {
    if (!selectedSet) return;

    const newPin = generatePin();
    setPin(newPin);
    setPhase("lobby");
    setPlayers([]);
    setQIdx(0);
    setAnsweredCount(0);
    setAllAnswered(false);

    const socket = io(API_ORIGIN, {
      path: `${BASE}/api/socket.io`,
      transports: ["websocket", "polling"],
    });
    socketRef.current = socket;

    socket.on("connect", () => {
      socket.emit("create-session", { pin: newPin, questions: selectedSet.questions });
    });

    socket.on("player-joined", (d: { players: Player[]; playerCount: number }) => {
      setPlayers([...d.players]);
    });

    socket.on("player-left", (d: { players: Player[] }) => {
      setPlayers([...d.players]);
    });

    socket.on("player-answered", (d: { answeredCount: number; answerCounts: AnswerCount }) => {
      setAnsweredCount(d.answeredCount);
      setAnswerCounts({ ...d.answerCounts });
    });

    socket.on("all-answered", () => setAllAnswered(true));

    socket.on("leaderboard-shown", (d: { leaderboard: LeaderboardEntry[] }) => {
      setLeaderboard(d.leaderboard);
    });

    socket.on("game-ended", (d: { leaderboard: LeaderboardEntry[] }) => {
      setLeaderboard(d.leaderboard);
    });
  }

  function startGame() {
    if (!selectedSet) return;
    socketRef.current?.emit("start-game", { pin });
    setPhase("question");
    setQIdx(0);
    setTotal(selectedSet.questions.length);
    setCurrentQ({
      text: String(selectedSet.questions[0].text),
      time: Number(selectedSet.questions[0].time) || 20,
      answers: selectedSet.questions[0].answers.map((a) => ({ text: a.text })),
    });
    setAnsweredCount(0);
    setAnswerCounts({});
    setAllAnswered(false);
    startTimer(Number(selectedSet.questions[0].time) || 20);
  }

  function startTimer(seconds: number) {
    setTimeLeft(seconds);
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = setInterval(() => {
      setTimeLeft(t => {
        if (t <= 1) { clearInterval(timerRef.current!); return 0; }
        return t - 1;
      });
    }, 1000);
  }

  function revealAnswer() {
    if (timerRef.current) clearInterval(timerRef.current);
    socketRef.current?.emit("reveal-answer", { pin, qIdx });
    setPhase("reveal");
    const q = selectedSet!.questions[qIdx];
    const correctIdxs = q.answers.map((a, i) => a.correct ? i : -1).filter(i => i !== -1);
    setCorrectIndexes(correctIdxs);
  }

  function showLeaderboard() {
    socketRef.current?.emit("show-leaderboard", { pin });
    setPhase("leaderboard");
    setIsLast(qIdx >= (selectedSet?.questions.length ?? 1) - 1);
  }

  function nextQuestion() {
    const nextIdx = qIdx + 1;
    const q = selectedSet!.questions[nextIdx];
    socketRef.current?.emit("next-question", { pin });
    setQIdx(nextIdx);
    setCurrentQ({
      text: String(q.text),
      time: Number(q.time) || 20,
      answers: q.answers.map((a) => ({ text: a.text })),
    });
    setAnsweredCount(0);
    setAnswerCounts({});
    setAllAnswered(false);
    setPhase("question");
    startTimer(Number(q.time) || 20);
  }

  function endGame() {
    socketRef.current?.emit("end-game", { pin });
    setPhase("end");
    if (timerRef.current) clearInterval(timerRef.current);
  }

  function resetGame() {
    socketRef.current?.disconnect();
    socketRef.current = null;
    setPhase("setup");
    setPlayers([]);
    setPin("");
    setLeaderboard([]);
  }


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
            <Button variant="outline" size="sm" onClick={resetGame}>Vazgeç</Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="text-center p-6 bg-violet-50 rounded-xl border-2 border-violet-200">
            <p className="text-sm text-muted-foreground mb-1">Oyun PIN'i</p>
            <p className="text-5xl font-bold tracking-widest text-violet-700">{pin}</p>
            <p className="text-xs text-muted-foreground mt-2">Oyuncular bu PIN ile katılabilir</p>
          </div>
          <div>
            <p className="text-sm font-medium mb-2">Katılımcılar ({players.length})</p>
            <div className="grid grid-cols-2 gap-2">
              {players.map(p => (
                <div key={p.name} className="flex items-center gap-2 p-2 rounded-lg bg-gray-50 border text-sm">
                  <span>👤</span>
                  <span>{p.name}</span>
                </div>
              ))}
              {players.length === 0 && (
                <p className="col-span-2 text-sm text-muted-foreground text-center py-4">Oyuncular bekleniyor...</p>
              )}
            </div>
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
              <Badge variant="secondary">{answeredCount}/{players.length} cevapladı</Badge>
              <div className={`text-lg font-bold ${timeLeft <= 5 ? "text-red-500 animate-pulse" : "text-gray-700"}`}>
                ⏱ {timeLeft}s
              </div>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="p-4 bg-gray-50 rounded-xl text-center">
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
              <div key={e.name} className="flex items-center gap-3 p-3 rounded-xl bg-gray-50 border">
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
              <div key={e.name} className="flex items-center gap-3 p-3 rounded-xl bg-gray-50 border">
                <span className="text-lg w-8 text-center">{e.rank <= 3 ? ["🥇","🥈","🥉"][e.rank-1] : `#${e.rank}`}</span>
                <span className="flex-1 font-medium">{e.name}</span>
                <span className="font-mono font-bold">{e.score}</span>
              </div>
            ))}
          </div>
          <Button className="w-full" onClick={resetGame}>Yeni Oyun</Button>
        </CardContent>
      </Card>
    );
  }

  return null;
}
