import { Router } from "express";
import rateLimit from "express-rate-limit";
import { db } from "@workspace/db";
import { authorizedUsersTable, systemConfigTable, loginHistoryTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { signToken, requireAuth } from "../middlewares/auth";
import type { AuthPayload } from "../middlewares/auth";
import type { Request } from "express";
import bcrypt from "bcryptjs";
import { checkLocked, recordFailure, recordSuccess } from "../lib/login-lockout";
import { logger } from "../lib/logger";

const router = Router();

const ADMIN_SICIL = "A053252";
const ADMIN_DEFAULT_PASSWORD = "admin123";

// Başarılı bir girişte "son giriş" zamanını günceller ve giriş geçmişine bir
// kayıt ekler ("Giriş Bilgileri" panelinde tarih listesi için). Admin
// hesabı authorized_users tablosunda tutulmadığı için (sabit kodlu), onun
// için sadece login_history'e yazıyoruz, last_login_at güncellemesi normal
// kullanıcılar için geçerli.
async function recordLogin(sicil: string, isRegularUser: boolean) {
  try {
    if (isRegularUser) {
      await db.update(authorizedUsersTable).set({ lastLoginAt: new Date() }).where(eq(authorizedUsersTable.sicil, sicil));
    }
    await db.insert(loginHistoryTable).values({ sicil });
  } catch (e) {
    logger.error({ err: e }, "Giriş kaydı yazılamadı");
  }
}

// IP bazlı sınırlama: aynı IP'den kısa sürede çok fazla giriş denemesi
// gelirse (hangi sicille denenirse denensin), farklı sicil numaralarını
// art arda deneyerek şifre taramayı zorlaştırır. Hesap bazlı kilit
// (login-lockout.ts) ile birlikte çalışır — o tek bir hesabı korur, bu IP'yi
// genel olarak yavaşlatır.
const loginRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Çok fazla giriş denemesi yapıldı. Lütfen birkaç dakika sonra tekrar deneyin." },
});

async function getAdminPasswordHash(): Promise<string | null> {
  const rows = await db
    .select()
    .from(systemConfigTable)
    .where(eq(systemConfigTable.key, "admin_password_hash"));
  return rows.length > 0 ? rows[0].value : null;
}

router.post("/login", loginRateLimiter, async (req, res) => {
  const { sicil, password } = req.body as { sicil: string; password?: string };

  if (!sicil) {
    res.status(400).json({ error: "Sicil numarası gereklidir." });
    return;
  }

  // Hesap bazlı kilit: art arda çok sayıda yanlış şifre denenen bir sicil,
  // belirli bir süre (varsayılan 15 dk) giriş denemesine kapatılır. Süre
  // dolunca otomatik açılır; admin de panelden elle açabilir.
  const lockStatus = checkLocked(sicil);
  if (lockStatus.locked) {
    res.status(423).json({
      error: `Çok fazla hatalı deneme nedeniyle bu hesap geçici olarak kilitlendi. ${lockStatus.remainingMinutes} dakika sonra tekrar deneyin, ya da bir yöneticiden kilidi kaldırmasını isteyin.`,
    });
    return;
  }

  if (sicil === ADMIN_SICIL) {
    if (!password) {
      res.status(400).json({ error: "Şifre gereklidir." });
      return;
    }
    const storedHash = await getAdminPasswordHash();
    let valid: boolean;
    if (storedHash) {
      valid = await bcrypt.compare(password, storedHash);
    } else {
      valid = password === ADMIN_DEFAULT_PASSWORD;
    }
    if (!valid) {
      recordFailure(sicil);
      res.status(401).json({ error: "Hatalı şifre." });
      return;
    }
    recordSuccess(sicil);
    await recordLogin(ADMIN_SICIL, false);
    const token = signToken({ sicil: ADMIN_SICIL, adSoyad: "Yönetici", role: "admin" });
    res.json({ token, role: "admin", adSoyad: "Yönetici", sicil: ADMIN_SICIL });
    return;
  }

  if (!password) {
    res.status(400).json({ error: "Şifre gereklidir." });
    return;
  }

  const users = await db
    .select()
    .from(authorizedUsersTable)
    .where(eq(authorizedUsersTable.sicil, sicil));

  if (users.length === 0) {
    res.status(401).json({ error: "Bu sicil numarası sisteme kayıtlı değil." });
    return;
  }

  const user = users[0];

  if (!user.passwordHash) {
    res.status(401).json({ error: "Bu kullanıcı için şifre henüz tanımlanmamış. Yöneticinizle iletişime geçin." });
    return;
  }

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) {
    recordFailure(sicil);
    res.status(401).json({ error: "Hatalı şifre." });
    return;
  }

  recordSuccess(sicil);
  await recordLogin(user.sicil, true);
  const token = signToken({
    sicil: user.sicil,
    adSoyad: user.adSoyad,
    role: user.yetki as "full" | "limited" | "manager",
  });

  res.json({ token, role: user.yetki, adSoyad: user.adSoyad, sicil: user.sicil });
});

router.post("/change-password", requireAuth, async (req, res) => {
  const user = (req as Request & { user: AuthPayload }).user;
  const { oldPassword, newPassword } = req.body as { oldPassword: string; newPassword: string };

  if (!oldPassword || !newPassword) {
    res.status(400).json({ error: "Mevcut ve yeni şifre zorunludur." });
    return;
  }
  if (newPassword.length < 4) {
    res.status(400).json({ error: "Yeni şifre en az 4 karakter olmalıdır." });
    return;
  }

  if (user.role === "admin") {
    const storedHash = await getAdminPasswordHash();
    let valid: boolean;
    if (storedHash) {
      valid = await bcrypt.compare(oldPassword, storedHash);
    } else {
      valid = oldPassword === ADMIN_DEFAULT_PASSWORD;
    }
    if (!valid) {
      res.status(401).json({ error: "Mevcut şifre hatalı." });
      return;
    }
    const newHash = await bcrypt.hash(newPassword, 10);
    await db
      .insert(systemConfigTable)
      .values({ key: "admin_password_hash", value: newHash })
      .onConflictDoUpdate({ target: systemConfigTable.key, set: { value: newHash } });
    res.json({ success: true });
    return;
  }

  const users = await db
    .select()
    .from(authorizedUsersTable)
    .where(eq(authorizedUsersTable.sicil, user.sicil));

  if (!users.length) {
    res.status(404).json({ error: "Kullanıcı bulunamadı." });
    return;
  }

  const dbUser = users[0];

  if (dbUser.passwordHash) {
    const valid = await bcrypt.compare(oldPassword, dbUser.passwordHash);
    if (!valid) {
      res.status(401).json({ error: "Mevcut şifre hatalı." });
      return;
    }
  }

  const hash = await bcrypt.hash(newPassword, 10);
  await db
    .update(authorizedUsersTable)
    .set({ passwordHash: hash })
    .where(eq(authorizedUsersTable.sicil, user.sicil));

  res.json({ success: true });
});

export default router;
