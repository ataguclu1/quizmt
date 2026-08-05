import { Router, type Request } from "express";
import { db } from "@workspace/db";
import { gameSessionsTable } from "@workspace/db";
import { desc, eq } from "drizzle-orm";
import * as XLSX from "xlsx";
import { requireFull, requireAdmin, type AuthPayload } from "../middlewares/auth";
import { logger } from "../lib/logger";

const router = Router();

type Answer = { text: string; correct: boolean };
type QuestionRow = { text: string; answers: Answer[]; questionType?: string; voiceScript?: string };
type PlayerAnswerEntry = { choice: number; ts: number };
type PlayerAnswers = {
  name: string;
  score: number;
  answers: Record<number, PlayerAnswerEntry>;
};
type LeaderboardEntry = { name: string; score: number };
type SessionResults = {
  leaderboard?: LeaderboardEntry[];
  playerAnswers?: PlayerAnswers[];
};

// Sadece giriş yapmış, en az "full" (editör) yetkisindeki kullanıcılar
// raporlara erişebilir — "limited" (sadece yayınla) rolü göremez.
// admin/manager tüm oturumları görür; "full" sadece kendi açtığı oturumları.
router.get("/sessions", requireFull, async (req, res) => {
  const user = (req as Request & { user: AuthPayload }).user;
  const rows = await db
    .select({
      id: gameSessionsTable.id,
      pin: gameSessionsTable.pin,
      title: gameSessionsTable.title,
      category: gameSessionsTable.category,
      hostSicil: gameSessionsTable.hostSicil,
      questionCount: gameSessionsTable.questionCount,
      playerCount: gameSessionsTable.playerCount,
      startedAt: gameSessionsTable.startedAt,
      endedAt: gameSessionsTable.endedAt,
    })
    .from(gameSessionsTable)
    .orderBy(desc(gameSessionsTable.endedAt))
    .limit(200);

  const scoped = user.role === "admin" || user.role === "manager"
    ? rows
    : rows.filter((r: typeof rows[number]) => r.hostSicil === user.sicil);

  res.json(scoped);
});

router.get("/sessions/:id/export", requireFull, async (req, res) => {
  const user = (req as Request & { user: AuthPayload }).user;
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Geçersiz oturum ID." });
    return;
  }

  const [session] = await db
    .select()
    .from(gameSessionsTable)
    .where(eq(gameSessionsTable.id, id));

  if (!session) {
    res.status(404).json({ error: "Oturum bulunamadı." });
    return;
  }
  if (user.role !== "admin" && user.role !== "manager" && session.hostSicil !== user.sicil) {
    res.status(403).json({ error: "Bu oturumun raporunu görme yetkiniz yok." });
    return;
  }

  try {
    const questions = (session.questions || []) as QuestionRow[];
    const results = (session.results || {}) as SessionResults;
    const playerAnswers = results.playerAnswers || [];
    const leaderboard = results.leaderboard && results.leaderboard.length
      ? results.leaderboard
      : [...playerAnswers].sort((a, b) => b.score - a.score).map(p => ({ name: p.name, score: p.score }));

    const correctIdxByQ = questions.map(q => q.answers?.findIndex(a => a.correct) ?? -1);
    const byName = new Map(playerAnswers.map(p => [p.name, p]));

    // ── Sayfa 1: Katılımcılar ────────────────────────────────────────────
    const participantHeader = ["Sıra", "İsim", "Doğru", "Yanlış", "Boş", "Puan", ...questions.map((_, i) => `Soru ${i + 1}`)];
    const participantRows = leaderboard.map((entry, rank) => {
      const p = byName.get(entry.name);
      let correct = 0, wrong = 0, blank = 0;
      const perQ: string[] = questions.map((_, qIdx) => {
        const ans = p?.answers?.[qIdx];
        if (ans === undefined) { blank++; return "–"; }
        const isCorrect = ans.choice === correctIdxByQ[qIdx];
        if (isCorrect) correct++; else wrong++;
        return isCorrect ? "✓" : "✗";
      });
      return [rank + 1, entry.name, correct, wrong, blank, entry.score, ...perQ];
    });

    // ── Sayfa 2: Soru Analizi ─────────────────────────────────────────────
    const questionHeader = ["Soru No", "Soru Metni", "Doğru Cevap", "Doğru Sayısı", "Toplam Cevap", "Doğru Oranı (%)"];
    const questionRows = questions.map((q, qIdx) => {
      const correctText = q.answers?.[correctIdxByQ[qIdx]]?.text || "-";
      let correctCount = 0, totalAnswered = 0;
      for (const p of playerAnswers) {
        const ans = p.answers?.[qIdx];
        if (ans === undefined) continue;
        totalAnswered++;
        if (ans.choice === correctIdxByQ[qIdx]) correctCount++;
      }
      const rate = totalAnswered ? Math.round((correctCount / totalAnswered) * 100) : 0;
      // Sesli sorularda Excel'de ses dosyası olamayacağı için, "Soru Metni"
      // sütununa hem seslendirilen senaryo cümlesini hem de katılımcıya
      // gösterilen soru metnini birlikte yazıyoruz — rapor tek başına
      // okunduğunda sorunun tam bağlamı (müşteri ne dedi + ne soruldu) kaybolmasın.
      const questionText = (q.questionType === "voice" && q.voiceScript)
        ? `"${q.voiceScript}" — ${q.text}`
        : q.text;
      return [qIdx + 1, questionText, correctText, correctCount, totalAnswered, rate];
    });

    const wb = XLSX.utils.book_new();
    const ws1 = XLSX.utils.aoa_to_sheet([participantHeader, ...participantRows]);
    const ws2 = XLSX.utils.aoa_to_sheet([questionHeader, ...questionRows]);
    ws1["!cols"] = [{ wch: 6 }, { wch: 22 }, { wch: 8 }, { wch: 8 }, { wch: 8 }, { wch: 8 }, ...questions.map(() => ({ wch: 8 }))];
    ws2["!cols"] = [{ wch: 8 }, { wch: 50 }, { wch: 20 }, { wch: 12 }, { wch: 12 }, { wch: 14 }];
    XLSX.utils.book_append_sheet(wb, ws1, "Katılımcılar");
    XLSX.utils.book_append_sheet(wb, ws2, "Soru Analizi");

    const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
    const safeTitle = (session.title || "Oturum").replace(/[^\p{L}\p{N}_ -]/gu, "").slice(0, 60);
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(safeTitle)}-rapor.xlsx"`);
    res.send(Buffer.from(buf));
  } catch (e) {
    logger.error({ err: e }, "Rapor export hatası");
    res.status(500).json({ error: "Rapor oluşturulamadı." });
  }
});

// Test amaçlı açılan / hatalı oturumları temizlemek için — kasıtlı olarak
// sadece admin'e açık (requireAdmin), diğer roller (manager/full dahil)
// geçmiş sınav kayıtlarını silemez.
router.delete("/sessions/:id", requireAdmin, async (req, res) => {
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Geçersiz oturum ID." });
    return;
  }
  const deleted = await db.delete(gameSessionsTable).where(eq(gameSessionsTable.id, id)).returning();
  if (deleted.length === 0) {
    res.status(404).json({ error: "Oturum bulunamadı." });
    return;
  }
  logger.info({ id }, "Oturum raporu silindi");
  res.json({ success: true });
});

export default router;
