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
import { timingSafeEqual } from "node:crypto";
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

async function renderSlide(browser, generator, slide, ctx) {
  const context = await browser.newContext({ viewport: { width: ctx.width, height: ctx.height }, deviceScaleFactor: 1, offline: true });
  const timer = setTimeout(() => { context.close().catch(() => undefined); }, SLIDE_TIMEOUT_MS);
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
    const png = await page.screenshot({ type: "png", clip: { x: 0, y: 0, width: ctx.width, height: ctx.height } });
    return png.toString("base64");
  } finally {
    clearTimeout(timer);
    await context.close().catch(() => undefined);
  }
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

export function createServer() {
  return http.createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/health") return send(response, 200, { ok: true, active: jobs.active, waiting: jobs.waiting });
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
