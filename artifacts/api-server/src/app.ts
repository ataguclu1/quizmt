import express, {
  type Express,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import router from "./routes";
import { logger } from "./lib/logger";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app: Express = express();

// Render (ve genel olarak çoğu bulut barındırma), uygulamayı bir proxy/load
// balancer'ın arkasında çalıştırır — gerçek istemci IP'si bu proxy
// tarafından X-Forwarded-For header'ına yazılır. Bu ayar olmadan
// express-rate-limit, hangi IP'ye güveneceğini bilemediği için
// "ERR_ERL_UNEXPECTED_X_FORWARDED_FOR" hatasıyla isteği reddediyordu —
// bu da örneğin giriş denemelerinin sunucu hatasıyla başarısız olmasına yol
// açıyordu. `1` değeri "en yakındaki bir proxy'ye güven" anlamına gelir ve
// Render'ın tek katmanlı proxy yapısı için doğru, güvenli ayardır.
app.set("trust proxy", 1);

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(cors());

// ── Güvenlik başlıkları ────────────────────────────────────────────────────
// Ek bir bağımlılık gerektirmeyen, tarayıcı tarafındaki temel korumalar:
// içerik türü tahminini kapatır, sayfanın başka bir sitenin çerçevesine
// gömülmesini (clickjacking) engeller ve dış sitelere gönderilen referrer
// bilgisini sınırlar. Not: içerik güvenliği politikası (CSP) bilinçli olarak
// eklenmedi — uygulamayla birlikte test edilmeden eklenmesi arayüzü bozabilir.
app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "geolocation=(), camera=(), microphone=()");
  next();
});

// ── İstek gövdesi limitleri ────────────────────────────────────────────────
// GÜVENLİK DÜZELTMESİ: Önceden 25 MB'lık limit TÜM uç noktalara uygulanıyordu
// — kimlik doğrulaması olmayan giriş uç noktası dahil. Bu, tek bir istekle
// sunucu belleğini zorlamayı (hizmet dışı bırakma) kolaylaştırıyordu. Artık
// varsayılan 1 MB; büyük gövdeye gerçekten ihtiyaç duyan iki uç nokta ailesi
// (sesli soru içeren soru setleri ve yapay zekâ istekleri) için ayrıca
// tanımlanıyor.
const largeJson = express.json({ limit: "25mb" });
app.use("/api/question-sets", largeJson);
app.use("/api/ai", largeJson);
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true, limit: "1mb" }));

app.use("/api", router);

// ── Production: serve the quiz frontend ────────────────────────────────────
// In dev, Vite handles the frontend on its own port via the reverse proxy.
// In production (NODE_ENV=production), the API server also serves the quiz UI.
if (process.env["NODE_ENV"] === "production") {
  // Path from dist/index.mjs → ../../quiz (the monorepo quiz artifact)
  const quizPublic = path.resolve(__dirname, "../../quiz/dist/public");
  const quizHtml   = path.resolve(__dirname, "../../quiz/index.html");

  // Serve compiled Vite assets if available, otherwise fall back to raw HTML
  app.use(express.static(quizPublic, { index: "index.html" }));
  app.use(express.static(path.resolve(__dirname, "../../quiz"), { index: "index.html" }));

  // SPA catch-all — send the quiz HTML for any non-API route
  app.get(/^(?!\/api).*/, (_req, res) => {
    const compiled = path.join(quizPublic, "index.html");
    res.sendFile(existsSync(compiled) ? compiled : quizHtml);
  });
}

// ── Global error handler ────────────────────────────────────────────────────
// Express forwards any thrown/rejected error from a route here. Without it, a
// failure (e.g. a DB error during login) surfaces as an opaque 500 with nothing
// in the logs. This logs the real cause and returns a clean JSON response.
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  logger.error({ err }, "Unhandled request error");
  if (res.headersSent) return;
  res.status(500).json({ error: "Sunucu hatası. Lütfen daha sonra tekrar deneyin." });
});

export default app;
