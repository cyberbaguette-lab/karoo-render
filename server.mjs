// karoo-render : rejoue un generateur Express (code ecrit par l'IA) dans une
// page Chromium isolee et renvoie une image PNG par slide.
//
// Securite (voir README.md) :
// - le generateur ne s'execute QUE dans la page, jamais dans Node ;
// - la page est hors ligne : toute requete reseau est refusee (data:/blob: seuls) ;
// - le service ne detient aucun secret de Karoo, seulement RENDER_TOKEN ;
// - une page neuve par slide, fermee apres la capture, avec un delai maximal.
//
// Contrat d'un generateur : src/lib/express/contract.ts dans Karoo.
//   window.KAROO_GENERATOR = { blocks: {...}, render(root, slide, ctx) {...} }

import http from "node:http";
import { spawn } from "node:child_process";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";

const PORT = Number(process.env.PORT ?? 4000);
const TOKEN = process.env.RENDER_TOKEN ?? "";
const MAX_SLIDES = 20;
const MAX_BODY = 30 * 1024 * 1024;
const MAX_GENERATOR = 3 * 1024 * 1024;
const SLIDE_TIMEOUT_MS = Number(process.env.RENDER_SLIDE_TIMEOUT_MS ?? 15000);
// Charge : au plus RENDER_MAX_JOBS demandes rendues a la fois, RENDER_MAX_QUEUE
// en attente (au-dela : 503, le site reessaie ou passe par l'agent), et
// RENDER_SLIDE_CONCURRENCY pages Chromium ouvertes par demande.
const MAX_JOBS = Math.max(1, Number(process.env.RENDER_MAX_JOBS ?? 2));
const MAX_QUEUE = Math.max(0, Number(process.env.RENDER_MAX_QUEUE ?? 6));
const SLIDE_CONCURRENCY = Math.max(1, Number(process.env.RENDER_SLIDE_CONCURRENCY ?? 4));
const SIZES = { carrousel: { width: 1080, height: 1350 }, story: { width: 1080, height: 1920 } };
// Stories animees : une video par ecran (images figees une a une, puis ffmpeg).
// Plus lourd qu'un PNG : moins de demandes a la fois, moins d'ecrans en parallele.
const VIDEO_FPS = Math.min(60, Math.max(12, Number(process.env.RENDER_VIDEO_FPS ?? 30)));
const VIDEO_MAX_JOBS = Math.max(1, Number(process.env.RENDER_VIDEO_MAX_JOBS ?? 1));
const VIDEO_CONCURRENCY = Math.max(1, Number(process.env.RENDER_VIDEO_CONCURRENCY ?? 2));
const VIDEO_TIMEOUT_MS = Number(process.env.RENDER_VIDEO_TIMEOUT_MS ?? 120000);
const MAX_VIDEO_MS = 15000;
const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";

// ------------------------------------------------------------- navigateur
// Demarre avec le service (jamais a la premiere requete) et se relance seul.
let browserReady = null;
function getBrowser() {
  if (!browserReady) {
    browserReady = chromium.launch({
      executablePath: process.env.CHROMIUM_PATH || undefined,
      // Bac a sable de Chromium : actif si l'hote le permet (CHROMIUM_SANDBOX=1,
      // utilisateur non root et espaces de noms disponibles). Sans lui, le
      // conteneur tourne sous un utilisateur sans droits (Dockerfile).
      chromiumSandbox: process.env.CHROMIUM_SANDBOX === "1",
      args: [
        "--disable-dev-shm-usage",
        "--font-render-hinting=none",
        // Pas de WebRTC vers l'exterieur : la seule sortie reseau qu'une page
        // hors ligne pourrait encore tenter (UDP, STUN).
        "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
        "--webrtc-ip-handling-policy=disable_non_proxied_udp",
        "--disable-features=WebRtcHideLocalIpsWithMdns"
      ]
    }).then((browser) => {
      browser.on("disconnected", () => { browserReady = null; });
      return browser;
    }, (error) => {
      browserReady = null;
      throw error;
    });
  }
  return browserReady;
}

/** Ferme Chromium (arret du service, fin des tests). */
export async function shutdown() {
  const pending = browserReady;
  browserReady = null;
  if (pending) await pending.then((browser) => browser.close(), () => undefined);
}

// ------------------------------------------------------------- charge
/** Un compteur de places : `run` attend une place libre, `null` si la file est pleine. */
export function limiter(max, queueMax) {
  let active = 0;
  const waiting = [];
  const release = () => {
    active -= 1;
    const next = waiting.shift();
    if (next) { active += 1; next(); }
  };
  return {
    get active() { return active; },
    get waiting() { return waiting.length; },
    async run(task) {
      if (active >= max) {
        if (waiting.length >= queueMax) return null;
        await new Promise((resolve) => waiting.push(resolve));
      } else {
        active += 1;
      }
      try { return { value: await task() }; } finally { release(); }
    }
  };
}

const jobs = limiter(MAX_JOBS, MAX_QUEUE);
const videoJobs = limiter(VIDEO_MAX_JOBS, MAX_QUEUE);

/** `fn` sur chaque element, `size` a la fois au plus ; ordre conserve. */
async function mapPool(items, size, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      try { out[index] = { status: "fulfilled", value: await fn(items[index], index) }; } catch (reason) { out[index] = { status: "rejected", reason }; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker));
  return out;
}

// ------------------------------------------------------------- entrees
const MAX_TEXT = 600;
const MAX_ITEMS = 8;
const MAX_AVATAR = 400_000;

/** Les champs d'une slide : chaines, listes de chaines, nombres, booleens,
 *  et `photo` en data URL d'image. Rien d'executable, tout borne. */
export function cleanSlide(raw) {
  const slide = {};
  if (!raw || typeof raw !== "object") return { layout: null };
  for (const [key, value] of Object.entries(raw).slice(0, 24)) {
    if (!/^[a-zA-Z][a-zA-Z0-9_]{0,39}$/.test(key)) continue;
    if (key === "photo") {
      if (typeof value === "string" && /^data:image\/(png|jpeg|webp);base64,/.test(value)) slide.photo = value;
      continue;
    }
    // Avatar du compte (photo de profil Instagram), pose par Karoo : une image, 300 Ko au plus.
    if (key === "karooAvatar") {
      if (typeof value === "string" && value.length <= MAX_AVATAR && /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(value)) slide.karooAvatar = value;
      continue;
    }
    // Story animee : un calque pose par-dessus chaque image (le filigrane), une image PNG.
    if (key === "karooOverlay") {
      if (typeof value === "string" && value.length <= MAX_AVATAR && /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(value)) slide.karooOverlay = value;
      continue;
    }
    // Story animee : l'animation (motion.ts dans Karoo), un mot-cle, jamais du code.
    if (key === "karooMotion") {
      if (typeof value === "string" && /^[a-z]{2,16}$/.test(value)) slide.karooMotion = value;
      continue;
    }
    if (typeof value === "string") slide[key] = value.slice(0, MAX_TEXT);
    else if (typeof value === "number" && Number.isFinite(value)) slide[key] = value;
    else if (typeof value === "boolean") slide[key] = value;
    else if (Array.isArray(value)) slide[key] = value.slice(0, MAX_ITEMS).filter((item) => typeof item === "string").map((item) => item.slice(0, MAX_TEXT));
  }
  if (typeof slide.layout !== "string") slide.layout = null;
  return slide;
}

export function cleanBrand(raw) {
  const name = typeof raw?.name === "string" ? raw.name.slice(0, 60) : "";
  const accent = typeof raw?.accent === "string" && /^#[0-9a-fA-F]{3,8}$/.test(raw.accent) ? raw.accent : null;
  return { name, accent };
}

function authorized(header) {
  if (!TOKEN) return false;
  const expected = Buffer.from(`Bearer ${TOKEN}`);
  const given = Buffer.from(String(header ?? ""));
  return given.length === expected.length && timingSafeEqual(given, expected);
}

// ------------------------------------------------------------- rendu
const SHELL = (width, height) => `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0;width:${width}px;height:${height}px;overflow:hidden;background:#fff}#slide{position:relative;width:100%;height:100%;overflow:hidden}</style></head><body><div id="slide"></div></body></html>`;

/** Une page hors ligne avec l'ecran rendu par le generateur ; `context` a fermer par l'appelant. */
async function openSlide(browser, generator, slide, ctx) {
  const context = await browser.newContext({ viewport: { width: ctx.width, height: ctx.height }, deviceScaleFactor: 1, offline: true });
  try {
    // Aucune API reseau temps reel dans la page, avant tout script.
    await context.addInitScript(() => {
      for (const name of ["RTCPeerConnection", "webkitRTCPeerConnection", "RTCDataChannel", "WebSocket", "EventSource", "WebTransport"]) {
        try { Object.defineProperty(window, name, { value: undefined, configurable: false, writable: false }); } catch { /* deja absente */ }
      }
    });
    await context.route("**/*", (route) => {
      const url = route.request().url();
      return url.startsWith("data:") || url.startsWith("blob:") ? route.continue() : route.abort();
    });
    const page = await context.newPage();
    await page.setContent(SHELL(ctx.width, ctx.height));
    await page.addScriptTag({ content: generator });
    const error = await page.evaluate(async ({ slide, ctx }) => {
      try {
        const generator = window.KAROO_GENERATOR;
        if (!generator || typeof generator.render !== "function") return "KAROO_GENERATOR.render absent";
        await generator.render(document.getElementById("slide"), slide, ctx);
        await document.fonts.ready;
        await Promise.all([...document.images].map((img) => (img.complete ? null : new Promise((done) => { img.onload = img.onerror = done; }))));
        return null;
      } catch (err) {
        return String(err && err.message ? err.message : err).slice(0, 300);
      }
    }, { slide, ctx });
    if (error) throw new Error(`generateur : ${error}`);
    return { context, page };
  } catch (error) {
    await context.close().catch(() => undefined);
    throw error;
  }
}

async function renderSlide(browser, generator, slide, ctx) {
  let context = null;
  const timer = setTimeout(() => { context?.close().catch(() => undefined); }, SLIDE_TIMEOUT_MS);
  try {
    const opened = await openSlide(browser, generator, slide, ctx);
    context = opened.context;
    const png = await opened.page.screenshot({ type: "png", clip: { x: 0, y: 0, width: ctx.width, height: ctx.height } });
    return png.toString("base64");
  } finally {
    clearTimeout(timer);
    await context?.close().catch(() => undefined);
  }
}

/** Une adresse de depot signee (Supabase Storage) : https seulement. */
export function cleanUpload(raw) {
  if (typeof raw !== "string" || raw.length > 2000) return null;
  try {
    const url = new URL(raw);
    // http : seulement pour les tests locaux (RENDER_UPLOAD_INSECURE=1).
    const scheme = url.protocol === "https:" || (process.env.RENDER_UPLOAD_INSECURE === "1" && url.protocol === "http:");
    return scheme && !url.username && !url.password ? url.toString() : null;
  } catch {
    return null;
  }
}

/** Les images JPEG d'une animation, une par une, passees a ffmpeg : un MP4 (H.264, son muet, lecture rapide). */
async function encodeVideo(frames, fps) {
  // Un fichier (le MP4 « faststart » se reecrit a la fin), lu puis efface.
  const file = join(tmpdir(), `karoo-${randomUUID()}.mp4`);
  try {
    await runFfmpeg(frames, fps, file);
    return await readFile(file);
  } finally {
    await rm(file, { force: true }).catch(() => undefined);
  }
}

function runFfmpeg(frames, fps, file) {
  return new Promise((resolve, reject) => {
    const args = [
      "-hide_banner", "-loglevel", "error",
      "-f", "image2pipe", "-framerate", String(fps), "-c:v", "mjpeg", "-i", "pipe:0",
      "-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=44100",
      "-shortest", "-map", "0:v", "-map", "1:a",
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "21", "-pix_fmt", "yuv420p", "-profile:v", "high", "-level", "4.1", "-r", String(fps),
      "-c:a", "aac", "-b:a", "96k",
      "-movflags", "+faststart", "-f", "mp4", "-y", file
    ];
    const child = spawn(FFMPEG, args, { stdio: ["pipe", "pipe", "pipe"] });
    let err = "";
    child.stdout.resume();
    child.stderr.on("data", (chunk) => { err += chunk.toString().slice(0, 500); });
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg ${code} : ${err.slice(0, 200)}`))));
    child.stdin.on("error", () => undefined);
    (async () => {
      for await (const frame of frames) {
        if (!child.stdin.write(frame)) await new Promise((done) => child.stdin.once("drain", done));
      }
      child.stdin.end();
    })().catch((error) => { child.kill("SIGKILL"); reject(error); });
  });
}

/**
 * Un ecran anime : le generateur (et son script d'animation) rend l'ecran,
 * puis chaque image est figee a son instant (window.KAROO_MOTION.seek) et
 * capturee. Rend le MP4 et sa duree.
 */
async function renderVideo(browser, generator, slide, ctx, fps) {
  let context = null;
  const timer = setTimeout(() => { context?.close().catch(() => undefined); }, VIDEO_TIMEOUT_MS);
  try {
    const opened = await openSlide(browser, generator, slide, ctx);
    context = opened.context;
    const page = opened.page;
    const duration = await page.evaluate(() => (window.KAROO_MOTION && typeof window.KAROO_MOTION.duration === "number" ? window.KAROO_MOTION.duration : 0));
    if (!(duration > 0)) throw new Error("animation absente");
    const ms = Math.min(MAX_VIDEO_MS, duration);
    const count = Math.max(1, Math.round((ms / 1000) * fps));
    const cdp = await context.newCDPSession(page);
    async function* frames() {
      for (let index = 0; index < count; index += 1) {
        await page.evaluate((t) => window.KAROO_MOTION.seek(t), (index * 1000) / fps);
        const shot = await cdp.send("Page.captureScreenshot", { format: "jpeg", quality: 90, optimizeForSpeed: true, captureBeyondViewport: false, clip: { x: 0, y: 0, width: ctx.width, height: ctx.height, scale: 1 } });
        yield Buffer.from(shot.data, "base64");
      }
    }
    const mp4 = await encodeVideo(frames(), fps);
    return { mp4, ms: Math.round((count * 1000) / fps) };
  } finally {
    clearTimeout(timer);
    await context?.close().catch(() => undefined);
  }
}

/** Depose le MP4 a l'adresse signee (Supabase Storage, PUT). */
async function upload(url, mp4) {
  const response = await fetch(url, { method: "PUT", headers: { "content-type": "video/mp4", "x-upsert": "true", "cache-control": "max-age=3600" }, body: mp4, signal: AbortSignal.timeout(60000) });
  if (!response.ok) throw new Error(`depot : HTTP ${response.status}`);
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) { reject(new Error("corps trop gros")); request.destroy(); return; }
      chunks.push(chunk);
    });
    request.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch { reject(new Error("JSON invalide")); }
    });
    request.on("error", reject);
  });
}

function send(response, status, body) {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}

/**
 * POST /render-video : une video par ecran, deposee a l'adresse signee de cet
 * ecran (`uploads[i]`). Reponse legere : duree et taille de chaque video.
 */
async function handleVideo(request, response) {
  if (!authorized(request.headers.authorization)) return send(response, 401, { error: "non autorise" });
  const started = Date.now();
  try {
    const input = await readJson(request);
    if (typeof input.generator !== "string" || input.generator.length === 0 || input.generator.length > MAX_GENERATOR) {
      return send(response, 400, { error: "generateur invalide" });
    }
    if (!Array.isArray(input.slides) || input.slides.length === 0 || input.slides.length > MAX_SLIDES) return send(response, 400, { error: "slides invalides" });
    const uploads = Array.isArray(input.uploads) ? input.uploads.map(cleanUpload) : [];
    if (uploads.length !== input.slides.length || uploads.some((url) => url === null)) return send(response, 400, { error: "depots invalides" });
    const slides = input.slides.map(cleanSlide);
    if (slides.some((slide) => !slide.karooMotion)) return send(response, 400, { error: "animation manquante" });
    const size = SIZES[input.format] ?? SIZES.story;
    const brand = cleanBrand(input.brand);
    const total = slides.length;
    const job = await videoJobs.run(async () => {
      const browser = await getBrowser();
      return mapPool(slides, VIDEO_CONCURRENCY, async (slide, index) => {
        const t0 = Date.now();
        const video = await renderVideo(browser, input.generator, slide, { index, total, ...size, brand }, VIDEO_FPS);
        await upload(uploads[index], video.mp4);
        return { index, duration: video.ms, bytes: video.mp4.length, ms: Date.now() - t0 };
      });
    });
    if (!job) return send(response, 503, { error: "service occupe, reessaie" });
    const failed = job.value.find((result) => result.status === "rejected");
    if (failed) return send(response, 422, { error: String(failed.reason?.message ?? failed.reason).slice(0, 300) });
    send(response, 200, { ms: Date.now() - started, fps: VIDEO_FPS, width: size.width, height: size.height, videos: job.value.map((result) => result.value) });
  } catch (error) {
    send(response, 500, { error: String(error?.message ?? error).slice(0, 300) });
  }
}

export function createServer() {
  return http.createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/health") return send(response, 200, { ok: true, active: jobs.active, waiting: jobs.waiting, videos: { active: videoJobs.active, waiting: videoJobs.waiting } });
    if (request.method === "POST" && request.url === "/render-video") return handleVideo(request, response);
    if (request.method !== "POST" || request.url !== "/render") return send(response, 404, { error: "introuvable" });
    if (!authorized(request.headers.authorization)) return send(response, 401, { error: "non autorise" });

    const started = Date.now();
    try {
      const input = await readJson(request);
      if (typeof input.generator !== "string" || input.generator.length === 0 || input.generator.length > MAX_GENERATOR) {
        return send(response, 400, { error: "generateur invalide" });
      }
      if (!Array.isArray(input.slides) || input.slides.length === 0 || input.slides.length > MAX_SLIDES) {
        return send(response, 400, { error: "slides invalides" });
      }
      const size = SIZES[input.format] ?? SIZES.carrousel;
      const brand = cleanBrand(input.brand);
      const total = input.slides.length;
      const job = await jobs.run(async () => {
        const browser = await getBrowser();
        return mapPool(input.slides, SLIDE_CONCURRENCY, async (raw, index) => {
          const t0 = Date.now();
          const png = await renderSlide(browser, input.generator, cleanSlide(raw), { index, total, ...size, brand });
          return { index, png, ms: Date.now() - t0 };
        });
      });
      if (!job) return send(response, 503, { error: "service occupe, reessaie" });
      const results = job.value;
      const failed = results.find((result) => result.status === "rejected");
      if (failed) return send(response, 422, { error: String(failed.reason?.message ?? failed.reason).slice(0, 300) });
      send(response, 200, { ms: Date.now() - started, width: size.width, height: size.height, slides: results.map((result) => result.value) });
    } catch (error) {
      send(response, 500, { error: String(error?.message ?? error).slice(0, 300) });
    }
  });
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  getBrowser().catch((error) => console.error("[karoo-render] Chromium indisponible :", error.message));
  createServer().listen(PORT, "0.0.0.0", () => console.log(`[karoo-render] pret sur :${PORT}`));
}
