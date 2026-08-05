import { Router, type Request } from "express";
import { db } from "@workspace/db";
import { questionSetsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { requireAuth, requireFull, requireManager, type AuthPayload } from "../middlewares/auth";

const router = Router();

// Birimin verdiği eğitimlerin ait olduğu projeler. Sabit bir liste tutuyoruz
// (serbest metin değil) ki kütüphanede kategoriler dağılmasın / yazım farkı
// yüzünden aynı kategori iki farklı başlık altında görünmesin.
const CATEGORIES = ["TT Mobil", "TTNET", "Özel Projeler", "Yetkinlik", "Buz Kırıcı"];

router.get("/", requireAuth, async (_req, res) => {
  const sets = await db
    .select()
    .from(questionSetsTable)
    .orderBy(questionSetsTable.createdAt);
  res.json(sets);
});

router.post("/", requireFull, async (req, res) => {
  const user = (req as Request & { user: AuthPayload }).user;
  const { name, questions, category } = req.body as { name: string; questions: unknown[]; category?: string };

  if (!name || !questions || !Array.isArray(questions)) {
    res.status(400).json({ error: "Soru seti adı ve sorular gereklidir." });
    return;
  }
  if (questions.length === 0) {
    res.status(400).json({ error: "Soru seti en az 1 soru içermelidir." });
    return;
  }
  if (!category || !CATEGORIES.includes(category)) {
    res.status(400).json({ error: "Geçerli bir proje/kategori seçmelisiniz." });
    return;
  }

  const [set] = await db
    .insert(questionSetsTable)
    .values({ name, questions, category, createdBy: user.sicil, createdByName: user.adSoyad })
    .returning();
  res.status(201).json(set);
});

router.delete("/:id", requireManager, async (req, res) => {
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Geçersiz ID." });
    return;
  }
  await db.delete(questionSetsTable).where(eq(questionSetsTable.id, id));
  res.json({ success: true });
});

export default router;
