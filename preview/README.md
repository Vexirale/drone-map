# Dakscan preview

A clickable, single-page preview of the roof scan platform, made to show the company owner what the product will do before M0 starts. It uses a **fictional, procedurally built house and neighbourhood**, not a real scan. It is not part of the production app and shares no code with it (yet).

Published version: https://claude.ai/artifact/HYSgaXXpfBCsqffgBSX8RK (private until shared from its Share menu).

## What it shows (all UI text in Dutch)

- **Klantpagina**: the customer share page. A one-minute before/after "video" played live in the browser (establishing shot, VOOR orbit, 6 problem markers, wipe, NA orbit, 6 solution markers, outro), and a free 3D mode with Voor/Na toggle, clickable pins, note cards (phase 3), roof-edge measurements (phase 2) and a hovering survey drone.
- **Factuurmail**: Odoo's standard Dutch invoice mail with the video thumbnail and button added.
- **Zo werkt het**: the five workflow steps, what stays in Odoo, and the phases.

The camera path is one deterministic function of time (`sample(t)` in `src/page.html`), the same idea the real render worker will use: frame N is rendered from `sample(N / fps)`.

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

Job format is documented at the top of each tool. Set `"init": "window.__forceQuality='low'"` on a job to skip ambient occlusion; software rendering without a GPU is slow otherwise. `window.__preview` exposes `seek`, `play`, `pause`, `setMode`, `setScene`, `focus` and `stats` for tests.

## Hosting the standalone page

Upload `dist/drone/index.html` as `/drone/index.html` on any static host (for example `vexirale.com/drone`). It has `noindex, nofollow`. It loads three.js from cdn.jsdelivr.net and fonts from Google Fonts at runtime.

For a public EU site, consider self-hosting the three fonts (Familjen Grotesk, Figtree, JetBrains Mono): loading Google Fonts from Google's servers sends visitors' IP addresses to Google, which a German court (LG München I, 2022) ruled a GDPR violation.

## Known limits

- The house is fictional. A real DJI Terra scan looks like a photo-textured mesh; the plan is to swap one in (decimated to roughly 10 to 15 MB, WebP textures) once a sample with consent is available.
- Heavy 3D: phones get a lighter mode automatically (no AO, smaller shadow map); very old phones may still struggle.
- Tested in headless Chromium with software WebGL only.
