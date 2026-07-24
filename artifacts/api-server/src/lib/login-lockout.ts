// Başarısız giriş denemelerini sicil bazında takip eder. Bellek içi tutuluyor
// (game session Map'leriyle aynı desen) — tek instance'lık bir kurulum için
// yeterli ve basit; sunucu yeniden başlarsa kilitler de sıfırlanır ki bu
// zaten güvenlik açısından sorun değil (kötü niyetli biri sunucuyu yeniden
// başlatamaz).

const LOCKOUT_THRESHOLD = 5;
const LOCKOUT_DURATION_MS = 15 * 60 * 1000; // 15 dakika

interface AttemptRecord {
  count: number;
  lockedUntil: number | null;
}

const attempts = new Map<string, AttemptRecord>();

function normalize(sicil: string): string {
  return sicil.trim().toUpperCase();
}

export function checkLocked(sicil: string): { locked: boolean; remainingMinutes?: number } {
  const rec = attempts.get(normalize(sicil));
  if (!rec?.lockedUntil) return { locked: false };
  if (Date.now() >= rec.lockedUntil) {
    // Süre dolmuş, otomatik aç
    attempts.delete(normalize(sicil));
    return { locked: false };
  }
  return { locked: true, remainingMinutes: Math.ceil((rec.lockedUntil - Date.now()) / 60000) };
}

export function recordFailure(sicil: string): void {
  const key = normalize(sicil);
  const rec = attempts.get(key) || { count: 0, lockedUntil: null };
  rec.count++;
  if (rec.count >= LOCKOUT_THRESHOLD) {
    rec.lockedUntil = Date.now() + LOCKOUT_DURATION_MS;
  }
  attempts.set(key, rec);
}

export function recordSuccess(sicil: string): void {
  attempts.delete(normalize(sicil));
}

export function unlockAccount(sicil: string): void {
  attempts.delete(normalize(sicil));
}

// Admin panelinde göstermek için: şu an kilitli olan hesapların listesi.
export function listLocked(): { sicil: string; remainingMinutes: number }[] {
  const now = Date.now();
  const result: { sicil: string; remainingMinutes: number }[] = [];
  for (const [sicil, rec] of attempts.entries()) {
    if (rec.lockedUntil && rec.lockedUntil > now) {
      result.push({ sicil, remainingMinutes: Math.ceil((rec.lockedUntil - now) / 60000) });
    }
  }
  return result;
}
