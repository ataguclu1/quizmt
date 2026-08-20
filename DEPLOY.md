# Ücretsiz Yayınlama Rehberi — Adım Adım

Bu doküman projeyi **GitHub'a temiz şekilde yükleyip**, **Render** veya **Railway** üzerinde **ücretsiz** yayınlamak için gereken her adımı içerir. Build ve start komutları, ortam değişkenleri, domain bağlama ve sorun giderme dahildir.

İçindekiler:
1. Ön hazırlık (gerekli hesaplar/araçlar)
2. Adım 1 — Kodu temiz bir GitHub deposuna yükle
3. Adım 2A — Render ile yayınla (önerilen, kredi kartısız)
4. Adım 2B — Railway ile yayınla (alternatif)
5. Ortam değişkenleri (hepsi)
6. Build & Start komutları (özet tablo)
7. İlk giriş ve yayın sonrası kontrol listesi
8. Kendi alan adını (domain) bağlama
9. Sorun giderme

---

## 1) Ön hazırlık

İhtiyacın olanlar:
- Bir **GitHub** hesabı (ücretsiz).
- Bilgisayarında **Git** kurulu olması. Kontrol: terminalde `git --version`. Yoksa https://git-scm.com adresinden kur.
- Bir **Render** (https://render.com) **veya** **Railway** (https://railway.app) hesabı — ikisi de GitHub ile giriş yapılabilir.

> Not: Eski GitHub depon (`ataguclu1/assisttquizhaziran`) içinde 700 MB'lık gereksiz bir arşiv (`proje.zip`) Git LFS olarak duruyordu. O yüzden aşağıda **yeni ve temiz bir depo** açıyoruz; eski depo olduğu gibi kalır, istersen sonra silersin.

---

## 2) Adım 1 — Kodu temiz bir GitHub deposuna yükle

### 2.1. GitHub'da boş bir depo oluştur
1. https://github.com/new adresine git.
2. **Repository name:** örneğin `assistt-quiz`.
3. **Public** veya **Private** seç (ikisi de olur).
4. **Hiçbir kutuyu işaretleme** (README, .gitignore, license eklemeden — boş kalsın).
5. **Create repository**'e bas. Açılan sayfadaki `https://github.com/KULLANICI/assistt-quiz.git` adresini not et.

### 2.2. Bilgisayarında klasörü gönder
Bu proje klasörünün (`assisttquizhaziran`) içinde bir terminal aç ve sırayla çalıştır. `KULLANICI/assistt-quiz` kısmını kendi depo adresinle değiştir:

```bash
git init -b main
git add .
git commit -m "Temiz, Replit-bagimsiz surum"
git remote add origin https://github.com/KULLANICI/assistt-quiz.git
git push -u origin main
```

> Bu klasör zaten temizlendi: gereksiz arşivler ve eski şişkin Git geçmişi kaldırıldı, `.gitignore` `node_modules`, `.env` ve arşiv dosyalarını dışlıyor. Yani yüklenen depo birkaç MB olacak.

Tamamlandığında kodun GitHub'da görünür. Artık Render/Railway bu depoya bağlanabilir.

---

## 3) Adım 2A — Render ile yayınla (önerilen)

Projede hazır bir `render.yaml` var; Render hem web servisini hem de **ücretsiz PostgreSQL**'i otomatik kurar ve birbirine bağlar.

### Yol 1: Blueprint (otomatik — en kolay)
1. https://dashboard.render.com → **New +** → **Blueprint**.
2. GitHub hesabını bağla ve az önce oluşturduğun depoyu seç.
3. Render `render.yaml`'ı okur ve şunları gösterir: bir **Web Service** + bir **PostgreSQL** veritabanı. `JWT_SECRET`'i Render kendisi rastgele üretir.
4. **Apply / Create** de. Birkaç dakikada derlenir ve yayına alınır.
5. Web servisinin sayfasındaki `https://<isim>.onrender.com` adresi senin canlı linkin.

Bu yolda **build/start komutu yazmana gerek yok** — Docker imajı `Dockerfile`'dan otomatik derlenir ve başlatılır.

### Yol 2: Manuel (Docker ile)
Blueprint kullanmak istemezsen:
1. Önce veritabanı: **New +** → **PostgreSQL** → **Free** plan → **Create**. Oluşunca **Internal Database URL**'i kopyala.
2. **New +** → **Web Service** → depoyu seç.
3. Ayarlar:
   - **Language / Runtime:** `Docker`
   - **Dockerfile Path:** `./Dockerfile`
   - **Health Check Path:** `/api/healthz`
   - **Instance Type:** `Free`
4. **Environment** sekmesinde değişkenleri ekle (bkz. bölüm 5):
   - `DATABASE_URL` = (kopyaladığın Internal Database URL)
   - `JWT_SECRET` = uzun rastgele bir dize (bölüm 5'te nasıl üretileceği var)
   - `NODE_ENV` = `production`
5. **Create Web Service**. Derleme bitince link hazır.

> Render ücretsiz servis bir süre trafik almazsa uykuya geçer; ilk istek 30-50 sn gecikebilir. Bu normaldir.

---

## 4) Adım 2B — Railway ile yayınla (alternatif)

1. https://railway.app → **New Project** → **Deploy from GitHub repo** → depoyu seç.
2. Railway `Dockerfile`'ı otomatik algılar ve onunla derler (build/start `Dockerfile`'dan gelir).
3. Veritabanı ekle: proje içinde **New** → **Database** → **Add PostgreSQL**.
4. Servisin **Variables** sekmesine git ve ekle:
   - `DATABASE_URL` = `${{Postgres.DATABASE_URL}}` (Railway'in referans söz dizimi; Postgres servisinin URL'ini otomatik bağlar)
   - `JWT_SECRET` = uzun rastgele dize
   - `NODE_ENV` = `production`
5. Servisin **Settings → Networking** kısmında **Generate Domain** ile `https://<isim>.up.railway.app` adresini al.

> Railway dahili Postgres'e bağlanırken SSL hatası alırsan, `DATABASE_SSL` = `false` değişkenini ekle (bkz. sorun giderme).

---

## 5) Ortam değişkenleri (hepsi)

| Değişken | Zorunlu mu | Ne yazmalı |
|---|---|---|
| `DATABASE_URL` | Evet | Yönetilen PostgreSQL bağlantı adresi. Render'da veritabanının "Internal Database URL"i, Railway'de `${{Postgres.DATABASE_URL}}`. |
| `JWT_SECRET` | Evet (üretim) | Uzun rastgele dize. Boşsa sunucu **bilerek açılmaz** (güvenlik). Render Blueprint bunu otomatik üretir. |
| `NODE_ENV` | Evet | `production` |
| `PORT` | Hayır | Render/Railway otomatik verir; elle ayarlama. |
| `DATABASE_SSL` | Hayır | Yönetilen DB'lerde boş bırak (SSL otomatik açılır). Sadece SSL'siz/yerel DB'de `false` yap. |
| `OPENAI_API_KEY` | Hayır | AI ile soru üretme/asistan özelliği için. Boşsa diğer her şey çalışır. |

**JWT_SECRET üretme** (bilgisayarında bir terminalde):
```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```
Çıkan uzun metni `JWT_SECRET` değerine yapıştır.

---

## 6) Build & Start komutları (özet)

**Docker kullanıyorsan (Render Blueprint/Docker, Railway):** komut yazmana gerek yok — `Dockerfile` derlemeyi ve başlatmayı yapar:
- Build: `docker build` (otomatik), içinde frontend + API derlenir.
- Start: `node --enable-source-maps dist/index.mjs` (Dockerfile `CMD`).

**Docker'sız (Node ortamı; örn. Railway Nixpacks veya Render "Node") seçersen** şunları gir:

- **Build Command:**
  ```bash
  corepack enable && pnpm install --no-frozen-lockfile && pnpm --filter @workspace/quiz run build && pnpm --filter @workspace/api-server run build
  ```
- **Start Command:**
  ```bash
  pnpm --filter @workspace/api-server start
  ```
- Ek ortam değişkeni: `NODE_VERSION` = `24` (Node 24 şart).

---

## 7) İlk giriş ve yayın sonrası kontrol listesi

Yayına alındıktan sonra:
1. Canlı adresi aç (`https://...onrender.com` / `...railway.app`). Giriş ekranı gelmeli.
2. **Yönetici girişi:** Sicil `A053252`, Şifre `admin123`.
3. Girişten sonra **şifreyi panelden değiştir** (yeni şifre veritabanında saklanır).
4. Normal kullanıcıları admin panelinden ekle.
5. Sağlık kontrolü: `https://ADRES/api/healthz` → `{"status":"ok"}` dönmeli.

> İlk açılışta veritabanı tabloları **otomatik oluşturulur** (`ensureSchema`), ayrıca migration çalıştırmana gerek yoktur.

---

## 8) Kendi alan adını (domain) bağlama

**Ücretsiz alt alan adı:** Hem Render (`onrender.com`) hem Railway (`up.railway.app`) ücretsiz bir adresi otomatik verir; hiçbir şey yapmana gerek yok.

**Kendi alan adın varsa (örn. `quiz.firmam.com`):**
- **Render:** Web Service → **Settings → Custom Domains → Add Custom Domain** → alan adını yaz. Render sana bir CNAME kaydı verir; onu alan adı sağlayıcının (GoDaddy, Cloudflare, Namecheap...) DNS panelinde ekle. SSL sertifikasını Render otomatik üretir.
- **Railway:** Service → **Settings → Networking → Custom Domain** → alan adını yaz → verilen CNAME'i DNS'ine ekle.

DNS yayılması birkaç dakika–birkaç saat sürebilir; sonra `https://` otomatik aktif olur.

---

## 9) Sorun giderme

**Giriş yaparken 500 hatası / sayfa açılıyor ama login olmuyor**
- `DATABASE_URL` doğru mu? Render'da DB ve web servisi aynı projede mi?
- Servisin **Logs** sekmesine bak. Artık hatalar açıkça loglanıyor:
  - `ensureSchema failed — database unreachable...` → DB adresi/erişimi yanlış.
  - SSL ile ilgili hata → `DATABASE_SSL` = `false` deneyip tekrar dağıt (özellikle Railway dahili DB'de).

**`JWT_SECRET ... required in production` hatasıyla açılmıyor**
- `JWT_SECRET` ortam değişkenini eklemeyi unutmuşsun. Bölüm 5'teki komutla üret, ekle, yeniden dağıt.

**Build (derleme) başarısız**
- Docker yolunda genelde sorunsuzdur. Docker'sız Node yolundaysan `NODE_VERSION=24` eklediğinden ve build komutunu tam yazdığından emin ol (bölüm 6).

**Push sırasında "large file / LFS" uyarısı**
- Yeni boş bir depoya gönderdiğinden emin ol (bölüm 2). Temizlenen klasörde büyük dosya kalmadı; uyarı alırsan büyük dosyanın gerçekten silindiğini `git status` ile kontrol et.

**AI özellikleri çalışmıyor**
- `OPENAI_API_KEY` ekli değilse normaldir; sadece AI dışı özellikler çalışır. Anahtarı eklersen aktifleşir.
