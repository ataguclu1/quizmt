import { Router } from "express";
import { Readable } from "node:stream";
import { logger } from "../lib/logger";

const router = Router();

// Broad allowlist — covers major Turkish & international radio CDNs
const ALLOWED_PATTERNS = [
  "trt.com.tr", "live.trt", "nts.live", "somafm.com",
  "streamtheworld.com", "radyod.com", "powerapp.com.tr",
  "bestfm", "kralmuzik", "ntvradyo", "joytv.com.tr",
  "shoutcast", "icecast", "listen.", "stream.", "live.", ".fm/",
  "akamaihd.net", "akamai", "cdn.", "prod.", "radio",
];

function isAllowed(url: string): boolean {
  try {
    const { hostname, pathname } = new URL(url);
    return ALLOWED_PATTERNS.some(p => hostname.includes(p) || pathname.includes(p));
  } catch { return false; }
}

// Rewrite a relative URL to absolute based on a base URL
function toAbsolute(href: string, base: string): string {
  if (href.startsWith("http")) return href;
  return new URL(href, base).href;
}

// Proxy a single audio stream (MP3/AAC/TS segment)
async function pipeStream(url: string, req: import("express").Request, res: import("express").Response): Promise<void> {
  const ctrl = new AbortController();
  req.on("close", () => ctrl.abort());

  const upstream = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      "Icy-MetaData": "0",
      ...(req.headers["range"] ? { "Range": req.headers["range"] as string } : {}),
    },
    signal: ctrl.signal,
  });

  if (!upstream.ok || !upstream.body) {
    res.status(upstream.status || 502).end();
    return;
  }

  const ct = upstream.headers.get("content-type") || "audio/mpeg";
  res.setHeader("Content-Type", ct);
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("X-Accel-Buffering", "no");

  const nodeStream = Readable.fromWeb(upstream.body as Parameters<typeof Readable.fromWeb>[0]);
  nodeStream.pipe(res);
  nodeStream.on("error", () => { if (!res.headersSent) res.end(); });
}

router.get("/stream", async (req, res) => {
  const url = req.query.url as string;
  if (!url) { res.status(400).json({ error: "url gerekli" }); return; }
  if (!isAllowed(url)) {
    logger.warn({ url }, "Radio proxy: domain not allowed");
    res.status(403).json({ error: "domain izin listesinde değil" }); return;
  }

  try {
    const ctrl = new AbortController();
    req.on("close", () => ctrl.abort());

    const upstream = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Icy-MetaData": "0",
      },
      signal: ctrl.signal,
    });

    if (!upstream.ok || !upstream.body) {
      res.status(upstream.status || 502).end(); return;
    }

    const ct = upstream.headers.get("content-type") || "audio/mpeg";

    // ── HLS manifest: rewrite segment/playlist URLs to go through our proxy ──
    if (ct.includes("mpegurl") || ct.includes("x-mpegurl") || url.includes(".m3u8")) {
      const text = await upstream.text();
      const base = url;
      const proxyBase = "/api/radio/stream?url=";

      const rewritten = text.split("\n").map(line => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) return line;
        // It's a media segment or child playlist URI
        const absUrl = toAbsolute(trimmed, base);
        return proxyBase + encodeURIComponent(absUrl);
      }).join("\n");

      res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Cache-Control", "no-cache");
      res.send(rewritten);
      return;
    }

    // ── Regular audio stream: pipe directly ──
    res.setHeader("Content-Type", ct);
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("X-Accel-Buffering", "no");

    const nodeStream = Readable.fromWeb(upstream.body as Parameters<typeof Readable.fromWeb>[0]);
    nodeStream.pipe(res);
    nodeStream.on("error", () => { if (!res.headersSent) res.end(); });

  } catch (e: unknown) {
    if (!res.headersSent) res.status(502).json({ error: "upstream bağlantı hatası" });
  }
});

export default router;
