// Tests du service : jeton, rendu de reference, isolation reseau.
// Chromium : celui de l'image (Docker) ou CHROMIUM_PATH en local.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

process.env.RENDER_TOKEN = "test-token";
const { createServer, cleanSlide, cleanBrand, limiter, shutdown } = await import("../server.mjs");
const reference = fs.readFileSync(new URL("../generators/reference-modulaire.js", import.meta.url), "utf8");

let server;
let base;
before(async () => {
  server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await shutdown();
});

const post = (body, token = "test-token") => fetch(`${base}/render`, {
  method: "POST",
  headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
  body: JSON.stringify(body)
});

test("sans le bon jeton : 401", async () => {
  assert.equal((await post({ generator: reference, slides: [{}] }, null)).status, 401);
  assert.equal((await post({ generator: reference, slides: [{}] }, "faux")).status, 401);
});

test("entrees invalides : 400", async () => {
  assert.equal((await post({ generator: "", slides: [{}] })).status, 400);
  assert.equal((await post({ generator: reference, slides: [] })).status, 400);
  assert.equal((await post({ generator: reference, slides: new Array(21).fill({}) })).status, 400);
});

test("rendu de reference : une image PNG par slide, au format demande", async () => {
  const response = await post({
    format: "carrousel",
    brand: { name: "Karoo", accent: "#5fd4f4" },
    generator: reference,
    slides: [
      { layout: "couverture", title: "Un titre", accent: "et sa chute." },
      { layout: "liste", title: "Trois points", items: ["Un", "Deux", "Trois"] },
      { layout: "appel", title: "Et toi ?", body: "Dis-le en commentaire" }
    ]
  });
  assert.equal(response.status, 200);
  const out = await response.json();
  assert.equal(out.slides.length, 3);
  assert.equal(out.width, 1080);
  assert.equal(out.height, 1350);
  for (const slide of out.slides) {
    const png = Buffer.from(slide.png, "base64");
    assert.equal(png.subarray(1, 4).toString(), "PNG");
  }
});

test("isolation : un generateur hostile n'atteint ni le reseau ni Node", async () => {
  const hostile = `window.KAROO_GENERATOR = { async render() {
    const out = [];
    try { await fetch("https://example.com/vol"); out.push("fetch:PASSE"); } catch { out.push("fetch:bloque"); }
    const img = new Image(); img.src = "https://example.com/p.png";
    await new Promise((done) => { img.onload = () => { out.push("image:PASSE"); done(); }; img.onerror = () => { out.push("image:bloquee"); done(); }; });
    out.push("process:" + typeof process, "require:" + typeof require);
    out.push("rtc:" + typeof window.RTCPeerConnection, "ws:" + typeof window.WebSocket);
    throw new Error(out.join(" "));
  } };`;
  const response = await post({ generator: hostile, slides: [{ title: "x" }] });
  assert.equal(response.status, 422);
  const { error } = await response.json();
  assert.match(error, /fetch:bloque/);
  assert.match(error, /image:bloquee/);
  assert.match(error, /process:undefined/);
  assert.match(error, /require:undefined/);
  assert.match(error, /rtc:undefined/);
  assert.match(error, /ws:undefined/);
});

test("charge : places bornees, file bornee, place rendue apres une erreur", async () => {
  const gate = limiter(1, 1);
  let open;
  const first = gate.run(() => new Promise((resolve) => { open = resolve; }));
  const second = gate.run(async () => "deux");
  assert.equal(await gate.run(async () => "trois"), null);
  open("un");
  assert.deepEqual(await first, { value: "un" });
  assert.deepEqual(await second, { value: "deux" });
  await assert.rejects(gate.run(async () => { throw new Error("x"); }));
  assert.deepEqual(await gate.run(async () => "ok"), { value: "ok" });
  assert.equal(gate.active, 0);
});

test("une slide ne transporte que des donnees bornees", () => {
  const slide = cleanSlide({
    layout: "liste", title: "x".repeat(900), items: ["a", 2, "b"], photo: "https://example.com/p.png",
    "bad key": "x", fn: () => 1, n: 3
  });
  assert.equal(slide.title.length, 600);
  assert.deepEqual(slide.items, ["a", "b"]);
  assert.equal(slide.photo, undefined);
  assert.equal(slide["bad key"], undefined);
  assert.equal(slide.fn, undefined);
  assert.equal(slide.n, 3);
  assert.equal(cleanSlide({ photo: "data:image/png;base64,AAAA" }).photo, "data:image/png;base64,AAAA");
  assert.deepEqual(cleanBrand({ name: "K", accent: "red;}" }), { name: "K", accent: null });
  // Contexte pose par Karoo : avatar en image seulement, zones sures en nombres.
  const context = cleanSlide({ karooAvatar: "data:image/jpeg;base64,AAAA", karooSafeTop: 250, karooHandle: "@karoo" });
  assert.equal(context.karooAvatar, "data:image/jpeg;base64,AAAA");
  assert.equal(context.karooSafeTop, 250);
  assert.equal(context.karooHandle, "@karoo");
  assert.equal(cleanSlide({ karooAvatar: "https://example.com/a.png" }).karooAvatar, undefined);
  assert.equal(cleanSlide({ karooAvatar: "data:image/svg+xml;base64,AAAA" }).karooAvatar, undefined);
});
