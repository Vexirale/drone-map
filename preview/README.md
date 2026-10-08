# Dakscan preview

A clickable, single-page preview of the roof scan platform, made to show the company owner what the product will do before M0 starts. It uses a **fictional, procedurally built house and neighbourhood**, not a real scan. It is not part of the production app and shares no code with it (yet).

Published version: https://claude.ai/artifact/HYSgaXXpfBCsqffgBSX8RK (private until shared from its Share menu).

## What it shows (all UI text in Dutch)

- **Klantpagina**: the customer share page. A before/after "video" of about a minute played live in the browser (establishing shot, VOOR orbit fitted to the whole plot, 6 problem markers on the roof and in the garden with the site photo as an inset, wipe, NA orbit, 6 solution markers, outro), and a free 3D mode with Voor/Na toggle, clickable pins that open a sheet with two site photos and a lightbox (phase 1), note cards (phase 3), roof-edge measurements (phase 2), a "Perceelgrens" toggle that shows the operator's view of the property boundary with everything outside faded, and a hovering survey drone.
- **Factuurmail**: Odoo's standard Dutch invoice mail with the video thumbnail and button added.
- **Zo werkt het**: the six workflow steps (including drawing the property boundary), what stays in Odoo, and the phases.

The camera path is one deterministic function of time (`sample(t)` in `src/page.html`), the same idea the real render worker will use: frame N is rendered from `sample(N / fps)`. The orbit distance per heading is computed so the whole boundary polygon, the house and the garden trees stay inside a 16:9 frame.

The demo keeps the neighbourhood visible on purpose. In the real system everything outside the boundary is cut from the customer files on the server (see PLAN.md); the "Perceelgrens" toggle shows what the operator sees while drawing it. The site photos are rendered from the same scene at eye level and graded like phone shots, lazily when the browser is idle.

## Layout

```
src/page.html            page template: markup, styles, scene, timeline, UI. Slots /*@@STAGE@@*/ and /*@@ASSETS@@*/
src/stage.js             render pipeline: sky dome, image-based light, soft PCF shadows, GTAO on desktop
src/assets/*.js          inlineable asset modules (rules in src/assets/RULES.md)
  trees.js               buildTree / buildShrub / buildHedge (leaf-card foliage, branching trunks)
  car.js                 buildCar (hatchback, estate, suv; Dutch plates)
  drone.js               buildDrone / animateDrone (RTK survey drone)
  neighbourhood.js       buildNeighbourhood (ground, street, garden, neighbours, far blocks, forest, skyline)
  _house_standin.js      simple stand-in of the hero house, for testing assets only
tools/build.py           inlines everything into dist/
tools/shoot.mjs          headless screenshots of the page (seek the video, switch modes, click, eval)
tools/shoot-asset.mjs    headless screenshots of a single asset module under the real lighting
dist/dakscan-voorbeeld.html   body fragment, exactly what is published as the artifact
dist/drone/index.html         standalone page for any static host
```

## Commands (run in `preview/`)

```bash
npm install                       # three 0.170.0 + playwright, only needed for the screenshot tools
python3 tools/build.py            # writes dist/ (add --stubs to replace assets with placeholders)
node tools/shoot.mjs shots jobs.json [page.html]
node tools/shoot-asset.mjs shots jobs.json
```

Job format is documented at the top of each tool. Set `"init": "window.__forceQuality='low'"` on a job to skip ambient occlusion; software rendering without a GPU is slow otherwise. `window.__preview` exposes `seek`, `play`, `pause`, `setMode`, `setScene`, `focus`, `plot`, `photos`, `photoUrls` and `stats` for tests.

## Hosting the standalone page

Upload `dist/drone/index.html` as `/drone/index.html` on any static host (for example `vexirale.com/drone`). It has `noindex, nofollow`. It loads three.js from cdn.jsdelivr.net and fonts from Google Fonts at runtime.

For a public EU site, consider self-hosting the three fonts (Familjen Grotesk, Figtree, JetBrains Mono): loading Google Fonts from Google's servers sends visitors' IP addresses to Google, which a German court (LG München I, 2022) ruled a GDPR violation.

## Known limits

- The house, the neighbourhood and the photos are fictional. A real DJI Terra scan looks like a photo-textured mesh; the plan is to swap one in (cropped, decimated to roughly 10 to 15 MB, KTX2 textures, see PLAN.md) once a whole-property sample with consent is available.
- Heavy 3D: phones get a lighter mode automatically (no AO, smaller shadow map); very old phones may still struggle.
- Tested in headless Chromium with software WebGL only.
