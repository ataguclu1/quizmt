import { Router } from "express";
import { Readable } from "node:stream";
import { isIP } from "node:net";
import { logger } from "../lib/logger";

const router = Router();

/**
 * ============================================================================
 * GÜVENLİK DÜZELTMESİ — SSRF (Server-Side Request Forgery)
 * ============================================================================
 * Önceki izin listesi hem çok genişti hem de YOLU (pathname) da kontrol
 * ediyordu. "radio", "cdn.", "live.", "stream." gibi parçaların URL'in
 * HERHANGİ bir yerinde geçmesi yeterliydi. Sonuç: uç nokta, kimlik doğrulaması
 * da olmadığı için, internetteki herhangi birinin sunucuyu bir vekil (proxy)
 * gibi kullanmasına izin veriyordu — sonu "/radio" ile biten bir iç ağ adresi
 * bile bu kontrolden geçiyordu.
 *
 * Yeni kurallar:
 *   1) Yalnızca http/https şeması.
 *   2) Adres doğrudan bir IP olamaz (iç ağ ve bulut metadata adreslerini keser).
 *   3) Alan adı, aşağıdaki listedeki bir alan adı ya da onun alt alan adı olmalı.
 *      Yol (pathname) artık hiçbir şekilde izin gerekçesi değildir.
 * Yeni bir radyo eklenecekse alan adı bu listeye eklenmelidir.
 *
 * ÖNERİLEN EK ADIM: Radyo yalnızca giriş yapmış kullanıcılar tarafından
 * kullanılıyorsa, aşağıdaki satıra `requireAuth` eklenmesi bu uç noktayı
 * tamamen kapatır:  router.get("/stream", requireAuth, async (req, res) => {
 * Bu, ses etiketiyle (<audio src=...>) doğrudan çalınan bir kullanım varsa
 * onu bozacağı için bilinçli olarak eklenmedi.
 * ============================================================================
 */
const ALLOWED_HOSTS = [
  "trt.com.tr", "trtdinle.com", "radyotrt.com.tr",
  "streamtheworld.com", "akamaihd.net", "akamaized.net", "cloudfront.net",
  "somafm.com", "nts.live",
  "powerapp.com.tr", "kralmuzik.com.tr", "joytv.com.tr", "radyod.com",
  "ntv.com.tr", "bestfm.fm", "radyofenomen.com",
  // Arayüzdeki istasyon listesinde geçen alan adları (bugün doğrudan
  // tarayıcıdan çalınıyor; vekil yeniden devreye alınırsa çalışsınlar diye).
  "radyotvonline.net", "duhnet.tv",
];

function isAllowed(url: string): boolean {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return false; }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;

  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  // Doğrudan IP adresi verilmesini engelle (127.0.0.1, 169.254.169.254, 10.x …).
  if (isIP(host) !== 0) return false;

  return ALLOWED_HOSTS.some((allowed) => host === allowed || host.endsWith("." + allowed));
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
    logger.warn({ url }, "Radio proxy: adres izin listesinde değil (SSRF denemesi olabilir)");
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
