# karoo-render

Service de rendu du **mode Express** de Karoo : il rejoue un générateur Express
(code écrit par l'IA, au format commun de `src/lib/express/contract.ts`) dans
une page Chromium isolée et renvoie une image PNG par slide.

Ce dossier vit dans la branche `feat/mode-express` de Karoo pour être relu avec
le reste ; il est fait pour être déplacé tel quel dans son propre dépôt
(`karoo-render`) et déployé comme **projet Vercel séparé**.

## Sécurité

- Le générateur s'exécute **uniquement dans la page**, jamais dans Node.
- La page est **hors ligne** : toute requête réseau est refusée (seuls `data:`
  et `blob:` passent). Polices et images arrivent embarquées.
- Une page neuve par slide, fermée après la capture, avec un délai maximal
  (`RENDER_SLIDE_TIMEOUT_MS`, 15 s par défaut).
- WebRTC, WebSocket, EventSource et WebTransport sont retirés de la page, et
  Chromium refuse l'UDP hors proxy.
- Le conteneur tourne sous `pwuser`, jamais root. Le bac à sable de Chromium
  s'active avec `CHROMIUM_SANDBOX=1` si l'hôte autorise les espaces de noms.
- Charge bornée : `RENDER_MAX_JOBS` demandes à la fois (2), `RENDER_MAX_QUEUE`
  en attente (6, au-delà : 503), `RENDER_SLIDE_CONCURRENCY` pages par demande (4).
- Le service ne détient **aucun secret de Karoo** : sa seule variable est
  `RENDER_TOKEN`, partagée avec Karoo (côté serveur uniquement).

## API

- `GET /health` → `{ ok: true, active, waiting }`
- `POST /render` avec `Authorization: Bearer $RENDER_TOKEN` :

```json
{
  "format": "carrousel",
  "brand": { "name": "Karoo", "accent": "#5fd4f4" },
  "generator": "window.KAROO_GENERATOR = { blocks: {...}, render(root, slide, ctx) {...} }",
  "slides": [{ "layout": "couverture", "title": "…", "photo": "data:image/jpeg;base64,…" }]
}
```

Réponse : `{ ms, width, height, slides: [{ index, png (base64), ms }] }`.
Erreurs : 401 (jeton), 400 (entrées), 422 (le générateur a échoué), 500.

## Déployer sur Vercel

1. Dépôt GitHub `karoo-render` avec le contenu de ce dossier.
2. Vercel › Add New › Project › importer le dépôt (Framework : Other). Le
   `Dockerfile.vercel` construit l'image (Playwright épinglé, Chromium inclus).
3. Settings › Functions : région **Frankfurt (fra1)**.
4. Une seule variable : `RENDER_TOKEN` (un secret long, aléatoire). **N'ajoute
   aucune autre clé** (ni Supabase, ni Stripe, ni Anthropic).
5. Domaine : `render.karoo.agency` (CNAME vers Vercel, certificat automatique).
6. Dans le projet Vercel de **Karoo** : `RENDER_URL=https://render.karoo.agency`
   et le même `RENDER_TOKEN`, puis redéployer.

Le serveur écoute `$PORT` dès le démarrage (Chromium se lance en arrière-plan),
ce qui tient dans les ~28 s que Vercel accorde. Le conteneur s'endort après
quelques minutes sans trafic : le premier rendu suivant attend son réveil.

## Tester en local

```bash
npm install
CHROMIUM_PATH=/chemin/vers/chrome npm test
RENDER_TOKEN=dev npm start
```

Les tests couvrent le jeton, les entrées, un rendu de référence
(`generators/reference-modulaire.js`) et l'isolation : un générateur hostile
qui tente `fetch`, une image distante, `process` et `require` doit tout voir
échouer.
