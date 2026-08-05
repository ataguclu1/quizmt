import { useState, useEffect, useRef } from "react";
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
}

type Phase = "join" | "lobby" | "question" | "reveal" | "leaderboard" | "end";

interface LeaderboardEntry {
  rank: number;
  name: string;
  score: number;
}

const COLORS = ["bg-red-500", "bg-blue-500", "bg-yellow-500", "bg-green-500"];
const SHAPES = ["▲", "◆", "●", "■"];
const SESSION_KEY = "quiz-player-session";

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
  const [question, setQuestion] = useState<Question | null>(null);
  const [qIdx, setQIdx] = useState(0);
  const [total, setTotal] = useState(0);
  const [selected, setSelected] = useState<number | null>(null);
  const [correctIndexes, setCorrectIndexes] = useState<number[]>([]);
  const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[]>([]);
  const [timeLeft, setTimeLeft] = useState(0);
  const [myScore, setMyScore] = useState(0);
  const socketRef = useRef<Socket | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    const socket = io(API_ORIGIN, {
      path: `${BASE}/api/socket.io`,
      transports: ["websocket", "polling"],
    });
    socketRef.current = socket;

    // If we have a saved pin/name (e.g. after an F5 refresh or dropped connection),
    // try to silently rejoin as soon as the socket connects instead of showing
    // an empty "join" screen.
    socket.on("connect", () => {
      const saved = loadSession();
      if (saved) {
        setPin(saved.pin);
        setName(saved.name);
        socket.emit("join-session", {
          pin: saved.pin,
          name: saved.name,
          avatar: { style: "avataaars", seed: saved.name },
        });
      }
    });

    socket.on("join-success", (d: { pin: string; name: string }) => {
      saveSession(d.pin, d.name);
      setPhase("lobby");
    });

    socket.on("join-error", (d: { message: string }) => {
      // A saved session that the server no longer recognizes is stale — drop it
      // so the person isn't stuck retrying a rejoin that will never succeed.
      clearSession();
      setError(d.message);
      setPhase("join");
    });

    // Player reconnected mid-game (F5 or dropped connection) — restore exactly
    // where they left off instead of dropping them back to the lobby.
    socket.on("rejoin-player-success", (d: {
      pin: string; name: string; score: number; qIdx: number; phase: Phase; total: number;
      question?: Question; timeLeft?: number; selected?: number | null; correctIndexes?: number[];
      leaderboard?: LeaderboardEntry[];
    }) => {
      saveSession(d.pin, d.name);
      setMyScore(d.score);
      setQIdx(d.qIdx);
      setTotal(d.total);
      setError("");

      if (d.question) setQuestion(d.question);
      if (typeof d.timeLeft === "number") setTimeLeft(d.timeLeft);
      if (d.selected !== undefined) setSelected(d.selected);
      if (d.correctIndexes) setCorrectIndexes(d.correctIndexes);
      if (d.leaderboard) setLeaderboard(d.leaderboard);

      setPhase(d.phase);

      // Resume the countdown locally if we rejoined mid-question
      if (d.phase === "question" && typeof d.timeLeft === "number") {
        if (timerRef.current) clearInterval(timerRef.current);
        timerRef.current = setInterval(() => {
          setTimeLeft((t) => {
            if (t <= 1) { clearInterval(timerRef.current!); return 0; }
            return t - 1;
          });
        }, 1000);
      }
    });

    socket.on("game-started", (d: { qIdx: number; question: Question; total: number }) => {
      startQuestion(d.question, d.qIdx, d.total);
    });

    socket.on("question-shown", (d: { qIdx: number; question: Question; total: number }) => {
      startQuestion(d.question, d.qIdx, d.total);
    });

    socket.on("answer-revealed", (d: { correctIndexes: number[]; playerScores: Record<string, number> }) => {
      setCorrectIndexes(d.correctIndexes);
      setPhase("reveal");
      if (timerRef.current) clearInterval(timerRef.current);
    });

    socket.on("leaderboard-shown", (d: { leaderboard: LeaderboardEntry[] }) => {
      setLeaderboard(d.leaderboard);
      setPhase("leaderboard");
    });

    socket.on("game-ended", (d: { leaderboard: LeaderboardEntry[] }) => {
      setLeaderboard(d.leaderboard);
      setPhase("end");
      clearSession();
    });

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

    return () => {
      socket.disconnect();
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, []);

  function startQuestion(q: Question, idx: number, tot: number) {
    setQuestion(q);
    setQIdx(idx);
    setTotal(tot);
    setSelected(null);
    setCorrectIndexes([]);
    setPhase("question");
    setTimeLeft(q.time);

    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = setInterval(() => {
      setTimeLeft((t) => {
        if (t <= 1) {
          clearInterval(timerRef.current!);
          return 0;
        }
        return t - 1;
      });
    }, 1000);
  }

  function joinGame() {
    setError("");
    if (!pin.trim() || !name.trim()) {
      setError("PIN ve isim zorunludur.");
      return;
    }
    socketRef.current?.emit("join-session", {
      pin: pin.trim(),
      name: name.trim(),
      avatar: { style: "avataaars", seed: name.trim() },
    });
  }

  function submitAnswer(choice: number) {
    if (selected !== null) return;
    setSelected(choice);
    socketRef.current?.emit("submit-answer", { pin, name, qIdx, choice });
  }

  if (phase === "join") {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-violet-600 to-indigo-700 p-4">
        <Card className="w-full max-w-sm shadow-2xl">
          <CardHeader className="text-center">
            <div className="text-5xl mb-2">🎯</div>
            <CardTitle className="text-xl">Oyuna Katıl</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <Input placeholder="Oyun PIN'i" value={pin} onChange={e => setPin(e.target.value)} maxLength={6} />
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
        </div>
      </div>
    );
  }

  if (phase === "question" && question) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-violet-600 to-indigo-700 p-4 flex flex-col">
        <div className="flex justify-between items-center text-white mb-4">
          <Badge variant="secondary">Soru {qIdx + 1}/{total}</Badge>
          <div className={`text-2xl font-bold ${timeLeft <= 5 ? "text-red-300 animate-pulse" : ""}`}>
            ⏱ {timeLeft}s
          </div>
        </div>
        <Card className="mb-4">
          <CardContent className="pt-6 text-center">
            <p className="text-xl font-bold">{question.text}</p>
          </CardContent>
        </Card>
        <div className="grid grid-cols-2 gap-3 flex-1">
          {question.answers.map((ans, i) => (
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
        {selected !== null && (
          <p className="text-center text-white mt-4 font-semibold">Cevabın kaydedildi! Sonuç bekleniyor...</p>
        )}
      </div>
    );
  }

  if (phase === "reveal" && question) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-violet-600 to-indigo-700 p-4 flex flex-col">
        <div className="text-white text-center mb-4">
          <p className="text-lg font-semibold">Sonuçlar</p>
        </div>
        <div className="grid grid-cols-2 gap-3">
          {question.answers.map((ans, i) => (
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
            {correctIndexes.includes(selected)
              ? <p className="text-2xl">✅ Doğru!</p>
              : <p className="text-2xl">❌ Yanlış!</p>}
          </div>
        )}
      </div>
    );
  }

  if (phase === "leaderboard" || phase === "end") {
    const myEntry = leaderboard.find((e) => e.name === name);
    return (
      <div className="min-h-screen bg-gradient-to-br from-violet-600 to-indigo-700 p-4">
        <div className="text-center text-white mb-6">
          <div className="text-4xl mb-2">{phase === "end" ? "🏆" : "📊"}</div>
          <h2 className="text-2xl font-bold">{phase === "end" ? "Oyun Bitti!" : "Sıralama"}</h2>
          {myEntry && <p className="text-violet-200 mt-1">Sıralamanız: #{myEntry.rank} · {myEntry.score} puan</p>}
        </div>
        <div className="space-y-2 max-w-md mx-auto">
          {leaderboard.slice(0, 10).map((e) => (
            <div
              key={e.name}
              className={`flex items-center gap-3 rounded-xl p-3 ${e.name === name ? "bg-white text-violet-700 font-bold" : "bg-white/20 text-white"}`}
            >
              <span className="text-lg w-8 text-center">{e.rank <= 3 ? ["🥇","🥈","🥉"][e.rank-1] : `#${e.rank}`}</span>
              <span className="flex-1">{e.name}</span>
              <span className="font-mono">{e.score}</span>
            </div>
          ))}
        </div>
      </div>
    );
  }

  return null;
}
