import { Router } from "express";
import { db } from "@workspace/db";
import { authorizedUsersTable, loginHistoryTable, gameSessionsTable } from "@workspace/db";
import { eq, desc, sql } from "drizzle-orm";
import { requireAdmin } from "../middlewares/auth";
import bcrypt from "bcryptjs";
import { listLocked, unlockAccount } from "../lib/login-lockout";
import { logger } from "../lib/logger";

const router = Router();

router.get("/locked", requireAdmin, async (_req, res) => {
  res.json(listLocked());
});

router.post("/:sicil/unlock", requireAdmin, async (req, res) => {
  unlockAccount(String(req.params.sicil));
  res.json({ success: true });
});

router.get("/", requireAdmin, async (_req, res) => {
  const users = await db.select({
    id: authorizedUsersTable.id,
    sicil: authorizedUsersTable.sicil,
    adSoyad: authorizedUsersTable.adSoyad,
    yetki: authorizedUsersTable.yetki,
    createdAt: authorizedUsersTable.createdAt,
    lastLoginAt: authorizedUsersTable.lastLoginAt,
    aiQueryCount: authorizedUsersTable.aiQueryCount,
    hasPassword: authorizedUsersTable.passwordHash,
  }).from(authorizedUsersTable).orderBy(authorizedUsersTable.createdAt);
  const result = users.map((u: typeof users[number]) => ({
    ...u,
    hasPassword: !!u.hasPassword,
  }));
  res.json(result);
});

// Kullanıcı detay paneli: giriş geçmişi + oturum (host'luk) geçmişi + AI
// kullanım sayacı, tek çağrıda. Sadece admin görebilir.
router.get("/:sicil/detail", requireAdmin, async (req, res) => {
  const sicil = String(req.params.sicil);

  const [user] = await db.select().from(authorizedUsersTable).where(eq(authorizedUsersTable.sicil, sicil));
  if (!user) {
    res.status(404).json({ error: "Kullanıcı bulunamadı." });
    return;
  }

  const logins = await db
    .select({ loginAt: loginHistoryTable.loginAt })
    .from(loginHistoryTable)
    .where(eq(loginHistoryTable.sicil, sicil))
    .orderBy(desc(loginHistoryTable.loginAt))
    .limit(100);

  const sessions = await db
    .select({
      id: gameSessionsTable.id,
      title: gameSessionsTable.title,
      category: gameSessionsTable.category,
      playerCount: gameSessionsTable.playerCount,
      questionCount: gameSessionsTable.questionCount,
      endedAt: gameSessionsTable.endedAt,
    })
    .from(gameSessionsTable)
    .where(eq(gameSessionsTable.hostSicil, sicil))
    .orderBy(desc(gameSessionsTable.endedAt))
    .limit(100);

  res.json({
    sicil: user.sicil,
    adSoyad: user.adSoyad,
    yetki: user.yetki,
    lastLoginAt: user.lastLoginAt,
    aiQueryCount: user.aiQueryCount || 0,
    logins: logins.map((l: typeof logins[number]) => l.loginAt),
    sessions,
  });
});

router.post("/", requireAdmin, async (req, res) => {
  const { sicil, adSoyad, yetki, password } = req.body as {
    sicil: string;
    adSoyad: string;
    yetki: string;
    password: string;
  };
  if (!sicil || !adSoyad || !yetki || !password) {
    res.status(400).json({ error: "Sicil, ad soyad, yetki ve şifre zorunludur." });
    return;
  }
  if (!["full", "limited", "manager"].includes(yetki)) {
    res.status(400).json({ error: "Yetki 'limited', 'full' veya 'manager' olmalıdır." });
    return;
  }
  if (password.length < 4) {
    res.status(400).json({ error: "Şifre en az 4 karakter olmalıdır." });
    return;
  }
  const existing = await db.select().from(authorizedUsersTable).where(eq(authorizedUsersTable.sicil, String(sicil)));
  if (existing.length > 0) {
    res.status(409).json({ error: "Bu sicil zaten kayıtlı." });
    return;
  }
  const passwordHash = await bcrypt.hash(password, 10);
  const [user] = await db
    .insert(authorizedUsersTable)
    .values({ sicil, adSoyad, yetki, passwordHash })
    .returning();
  res.status(201).json({ ...user, hasPassword: true, passwordHash: undefined });
});

// Excel ile toplu kullanıcı ekleme. Frontend, Excel'i kendi tarafında
// (zaten yüklü olan SheetJS ile) satırlara ayırıp buraya düz bir dizi olarak
// yolluyor — sunucu tarafında ayrı bir dosya-yükleme katmanı gerekmiyor.
// Yetki eşlemesi: 1 = manager (tam yetki), 2 = full (editör), 3 = limited (oyuncu).
const BULK_YETKI_MAP: Record<string, string> = { "1": "manager", "2": "full", "3": "limited" };

router.post("/bulk-import", requireAdmin, async (req, res) => {
  const { rows } = req.body as { rows: { sicil: string; adSoyad: string; password: string; yetkiCode: string }[] };
  if (!Array.isArray(rows) || rows.length === 0) {
    res.status(400).json({ error: "İçe aktarılacak satır bulunamadı." });
    return;
  }

  const results = { added: [] as string[], skipped: [] as { sicil: string; reason: string }[] };

  for (const row of rows) {
    const sicil = String(row.sicil || "").trim().toUpperCase();
    const adSoyad = String(row.adSoyad || "").trim();
    const password = String(row.password || "");
    const yetki = BULK_YETKI_MAP[String(row.yetkiCode || "").trim()];

    if (!sicil || !adSoyad) { results.skipped.push({ sicil: sicil || "(boş)", reason: "sicil/ad soyad eksik" }); continue; }
    if (!password || password.length < 4) { results.skipped.push({ sicil, reason: "şifre eksik/kısa (en az 4 karakter)" }); continue; }
    if (!yetki) { results.skipped.push({ sicil, reason: "yetki kodu 1/2/3 değil" }); continue; }

    try {
      const existing = await db.select().from(authorizedUsersTable).where(eq(authorizedUsersTable.sicil, sicil));
      if (existing.length > 0) { results.skipped.push({ sicil, reason: "zaten kayıtlı" }); continue; }
      const passwordHash = await bcrypt.hash(password, 10);
      await db.insert(authorizedUsersTable).values({ sicil, adSoyad, yetki, passwordHash });
      results.added.push(sicil);
    } catch (e) {
      logger.error({ err: e, sicil }, "Toplu kullanıcı ekleme satırı başarısız");
      results.skipped.push({ sicil, reason: "beklenmeyen hata" });
    }
  }

  res.json(results);
});

router.patch("/:sicil/password", requireAdmin, async (req, res) => {
  const { sicil } = req.params;
  const { password } = req.body as { password: string };
  if (!password || password.length < 4) {
    res.status(400).json({ error: "Şifre en az 4 karakter olmalıdır." });
    return;
  }
  const hash = await bcrypt.hash(password, 10);
  await db
    .update(authorizedUsersTable)
    .set({ passwordHash: hash })
    .where(eq(authorizedUsersTable.sicil, String(sicil)));
  res.json({ success: true });
});

router.delete("/:sicil", requireAdmin, async (req, res) => {
  const { sicil } = req.params;
  await db.delete(authorizedUsersTable).where(eq(authorizedUsersTable.sicil, String(sicil)));
  res.json({ success: true });
});

export default router;
