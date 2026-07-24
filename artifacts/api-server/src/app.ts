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
// Varsayılan limit (100kb) sesli soru özelliğiyle yetersiz kalıyordu: bir
// soru setini kütüphaneye kaydetme isteği, ElevenLabs'ten üretilen base64
// ses verisini (soru başına ~150-500KB) de taşıyor. Tek bir sesli soru bile
// varsayılan limiti aşıp kaydı "413 Payload Too Large" ile sessizce
// başarısız kılabilirdi.
app.use(express.json({ limit: "25mb" }));
app.use(express.urlencoded({ extended: true, limit: "25mb" }));

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
