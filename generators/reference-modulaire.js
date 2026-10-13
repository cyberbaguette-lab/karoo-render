// Generateur de reference au format commun Express (contrat :
// src/lib/express/contract.ts). Un systeme de blocs : chaque slide choisit
// son bloc (`slide.layout`). Sert d'exemple au convertisseur et aux tests.
window.KAROO_GENERATOR = {
  blocks: {
    couverture: { hint: "Premiere slide : accroche forte, photo plein cadre.", fields: {
      kicker: { type: "text", max: 24 }, title: { type: "text", max: 48, required: true },
      accent: { type: "text", max: 48 }, body: { type: "text", max: 90 }, photo: { type: "photo" } } },
    photo: { hint: "Une idee illustree par une photo.", fields: {
      kicker: { type: "text", max: 24 }, title: { type: "text", max: 48, required: true },
      accent: { type: "text", max: 48 }, body: { type: "text", max: 140 }, photo: { type: "photo", required: true } } },
    liste: { hint: "Trois a cinq points courts.", fields: {
      kicker: { type: "text", max: 24 }, title: { type: "text", max: 40, required: true },
      accent: { type: "text", max: 40 }, items: { type: "list", min: 3, max: 5, itemMax: 90, required: true } } },
    calcul: { hint: "Un chiffre cle mis en valeur.", fields: {
      kicker: { type: "text", max: 24 }, figure: { type: "text", max: 8, required: true },
      title: { type: "text", max: 40, required: true }, accent: { type: "text", max: 40 }, body: { type: "text", max: 140 } } },
    "pleine-page": { hint: "Une phrase forte, sans photo.", fields: {
      kicker: { type: "text", max: 24 }, title: { type: "text", max: 70, required: true } } },
    appel: { hint: "Derniere slide : question ou appel a l'action.", fields: {
      kicker: { type: "text", max: 24 }, title: { type: "text", max: 40, required: true },
      accent: { type: "text", max: 30 }, body: { type: "text", max: 30, required: true } } }
  },
  render(root, slide, ctx) {
    slide = Object.assign({ kicker: "", title: "", accent: "", body: "", figure: "", items: [] }, slide);
    const W = ctx.width, H = ctx.height, P = 92;
    const accent = ctx.brand.accent || "#5fd4f4";
    const navy = "#0b1020", white = "#f5f7fb", muted = "#aab3c5";
    const heavy = "'Noto Sans CJK HK', 'Liberation Sans', sans-serif";
    const el = (tag, style, text) => {
      const node = document.createElement(tag);
      Object.assign(node.style, { position: "absolute", margin: "0" }, style);
      if (text !== undefined) node.textContent = text;
      return root.appendChild(node);
    };
    const fit = (node, max, min, boxH) => {
      let size = max;
      node.style.fontSize = size + "px";
      while (size > min && node.scrollHeight > boxH) { size -= 3; node.style.fontSize = size + "px"; }
      return node.scrollHeight;
    };
    // Titre en capitales, la chute (accent) sur sa propre ligne en couleur.
    const headline = (top, boxH, max) => {
      const node = el("div", { left: P + "px", right: P + "px", top: top + "px", fontFamily: heavy, fontWeight: "900", textTransform: "uppercase", lineHeight: "1.02", letterSpacing: "-1px", color: white });
      node.appendChild(document.createTextNode(slide.title));
      if (slide.accent) {
        const span = document.createElement("span");
        span.style.color = accent;
        span.style.display = "block";
        span.textContent = slide.accent;
        node.appendChild(span);
      }
      return fit(node, max, 40, boxH);
    };
    // Sous-texte : **mot** passe en gras blanc.
    const subline = (top, size) => {
      const node = el("div", { left: P + "px", right: P + "px", top: top + "px", fontFamily: "'Liberation Sans', sans-serif", fontSize: size + "px", lineHeight: "1.4", color: muted });
      slide.body.split(/(\*\*[^*]+\*\*)/).forEach((part) => {
        if (!part) return;
        if (part.startsWith("**")) { const b = document.createElement("b"); b.style.color = white; b.textContent = part.slice(2, -2); node.appendChild(b); }
        else node.appendChild(document.createTextNode(part));
      });
      return node.scrollHeight;
    };
    const chrome = () => {
      el("div", { left: P + "px", top: P - 10 + "px", padding: "10px 22px", borderRadius: "999px", background: accent, color: navy, fontFamily: heavy, fontWeight: "900", fontSize: "22px", letterSpacing: "2px", textTransform: "uppercase" }, slide.kicker || ctx.brand.name || "");
      el("div", { right: P + "px", top: P + "px", fontFamily: heavy, fontWeight: "700", fontSize: "26px", color: muted, letterSpacing: "3px" }, `${ctx.index + 1}/${ctx.total}`);
      el("div", { left: P + "px", bottom: P - 20 + "px", width: "110px", height: "10px", borderRadius: "5px", background: accent });
    };
    const photo = (top, height, fade) => {
      if (!slide.photo) return;
      el("img", { left: "0", top: top + "px", width: W + "px", height: height + "px", objectFit: "cover" }).src = slide.photo;
      if (fade) el("div", { left: "0", top: top + "px", width: W + "px", height: height + "px", background: `linear-gradient(180deg, rgba(11,16,32,0) 35%, ${navy} 100%)` });
    };

    root.style.background = navy;
    const layout = slide.layout || (slide.role === "cover" ? "couverture" : slide.role === "end" ? "appel" : "photo");

    if (layout === "couverture") {
      photo(0, H * 0.62, true);
      const h = headline(H * 0.5, H * 0.3, 104);
      subline(H * 0.5 + h + 44, 36);
      chrome();
      return;
    }
    if (layout === "photo") {
      photo(0, H * 0.5, true);
      chrome();
      const h = headline(H * 0.5, H * 0.24, 80);
      subline(H * 0.5 + h + 36, 36);
      return;
    }
    if (layout === "liste") {
      chrome();
      const h = headline(P + 110, H * 0.24, 80);
      let top = P + 110 + h + 60;
      slide.items.forEach((item, i) => {
        el("div", { left: P + "px", top: top + "px", fontFamily: heavy, fontWeight: "900", fontSize: "64px", lineHeight: "1", color: accent }, String(i + 1).padStart(2, "0"));
        const text = el("div", { left: P + 120 + "px", right: P + "px", top: top + 6 + "px", fontFamily: "'Liberation Sans', sans-serif", fontSize: "36px", lineHeight: "1.32", color: white }, item);
        top += Math.max(80, text.scrollHeight) + 34;
        el("div", { left: P + "px", right: P + "px", top: top - 18 + "px", height: "1px", background: "rgba(170,179,197,.25)" });
      });
      return;
    }
    if (layout === "calcul") {
      chrome();
      const fig = el("div", { left: P - 6 + "px", right: P + "px", top: H * 0.2 + "px", fontFamily: heavy, fontWeight: "900", lineHeight: "1", color: accent, letterSpacing: "-6px" }, slide.figure);
      const fh = fit(fig, 300, 120, H * 0.26);
      const h = headline(H * 0.2 + fh + 40, H * 0.22, 72);
      subline(H * 0.2 + fh + 40 + h + 36, 36);
      return;
    }
    if (layout === "pleine-page") {
      root.style.background = accent;
      el("div", { left: P + "px", top: P + "px", fontFamily: heavy, fontWeight: "900", fontSize: "26px", letterSpacing: "3px", color: navy, textTransform: "uppercase" }, slide.kicker || ctx.brand.name || "");
      const node = el("div", { left: P + "px", right: P + "px", top: H * 0.26 + "px", fontFamily: heavy, fontWeight: "900", textTransform: "uppercase", lineHeight: "1.02", color: navy }, slide.title);
      fit(node, 124, 56, H * 0.5);
      return;
    }
    // appel (derniere slide)
    chrome();
    const h = headline(H * 0.3, H * 0.34, 96);
    el("div", { left: P + "px", top: H * 0.3 + h + 70 + "px", padding: "26px 44px", borderRadius: "999px", background: accent, color: navy, fontFamily: heavy, fontWeight: "900", fontSize: "34px", textTransform: "uppercase", letterSpacing: "1px" }, slide.body || "Enregistre ce post");
  }
};
