# AssisTT Quiz Time

Kahoot benzeri canlı quiz platformu. Tek bir Node sunucusu hem REST API'yi (Express 5 + Socket.IO) hem de web arayüzünü servis eder; veritabanı PostgreSQL'dir. Artık **Replit'e bağımlı değildir** — herhangi bir sunucuda, VPS'te veya container destekleyen ücretsiz bir platformda çalışır.

---

## Mimarisi kısaca

- `artifacts/api-server` — Express + Socket.IO API ve üretimde web arayüzünü de servis eder.
- `artifacts/quiz` — web arayüzü (Vite ile derlenir).
- `lib/db` — PostgreSQL + Drizzle ORM. Tablolar sunucu ilk açıldığında otomatik oluşturulur (`ensureSchema`), ayrı bir migration adımına gerek yoktur.
- pnpm monorepo; Node 24.

---

## Gerekli ortam değişkenleri

`.env.example` dosyasını `.env` olarak kopyalayın ve doldurun.

| Değişken | Zorunlu | Açıklama |
|---|---|---|
| `DATABASE_URL` | Evet | PostgreSQL bağlantı adresi. |
| `JWT_SECRET` | Evet (üretim) | Uzun rastgele bir dize. Yoksa üretimde sunucu açılmaz. |
| `PORT` | Hayır | Dinlenecek port (çoğu host otomatik verir; varsayılan 8000). |
| `DATABASE_SSL` | Hayır | Yerel/Docker DB için `false` yapın. Uzak yönetilen DB'lerde boş bırakın (SSL otomatik açılır). |
| `OPENAI_API_KEY` | Hayır | AI ile soru üretme/asistan özelliği için. Boşsa AI dışı her şey çalışır. |

`JWT_SECRET` üretmek için:
```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

---

## Seçenek A — Kendi sunucunuz / VPS (Docker, önerilen)

En taşınabilir yol. Sunucuda Docker + Docker Compose kurulu olmalı.

```bash
# 1) Projeyi sunucuya alın (git clone ya da dosyaları kopyalayın)
cd assisttquizhaziran

# 2) Ortamı hazırlayın
cp .env.example .env
nano .env            # JWT_SECRET'i doldurun (DB ayarları compose ile gelir)

# 3) Başlatın (uygulama + PostgreSQL birlikte ayağa kalkar)
docker compose up -d --build
```

Uygulama artık `http://SUNUCU_IP:8000` adresinde. İlk açılışta tablolar otomatik oluşur ve admin girişi hazırdır.

**Tamamen ücretsiz VPS:** Oracle Cloud "Always Free" kalıcı ücretsiz bir sunucu verir (kredi kartı ister ama ücret almaz). Alternatif olarak düşük maliyetli Hetzner/Contabo kutuları.

### Domain + HTTPS bağlama (VPS)
Bir alan adınız varsa (Cloudflare, Namecheap vb.), A kaydını sunucu IP'nize yönlendirin. HTTPS için en kolay yol Caddy (otomatik Let's Encrypt sertifikası):

```bash
# Sunucuda /etc/caddy/Caddyfile
alanadiniz.com {
    reverse_proxy localhost:8000
}
```
Caddy'yi kurup çalıştırınca `https://alanadiniz.com` otomatik sertifikayla yayında olur.

---

## Seçenek B — Render (kredi kartısız ücretsiz, en hızlısı)

Repoda `render.yaml` hazır. Render hem ücretsiz web servisini hem de ücretsiz PostgreSQL'i otomatik kurar ve birbirine bağlar.

1. Kodunuzu bir GitHub deposuna gönderin.
2. [render.com](https://render.com) → **New +** → **Blueprint** → repoyu seçin.
3. Render `render.yaml`'ı okur: web servisi + ücretsiz Postgres oluşturur, `JWT_SECRET`'i kendisi üretir.
4. Birkaç dakikada `https://<isim>.onrender.com` adresinde yayında olur.

**Ücretsiz domain:** `onrender.com` alt alan adı ücretsiz gelir. Kendi alan adınızı eklemek için servis → **Settings → Custom Domains** (ücretsiz, SSL dahil).

> Not: Render ücretsiz katmanı bir süre trafik olmazsa uykuya geçer; ilk istek birkaç saniye gecikebilir. Ücretsiz Postgres'in süre sınırı için Render'ın güncel koşullarına bakın.

Diğer container destekleyen platformlar (Railway, Fly.io, Koyeb) da aynı `Dockerfile` ile çalışır.

---

## İlk giriş

İlk açılışta veritabanı boştur; yönetici hesabı koda gömülüdür:

- **Sicil:** `A053252`
- **Şifre:** `admin123`

İlk girişten sonra şifreyi panelden değiştirin; yeni şifre veritabanında saklanır. Normal kullanıcıları admin panelinden eklersiniz.

---

## Yerelde geliştirme

```bash
corepack enable                 # pnpm'i etkinleştirir
pnpm install
# Bir PostgreSQL'e ihtiyacınız var; DATABASE_URL'i .env'e koyun
pnpm --filter @workspace/api-server dev
```

Derleme komutları:
```bash
pnpm --filter @workspace/quiz run build        # arayüz
pnpm --filter @workspace/api-server run build   # API
```
