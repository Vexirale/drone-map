# Property scan platform: build spec

## Change log

**2026-10-09, two changes: traceable measurements and Google Cloud hosting.**

1. Every measurement shows how it was calculated, so quotes can be trusted and checked (phase 2). The methods, the uncertainty, control measurements and the stored provenance are fixed in "Phase 2: how every measurement is calculated" and documented with formulas and a worked example in `docs/measurements.md`. What those measurements need from a scan (file hashes, coordinate system, resolution) is stored from the first upload in M1, so older scans can be measured later.
2. Production runs on Google Cloud in europe-west4 (Netherlands), reproducible from OpenTofu code under `infra/gcp/`. The app stays portable. See "Hosting: Google Cloud". The setup and its monthly cost are proposed in `docs/gcp-hosting.md` and wait for an OK before anything gets built.

Consequences elsewhere in this file:
- Uploads go straight from the browser to the bucket with Cloud Storage's resumable protocol instead of tus.
- Files live in a Cloud Storage bucket. The local disk driver stays for development and for running on any other server.
- Cloud Monitoring replaces Uptime Kuma.
- OpenDroneMap (phase 4) runs on a Spot VM per job.

Changed after review (see `PLAN.md` section 1):
- Final measurement values are computed on `work.glb`, the lossless full-detail mesh, instead of `render.glb`. `render.glb` is simplified for the renderer, and the original upload is deleted after 90 days.

**2026-10-08, scope change: whole property.** Scans cover the whole property, not just the roof: driveway (oprit), garden (tuin), lawn (grasveld), trees (bomen). Changes in this version:

1. Markers can be placed anywhere on the mesh, roof or ground. Land pests and land problem/solution presets are added.
2. Site photos on markers move to phase 1 (they were phase 3). Customers see them when they click a pin. EXIF and GPS are stripped from customer copies. Optional: the photo appears as an inset in the video when the camera visits that pin.
3. A crop tool is added to phase 1. The operator draws the property boundary (or a box) before sharing, and everything outside it is removed from the viewer, the video and the customer page.
4. The default camera orbit fits the whole cropped area, not just the house. Marker visits still come after the orbit.
5. Exports are much bigger. Processing time and the web.glb size budget must be measured on a whole-property sample and reported. First numbers, on a size-realistic synthetic property and on DJI's own Terra sample, are in `PLAN.md`; the limits and budgets below come from them and get re-checked on the first real export.

Also recorded: Odoo runs on Odoo Online (odoo.com) with all apps (answers to two open questions).

---

You are building a production web app for a Dutch pest control company (ongediertebestrijding: pigeons and other birds, rats and mice, martens, wasps, moles, ants, oak processionary caterpillars and so on). A lot of their work happens on roofs (nets, pins, mesh around solar panels, sealing entry points, removing nests) and around the house (rat burrows, mole hills, ant nests in the driveway, ground wasp nests, nests in trees). They scan the whole property with a DJI drone with RTK and process the photos into 3D models in DJI Terra. Every job gets scanned twice: before the work (voor) and after the work (na).

The owner wants an in-house system tied into Odoo instead of paying for tools like AiroCollect long term. It gets built in phases:
- Phase 1: before/after video per job with markers anywhere on the property, site photos on markers, a crop to the property boundary, a share page for the customer, and the video link on the Odoo invoice.
- Phase 2: measuring on the RTK model, quotes pushed into Odoo, inspection report.
- Phase 3: notes, job photos and annotated screenshots, job timeline synced with Odoo, one customer page per job, on-site use by employees.
- Phase 4 (optional): in-house photogrammetry and other extras.

Reference for look and feel: AiroCollect (airocollect.com), browser-based drone roof software for roofers and solar installers (2D/3D models, measuring, notes and markups, reports and quotations, sharing with clients). Use it as UX inspiration. Don't copy its roofer and solar specific features; this is for pest control.

A clickable preview with a fictional house lives in `preview/` (see `preview/README.md`). It shows the intended customer page, video structure, pins, note cards and measurements. It is a mock-up, not a reference implementation.

## How I want you to work

1. Read this whole file first. Then check "Project facts" and ask me every open `[TODO]` in one message. You can start M0 to M2 with the defaults given there. The Odoo version must be answered before you build anything that talks to Odoo (M3).
2. In M0, design the architecture and data model for all phases (scans, crop boundary, markers, marker photos, measurements, quotes, notes, job photos, job status), so later phases fit without rewrites. Then build phase by phase. Each phase must be usable in production on its own, and the next phase starts only after the previous one is live and used on real jobs.
3. Plan before coding each milestone. Wait for my OK.
4. Build one milestone at a time. After each one: run lint, typecheck and tests, commit with a clear message, and give me a short summary plus how to try it locally.
5. Create and maintain `CLAUDE.md` with commands, conventions, architecture notes and gotchas you run into.
6. Never touch the production Odoo database without asking me first. Develop against a local Odoo in Docker running the same major version. Every Odoo write must support a dry-run mode.
7. Secrets only in `.env` (ship a `.env.example`) and, in production, in Google Secret Manager. Never commit secrets, customer data or real scans.
8. One developer (me) owns and maintains this long term. Keep the codebase small, boring and well documented. No scaling work: about 5 jobs a month.
9. If something in this spec is wrong, outdated or overkill, tell me and propose something better instead of silently following it. Verify library APIs and Odoo docs yourself, don't trust my details blindly.

Language: all UI and customer-facing text in Dutch (nl-NL). Code, comments and developer docs in English.

## Project facts

Known:
- Field: ongediertebestrijding in general. Roofs and the land around the house are the main use cases for this app.
- Drone: DJI with RTK. 3D processing in DJI Terra.
- Scans per job: two, before (voor) and after (na). Each covers the whole property: house and roof, driveway, garden, lawn, trees.
- Video: landscape 16:9 only. Per scan: full orbit of the cropped property first, then visit the markers one by one.
- Branding: placeholder for now. Make a simple placeholder logo (SVG) and use green and red: red for "Voor" and problems, green for "Na" and solutions. Logo, colors and texts must be swappable in settings later.
- Odoo: Odoo Online (odoo.com), all apps. External API access needs the Custom plan; confirm it with "Test connection". No custom Python modules are possible on Odoo Online.
- Users: the owner plus employees, each with their own account. Employees will also use it on site on phones and tablets (phase 3).
- Volume: about 5 jobs a month.
- Hosting: Google Cloud, region europe-west4 (Netherlands), in the company's own Google Cloud project and billing account (no personal accounts). Don't depend on anything on their current servers. The app must stay portable: it still runs on any Linux server with Docker, and Google-specific code lives only in the storage and secrets adapters. Assume no GPU.

Open (defaults in brackets):
- Odoo version: `[TODO]` (Odoo Online runs saas-x.y; read it under Instellingen, at the bottom)
- Odoo plan: `[TODO]` (assume Custom; without it the app runs in manual mode)
- Do they plan jobs in Odoo (Field Service, Project, Planning)? `[TODO]` (assume no)
- How invoices and quotes reach customers, and whether the invoice goes out before or after the after scan is processed: `[TODO]` (assume email from Odoo, a few days after the work)
- DJI Terra version, coordinate system and export settings: `[TODO]` (assume OBJ single block, UTM zone 31N, plus the orthophoto GeoTIFF for phase 2)
- DJI drone model: `[TODO]` (not critical)
- Background music in the video: `[TODO]` (assume off)
- Domain for share links: `[TODO]` (for example video.bedrijfsnaam.nl)
- Retention: `[TODO]` (assume originals 90 days, everything else 2 years)
- Company email and login provider: `[TODO]` (Microsoft 365, Google Workspace, other; only matters for SSO in phase 4)
- A real before/after whole-property export with the owner's consent (company building or a customer who agrees): `[TODO]` (needed for the M1 benchmark and the render test)
- Does their Odoo run in this Google Cloud project? `[TODO]` (assume no: it is Odoo Online. If it did, the app would talk to it over the private network and a custom Odoo module would become possible.)
- Is there an existing Google Cloud organization and project, and who owns the billing account? `[TODO]` (assume a new project under the company's own organization and billing account)
- Monthly budget limit for the billing alerts: `[TODO]` (set by the owner; alerts at 50, 90 and 100 %)

## Job lifecycle (all phases)

1. Job created, customer picked from Odoo. (phase 1)
2. Inspection: before scan uploaded, property boundary drawn (crop), red problem markers placed anywhere on the property, site photos attached to markers. (phase 1)
3. Property measured on the before scan, draft quotation pushed to Odoo, inspection report and inspection page for the customer. (phase 2)
4. Customer accepts the quote in Odoo's own portal; the job status follows Odoo. (phase 3)
5. Work done: after scan uploaded and aligned, green solution markers placed, site photos attached. (phase 1)
6. Before/after video rendered from the cropped models. (phase 1)
7. Video linked on the invoice in Odoo; the invoice email gets a "Bekijk de video van uw dak" button (wording configurable). (phase 1)
8. Customer opens the share page (phase 1), which grows into one job page with the whole story (phase 3).

## Phase 1 flow in detail

1. Operator (owner or employee) logs in.
2. Creates a job: picks the customer from Odoo (search by name, email or address), sets date and type of pest/work.
3. Uploads the before scan (DJI Terra export, zip or folder; typically 50 to 550 MB for a whole property when a reconstruction region is set in Terra, more without). This can happen days or weeks before the work.
4. The app processes it in the background with visible progress, then shows the 3D model.
5. Operator draws the property boundary in a top view (polygon or box). The app may pre-fill it from the cadastral parcel (see Phase 1: crop). Everything outside is dimmed for the operator and removed from everything the customer sees.
6. Operator places red problem markers anywhere on the mesh (roof, wall, driveway, lawn, tree) with short Dutch labels (for example "Nestplaats duiven", "Rattenholen", "Mierennest"), and attaches site photos to markers where the mesh does not show enough (rat holes, nests in trees, entry points).
7. After the work, the operator uploads the after scan. The app aligns it with the before scan, applies the same boundary and shows a Voor/Na toggle.
8. Operator places green solution markers (for example "Vogelnet geplaatst", "Lokdoos geplaatst") and attaches photos. A before marker can be copied to the after scan at the same spot and relabeled.
9. Operator hits render, gets the before/after MP4 plus thumbnail, previews it, can re-render.
10. Operator clicks "Koppel aan factuur" and picks the customer's invoice from Odoo. The app stores the video link on that invoice and logs an internal note.
11. The invoice gets sent from Odoo like they already do. The invoice email has a "Bekijk de video van uw dak" button that opens the share page.
12. Customer opens the share page: video, interactive 3D view of the cropped property with Voor/Na toggle and clickable pins (with photos), company branding. No login.

## Out of scope (all phases)

- No integration with the Odoo POS module. Invoices in Odoo are `account.move` records no matter if they came from Sales, POS or were made by hand. Only work with `account.move` (and `sale.order` for quotes in phase 2).
- No sending, confirming or posting invoices, and no confirming quotes, from this app. That stays in Odoo.
- No customer logins or payments in this app. Odoo's portal already handles signing and paying quotes and invoices.
- No solar panel simulation, facade tools, CAD/DXF exports or flight planning (flights happen in DJI's own apps).
- No multi-tenant setup (one company), no native mobile apps (a PWA is fine), no AI detection features.
- No automatic detection of people, faces or license plates. The crop and the operator's judgement handle privacy.

## Phase 1: 3D input

- Supports DJI Terra OBJ exports (`.obj` + `.mtl` + JPG textures + `metadata.xml`) and GLB/glTF.
- Terra can export multi-block OBJ (one OBJ per block folder). Merge blocks into one model (up to 4, with a warning). In the upload UI and the guide, recommend a single-block OBJ export with a reconstruction region (ROI) drawn around the property in Terra; that cuts the export 2 to 4x and keeps most neighbour geometry out at the source. Accept only the OBJ output folder, not the Terra project folder.
- Whole-property exports are much bigger than roof-only exports. Plan for uploads up to about 1.5 GB and up to about 12 M triangles; warn above 3 M triangles. Measured: obj2gltf converts 12 M triangles in about 53 s and 2.1 GB of RAM on 4 cores (`PLAN.md` section 3).
- Validate geometry after import (bounding box sanity, triangle count, missing textures, degenerate faces) and fail with a clear Dutch error message, never a stack trace. Some DJI Terra versions have produced broken multi-block OBJ exports, so bad input must be caught early.
- RTK models are georeferenced, so raw vertex coordinates can be huge (projected CRS like RD New or UTM). That causes float32 jitter in WebGL. Read the SRS and origin from `metadata.xml`, recenter around a local origin, and store the original SRS and offset in the database. Handle Z-up vs Y-up.
- Before and after scans of one job should share the same SRS. Use one local origin per job (taken from the first scan) for both, so they line up and one camera path and one crop boundary work for both. Check the alignment (SRS match, bounding box overlap). If the SRS differs, reproject or stop with a clear message. Give the operator a small manual offset nudge for the after scan in case it's slightly off.
- Later, only if needed: 3D Tiles (`tileset.json` + `.b3dm`), PLY/LAS point clouds. OSGB is not supported; the UI tells the user to export OBJ instead.
- Uploads must be resumable and chunked, survive flaky connections and show progress. On Google Cloud the browser uploads straight to the bucket with Cloud Storage's resumable upload protocol (the API only opens the upload session, for a fixed object name and size). With the local disk driver the API speaks the same protocol, so the browser has one upload client. Max size configurable, default 3 GB; chunks are at most 64 MB, so the reverse proxy's body limit only has to cover one chunk.
- Store from the first upload on what phase 2 measurements need, so scans uploaded in phase 1 can be measured later: the SHA-256 of every uploaded and derived file, the horizontal and vertical coordinate system as read from `metadata.xml` (or "unknown"), the job origin in that system, the projection scale factor at the origin, the up axis, the effective resolution (median texel size), the GSD from a DJI Terra quality report when the export folder contains one, and the tool versions of the processing pipeline.

## Phase 1: crop to the property

- Before anything is shared or rendered for the customer, the operator sets the property boundary: a polygon drawn in a top-down view, or a rotated box. One boundary per job, in job-local coordinates, applied to both scans.
- Optional pre-fill: with RTK coordinates the app can fetch the cadastral parcel (Kadaster BRK, open data via PDOK) around the house and propose it as the boundary. The operator always checks and adjusts it; the cadastral map is indicative. If the lookup fails, the operator draws the boundary by hand.
- Cropping is a privacy measure, so it is enforced on the server, not only hidden in the viewer: everything the customer can download (`web.glb`, thumbnails, video, share page data) is generated from a cropped copy in which triangles outside the boundary are removed and texture pixels used only by removed triangles are blanked. A customer who downloads the model files must not get the neighbours' gardens, cars or people.
- The operator view keeps showing the area outside the boundary, dimmed, for context. Changing the boundary re-generates the customer files and marks an existing video as outdated.
- Markers outside the boundary are flagged; they cannot be shown to the customer.
- Sharing and rendering the customer video require a boundary, or an explicit "no crop" confirmation by the operator.

## Phase 1: processing (background worker)

- Unzip, detect format, validate, convert to GLB.
- Keep a full-resolution working copy for the operator (`work.glb`): the original geometry without simplification or position quantization, kept as long as the job, because final measurement values are computed on it (phase 2). Produce the customer files from the cropped copy: `render.glb` (high detail, for video) and `web.glb` (light, for the browser and share page). Simplify meshes to configurable triangle targets, convert textures to KTX2 (WebP as fallback), cap them at 4096 px. Budgets, from the measurements in `PLAN.md`: `web.glb` about 500k triangles and about 64 Mpx of textures, target 8 to 15 MB, hard cap 25 MB (texture memory on phones is the real limit, not triangles); `render.glb` about 1.5 M triangles and about 270 Mpx of textures, which keeps the headless renderer near 3 GB of RAM.
- Compute bounding box, center, up axis, suggested orbit for the cropped area. Generate a still thumbnail.
- Keep the original upload untouched until retention cleanup.
- Measure and report processing time and peak memory per step on a whole-property sample, and the resulting `web.glb` and `render.glb` sizes.

## Phase 1: viewer, markers, photos, camera path

- three.js via react-three-fiber. Photogrammetry textures already contain baked lighting, so render them unlit (`MeshBasicMaterial` or `KHR_materials_unlit`), otherwise the model looks wrong.
- Orbit controls and a Voor/Na toggle.
- Markers: click to place anywhere on the mesh (raycast), roof, walls or ground. Each marker has a type (problem in red, or solution in green), a label and an order. Edit, reorder, delete, and copy a marker from Voor to Na. Markers carry an "in video" flag so the operator can keep small ones out of the video.
- Label presets for pest control, seeded with sensible Dutch defaults and editable in settings. Free text is always allowed.
  - Problems: "Nestplaats duiven", "Invliegopening", "Wespennest", "Toegang marter", "Knaagschade", "Vervuiling", "Rattenholen", "Looppaden", "Molshopen", "Mierennest", "Nesten in boom", "Grondwespennest", "Vraatschade".
  - Solutions: "Vogelnet geplaatst", "Pinnen geplaatst", "Gaas rond zonnepanelen", "Opening afgedicht", "Nest verwijderd", "Rattenklep geplaatst", "Lokdoos geplaatst", "Klemmen geplaatst", "Holen gedicht", "Gaas ingegraven", "Nesten weggezogen", "Mierennest bestreden".
  - Pest types for the job: duiven en andere vogels, ratten en muizen, marters, wespen, mollen, woelratten, konijnen, mieren, eikenprocessierups. Ratten, muizen and wespen apply to roof and land.
- Site photos on markers: the operator attaches one or more photos to a marker (upload from desktop, or from a phone in the browser). Small things such as rat holes or nests in trees barely show in a photogrammetry mesh, so photos carry the detail. The customer sees a marker's photos when they click its pin. Customer copies are re-encoded with all EXIF and GPS data removed and capped at a sensible size; originals stay staff-only and follow the retention for originals. Phone photos may be HEIC; handle or convert them.
- Optional: when the video camera visits a marker that has a photo, show the first photo as an inset next to the label (on by default per marker, off when the photo shows something the customer should not see in a forwardable video).
- Camera path: the default preset is "orbit first, then visit the markers in order". The orbit fits the whole cropped area (not just the house), including elongated plots, so the whole property stays in frame; height and distance follow from the boundary and the camera's field of view, with sliders to adjust. Marker visits come after the orbit; ground markers get a lower viewing angle than roof markers, and moves between markers climb over buildings and trees instead of flying through them. The same orbit is used for both scans; the marker visits come from each scan's own markers.
- The camera path is stored as JSON keyframes and is the single source of truth for both the browser preview and the final render. The preview must match the render.

## Phase 1: video rendering

- Default approach: headless Chromium (Playwright) opens a dedicated render route that uses the same scene code as the viewer and renders frame N deterministically (fixed timestep, no wall-clock or requestAnimationFrame timing, wait until every texture has loaded). Pipe frames to ffmpeg.
- Must work without a GPU (software GL inside Docker) and use a GPU when one is available.
- Output: H.264 MP4, 1920x1080, 30 fps, yuv420p, `+faststart`, AAC only when music is on. Only 16:9 for now, but keep presets easy to add.
- Structure:
  1. Intro card: logo, "Uw woning in [plaats]" (wording configurable), date.
  2. "VOOR" title in red, orbit around the cropped before scan, then each red marker with its label (and photo inset when enabled) as an overlay.
  3. Transition (wipe or crossfade).
  4. "NA" title in green, the same orbit around the cropped after scan, then each green marker.
  5. Outro card: company name, phone, website.
- Length follows the number of markers shown in the video, roughly 30 to 90 seconds, configurable. With many markers the time per marker shrinks to a configurable minimum.
- Small logo watermark during the 3D parts. All texts, colors and the logo are editable in settings. Optional background music track uploaded in settings.
- Don't show the customer's street address in the video by default, videos get forwarded. City only, configurable.
- At about 5 renders a month, speed barely matters (up to about 30 minutes per render is fine). Spend the effort on quality: supersampled anti-aliasing, smooth easing, crisp label overlays, no texture popping.
- Renders run in a queue with progress, retries, timeout and a readable failure reason. Log render time per job.
- If the sample renders too slowly or looks bad this way, measure it, then propose Blender headless (bpy) as an alternative renderer that reads the same camera path JSON. Don't switch without asking.

## Phase 1: share page

- Public URL with a long random token (`/v/<token>`). No customer name or address in the URL. `noindex`, no third-party tracking.
- Shows the before/after video (thumbnail as poster), an interactive 3D view of both cropped scans (`web.glb`) with a Voor/Na toggle and clickable pins that open the marker's label and photos, a short Dutch text and company contact info. Mobile first, loads fast on 4G: the video first, the 3D model only when the customer asks for it.
- Links can be revoked, expiry is configurable (default from settings). Count views without storing personal data.

## Odoo integration

Facts to build on (verify against the docs and the actual instance):
- They are on Odoo Online (odoo.com) with all apps. External API access needs the Custom plan; confirm it with "Test connection". Studio is available on Custom.
- Custom Python modules are not possible on Odoo Online, so everything goes through the external API.
- Odoo 19 added the JSON-2 API: `POST /json/2/<model>/<method>`, header `Authorization: bearer <API key>`, plus `X-Odoo-Database` when the server hosts several databases. XML-RPC and JSON-RPC are deprecated since 19 and are scheduled for removal in Odoo Online 21.1, so this app uses JSON-2 only. Odoo 19+ instances have a built-in API explorer at `/doc`.
- API keys are created on the integration user under Preferences, Account Security, New API Key.
- Odoo Online upgrades the instance on its own schedule. Stick to standard public fields and methods, and add a health check that flags failing calls.

Phase 1 build:
- A small typed Odoo client using JSON-2.
- All Odoo calls happen server-side, the API key never reaches the browser. Odoo URL, database and API key come from env. The settings page shows status and has a "Test connection" button that reports version, user, plan capability (API reachable), and whether every required right and field exists.
- Use a dedicated Odoo user with minimal rights (Invoicing in phase 1, Sales added in phase 2) and its own API key.
- Read: `res.partner` search (name, email, street, city). `account.move` with `move_type = out_invoice` for that partner (name, state, invoice_date, amount_total, payment_state, is_move_sent).
- Write when linking:
  - Set a custom field `x_roof_video_url` (Char) on `account.move`; the field name is configurable. In production it gets created in developer mode (Settings, Technical, Fields), not in Studio, because Studio prefixes field names with `x_studio_`; give me exact click-by-click steps. On the local Odoo, create it by script.
  - Post an internal note in the chatter (subtype `mail.mt_note`, so the customer does NOT get an email) with the link and the thumbnail attached.
  - Optional, off by default: attach the MP4 as `ir.attachment` when under a configurable size (Odoo storage fills up fast with video).
- Prefer linking while the invoice is still draft. Never change lines, amounts, taxes or state of an invoice.
- Email: give me step-by-step instructions plus the exact QWeb snippet to add a conditional "Bekijk de video van uw dak" button (and optional thumbnail) to the invoice email template, only shown when the video field is set. Odoo's standard Dutch invoice mail addresses the customer with "je"; keep the button wording consistent with the template they actually use.
- If a custom field is impossible, fallback: append one Dutch line with the link to the invoice notes (`narration`) on draft invoices, which prints on the PDF.
- Manual mode for when Odoo is down, not configured yet, or not on the Custom plan: show the link, a downloadable QR PNG and a ready-to-paste Dutch sentence for the invoice, email or WhatsApp. The app must be fully usable in manual mode.
- Idempotent: linking the same job again overwrites the field and posts one new note, never duplicates attachments. Log every Odoo call (never secrets) in a sync log visible to admins.

Phase 2 and 3 additions are in their own sections below.

## Phase 2: measuring, quotes, inspection report

- Measuring tools on the 3D model (RTK, so real-world meters), on roofs and on the ground: point-to-point distance, polyline length (for example roof edges that get pins, or a fence line that gets buried mesh), surface area of a polygon (for example net or mesh area, or a lawn treated for moles), height difference, roof pitch. Live values while drawing, snapping to the mesh, undo. Saved per job with a name and a type tag (for example "net", "pins", "mesh", "gaas ingegraven"). How every value is calculated is fixed in the next section.
- 2D view: if the DJI Terra orthophoto (GeoTIFF) is uploaded, show it top-down (convert it server-side with GDAL to something web-friendly), cropped to the same boundary, and allow the same measurements in 2D. A click on the orthophoto is a vertical view ray onto the mesh, so 2D and 3D measurements use the same methods.
- Accuracy: validate against tape-measured control measurements on real properties and report the error (see "Uncertainty" below).
- Quote builder: admins map measurements to Odoo products (for example the area along the slope of measurements tagged "net" to a "Vogelnet per m²" product, length tagged "pins" to "Pinnen per meter", plus fixed lines like call-out costs). Each mapping has a measurement type, an extra percentage with its reason (for example "overlap"), a rounding rule and a minimum quantity. The operator reviews and edits the proposed lines, then pushes a draft `sale.order` for the job's customer to Odoo with product, quantity and description per line. Prices always come from Odoo (pricelists); this app never calculates prices. Never confirm or send the quote from here.
- Inspection report: a branded Dutch PDF (cover, city and date, views of the cropped before scan with red markers, marker photos, measurement table, notes and advice, and a "Meetverantwoording" appendix), generated server-side from an HTML template (Playwright print to PDF, reusing the worker's Chromium), attached to the quotation in Odoo with an internal note.
- Inspection page for the customer: cropped before scan with problem markers, their photos and (configurable) measurements with their short explanation, plus a button to the quotation in Odoo's portal (the quote's portal link with access token; check how to get it through the API on their version).
- The Odoo integration user needs Sales rights from this phase on. "Test connection" checks for that.

## Phase 2: how every measurement is calculated

Staff and customers must be able to see how each number was calculated, so quotes can be trusted and checked. The methods below are fixed; `docs/measurements.md` documents each one with its formula and a worked example, and the code follows that document. The inputs these methods need are stored from the first upload in M1 (see "Phase 1: 3D input").

Frame and points:
- All math runs in the job-local metric frame: metres east, north and up from the model's projected coordinate system, minus the job origin. A model in a geographic system (degrees) is reprojected to the job's projected system first. The projection's scale distortion at the job location is computed and stated in `docs/measurements.md`: @@SCALE@@, negligible at roof scale.
- Points are picked on the light browser mesh (`web.glb`) for speed. The server computes the final values on the full-detail mesh (`work.glb`) by re-projecting each picked point along the same view ray (from the camera through the picked point, first hit). Both points are stored, and a difference above @@FLAG@@ is flagged for the operator to check.

Methods (exactly these):
- Distance: the straight 3D distance between two points. Length: the sum of the 3D segment lengths of a polyline.
- Height: the vertical difference between two points, in the Z-up local frame (Y-up only exists in three.js). NAP heights are shown only when the vertical datum is known: heights already in NAP, or ellipsoidal heights converted with the official NLGEO2018 geoid (RDNAPTRANS2018). Otherwise only relative heights are shown.
- Area on a roof face: fit a plane through the full mesh's vertices inside the drawn polygon (least squares), project the polygon onto that plane and compute the area with the shoelace formula in the plane's 2D coordinates. That is the real area along the slope. Also show the area seen from above (the polygon projected on the horizontal plane), clearly labeled. If the surface isn't flat (RMS distance of those vertices to the plane above 5 cm), use the sum of the mesh triangle areas clipped to the polygon instead, and say so.
- Roof pitch: the angle between the fitted plane's normal and vertical, in degrees.
- Area on the ground (tuin, oprit): the mesh surface area clipped to the polygon, plus the area from above.

Uncertainty:
- The model's effective resolution is the median texel size of the mesh in cm, or the GSD from the DJI Terra quality report when the export contains one.
- The point uncertainty σ follows from that resolution (@@SIGMA@@) and is propagated to every value: distance, length, height, both areas and the pitch. For polygon areas: var(A) = σ²/4 · Σ |v(i+1) − v(i−1)|², with independent vertex errors σ. The ± shown is 2σ, rounded up.
- Control measurement ("controlemeting"): the operator can enter a tape-measured value for any measurement, and the deviation is stored. Settings show the number of control measurements and their average and maximum deviation. Once there are enough (default 10 of a kind: lengths and heights in cm, areas in %), the ± shown to customers comes from those real deviations instead of the estimate.
- Never show an accuracy number that isn't backed by the resolution estimate or by control measurements. Without either, the value is shown without ±.

Provenance:
- Stored per measurement: the picked points (job-local and original coordinate system) with their view rays, the method, the scan and model file (SHA-256), the algorithm version and its parameters, the values, the uncertainty and where it came from, who and when, and the edit history.
- Every edit or recalculation adds a new revision; revisions are never changed afterwards. Quotes, reports and customer pages refer to one revision and keep a copy of its values. When the algorithm improves, existing measurements are recalculated only when an operator asks, as a new revision. Issued quotes and reports keep their old values.

What people see:
- Staff: every measurement has a "Hoe berekend?" panel with the method in plain Dutch, the formula, the input points, both areas (along the slope and from above), the pitch, the flatness, the uncertainty and any control measurements.
- Customer page and inspection report: a short Dutch explanation, for example "Gemeten op het 3D-model van uw dak, gemaakt met een RTK-drone. Oppervlakte langs de helling van het dak. Nauwkeurigheid ongeveer ± X cm.", plus a screenshot with the measured shape highlighted. The report's "Meetverantwoording" appendix lists every measurement used in the quote.
- Quote lines show the calculation from measurement to quantity in the Odoo line description, for example "Vogelnet: 48,6 m² gemeten + 10% overlap = 53,5 m², afgerond 54 m²".
- Dutch number format everywhere: 12,4 m²; 3,25 m; 35°.

Tests: unit tests against exact known geometry (the synthetic house with known dimensions, a 45° roof face whose area along the slope is √2 times its area from above, a non-flat surface, a concave polygon, a kerb inside a ground polygon) and Monte Carlo tests for the error propagation.

## Phase 3: notes, job photos, job timeline, on-site use

- Notes on markers and on the job, each marked internal or visible to the customer.
- Job photos: employees add phone photos on site and attach them to the job (marker photos already exist since phase 1). Same EXIF and GPS stripping for customer-facing copies.
- Annotated screenshots: capture the current 3D view (with markers and measurements), draw arrows and circles, save it to the job and use it in reports.
- On-site use: the operator UI works well on phones and tablets as a PWA. Photo and scan uploads queue up and retry when the connection is bad.
- Job timeline and status: Inspectie, Offerte verstuurd, Akkoord, Uitgevoerd, Gefactureerd, Betaald. Take quote and invoice states from Odoo by polling every few minutes (no webhooks needed at this volume). If they plan jobs in Odoo, link to those records instead of duplicating planning here.
- Customer job page: one link per job that tells the story: inspection (before scan, report), quote (Odoo portal link), result (video, after scan). Old phase 1 share links keep working.
- Dashboard: jobs per status and per employee, failed renders, Odoo sync problems.
- Audit log: who did what and when.

## Phase 4: optional, only after I say go

- In-house photogrammetry: process raw drone photos with OpenDroneMap (NodeODM), so staff can upload photos straight from the drone without the DJI Terra step. Keep DJI Terra import as the main path until ODM quality is proven on their properties. It runs on a Spot VM created per job and deleted afterwards, not on an always-on big VM. Write down the machine requirements first.
- SSO with their Microsoft 365 or Google Workspace accounts.
- 3D Tiles input for very large scans, and a "branding only" mode that puts the intro, outro and watermark on a normal drone clip. (An Odoo module is not possible on Odoo Online.)

## Users and auth

- Staff login with email and password (argon2, secure httpOnly cookies, rate limiting). Roles: admin (settings, users) and operator (employees). First admin seeded from env.
- TOTP two-factor login required for admins, optional for operators.
- Each job records who created it, who uploaded each scan, who set the crop and who rendered the video. The full audit log comes in phase 3.

## Hosting: Google Cloud

Production runs on Google Cloud in europe-west4 (Netherlands). Propose the setup with a monthly cost estimate before building it (`docs/gcp-hosting.md`).

- Portability: Google-specific code only inside the storage and secrets adapters. The same images run on any Linux server with Docker, with local disk storage and secrets from `.env`.
- Compute: one Compute Engine VM (Ubuntu LTS, about e2-standard-4) running the Docker Compose stack (api, worker, Caddy), with a static IP and automatic security updates.
- Files: a Cloud Storage bucket in europe-west4 behind the storage interface. Lifecycle rules enforce the retention (originals deleted after 90 days), soft delete is on, and customer pages get short-lived signed URLs for videos and models. Large uploads go straight from the browser to the bucket (resumable uploads).
- Database: Postgres on Cloud SQL (small instance, private IP, automated backups and point-in-time recovery), unless Postgres in Docker on the VM with dumps to the bucket is the better trade-off at 5 jobs a month. Proposed: it is. Postgres stays in Docker on the VM, with a dump every 6 hours to a backup bucket in another EU region (`docs/gcp-hosting.md`, decision 1).
- Security: the VM uses its attached service account with least-privilege roles, no JSON key files. Secrets (Odoo API key, database password, any signing key) live in Secret Manager. SSH only through IAP, no public port 22; only 80 and 443 are open.
- Backups: a daily disk snapshot schedule, database backups, bucket soft delete plus a nightly copy to a second EU region. A full restore is tested once and documented.
- Monitoring: Cloud Monitoring uptime checks on a customer page and on `/health`, e-mail alerts when they fail or when renders or Odoo calls keep failing, and the Ops Agent for VM logs and metrics.
- Billing budget with alerts at 50 %, 90 % and 100 % of a monthly limit the owner sets.
- Everything in OpenTofu (Terraform-compatible) under `infra/gcp/` with a README. No click-only setup: the previous people who ran their servers left a mess, so this must be reproducible and documented.
- Deploy: build the images, push them to Artifact Registry in europe-west4, deploy with one command. GitHub Actions with Workload Identity Federation can come later.
- Everything lives in the company's own Google Cloud project and billing account, no personal accounts. `docs/runbook.md` lists every IAM role and who has it.

## Operations (from phase 1 on)

- Health check endpoints, structured logs with rotation, uptime monitoring and alerts when renders or Odoo calls fail (Cloud Monitoring, see "Hosting: Google Cloud").
- Backups of Postgres and the files, plus a documented restore procedure that you actually test once, as a full restore from scratch.
- `docs/runbook.md`: deploy, update, rollback, restore, rotate secrets, add a user, and every IAM role with who has it.
- `docs/server-requirements.md`: CPU, RAM, disk and network needs per phase, based on the measured whole-property numbers, also for running on a server outside Google Cloud.
- Keep dependencies updated (Dependabot or Renovate if the repo is on GitHub).

## Storage, retention, privacy (AVG)

- Runs on Google Cloud in europe-west4 (Netherlands). Keep all data, backups included, in the EU.
- Files (scans, renders, photos, reports) live in a Cloud Storage bucket behind a small storage interface. A local disk driver (a Docker volume) implements the same interface for development and for servers outside Google Cloud. Whole-property scans are large: size the bucket and the VM disk from the benchmark numbers and the retention settings.
- Odoo is the source of truth for customers. Only cache partner id, display name and city.
- Retention settings: original uploads deleted after X days (default 90, they're huge), everything else kept for a configurable period (default 2 years). A nightly cleanup job removes the database rows and files; on Google Cloud a bucket lifecycle rule also deletes originals after the same period, as a safety net.
- Admin can fully delete a job (files, renders, photos, reports, share links). Copies in backups disappear when those backups expire (soft delete and backup retention, at most about 30 days); the privacy text says so.
- Scans and photos show neighbours' property. The crop removes it from everything the customer receives, marker photos lose their EXIF and GPS data, and customer pages stay unlisted and unguessable.
- Customer pages must be reachable from the internet. Make it possible (by config) to limit the staff app to their own network or VPN.

## Default stack (change only with a good reason)

- pnpm monorepo: `apps/web`, `apps/api`, `apps/worker`, `packages/shared` (types, camera path math, scene code shared by viewer and renderer).
- Frontend: React + TypeScript + Vite + Tailwind (the maintainer already knows this stack), react-three-fiber + drei.
- Backend: Node + TypeScript (Fastify or Hono), Postgres with Drizzle, pg-boss as job queue (no Redis needed).
- Uploads: Cloud Storage's resumable upload protocol, straight from the browser to the bucket on Google Cloud; the local disk driver implements the same protocol in the API. (tus was the first choice; it is dropped because it would route every upload through the VM, see `PLAN.md` section 1.)
- Worker: Node + Playwright + ffmpeg in its own container, plus GDAL from phase 2.
- Deploy: Docker Compose on one Compute Engine VM, set up with OpenTofu (`infra/gcp/`). The same compose file runs on any x86_64 Linux server with Docker. Caddy for HTTPS by default, but it must also work behind an existing reverse proxy (Nginx or Traefik). The dev compose also runs a local Odoo (same major version as production) with its own Postgres.
- Tests: Vitest for units, Playwright for end-to-end, integration tests against the local Odoo.

## Test data

- I'll put real DJI exports (before and after of the same property) in `./samples/`. If they're missing, generate a small synthetic textured property in two versions: "before", and "after" with changes on the roof (for example a net over part of the roof) and on the ground (for example filled rat holes and a bait box). Give both a fake `metadata.xml` with the same big RD-style or UTM coordinates, so recentering and alignment get tested.
- Generate a size-realistic synthetic whole-property export as well (millions of triangles, dozens of 4096 px textures) for the processing benchmark, until a real one is available.
- For phase 2: give the synthetic property known dimensions so measuring tools can be tested against exact values (see the tests in "Phase 2: how every measurement is calculated"), and generate a small fake orthophoto GeoTIFF.
- A few test photos with EXIF and GPS data, to prove the stripping.
- Seed the local Odoo with one company, two customers, two draft invoices and a few products for the quote builder, and create the custom field by script.
- Main phase 1 e2e test: upload the before and after samples, process them, draw a boundary, place one red marker on the roof and one on the ground with a photo, place one green marker, render a 5 second low-res video, verify nothing outside the boundary is in `web.glb`, link it to a draft invoice in the local Odoo, assert the field and note exist, open the share page and open a pin's photo.

## Milestones

Phase 1 (ship this first, it needs to be on real invoices fast):
- M0: architecture and data model for all phases, scaffold, Docker dev environment (Postgres, local Odoo), CLAUDE.md, one command that runs lint, typecheck and tests.
- M1: upload (before and after), processing pipeline for whole-property exports, crop tool and cropped derivatives, alignment, viewer with Voor/Na toggle, and the processing benchmark report.
- M2: markers anywhere on the mesh with presets, marker photos (upload, EXIF stripping, customer view), camera path fitted to the cropped area, before/after render worker (with optional photo insets), branding settings with the placeholder logo and green/red.
- M3: share page (pins with photos), Odoo invoice link, manual mode, email template instructions, plus a short Dutch guide (`HANDLEIDING.md`) for the owner and employees: how to export from DJI Terra for this app, how to draw the boundary, how to add photos and how to use it.
- M3b: Google Cloud production setup (after the hosting proposal is approved; it can run in parallel with M1 to M3 once the project exists): OpenTofu under `infra/gcp/`, the Cloud Storage and Secret Manager adapters, backups with a tested full restore, monitoring and alerts, the billing budget, one-command deploy, `docs/runbook.md` with every IAM role, server requirements.

Phase 2:
- M4: measuring tools in 3D (roof and ground) with the methods, uncertainty, control measurements and provenance from "Phase 2: how every measurement is calculated", the "Hoe berekend?" panel, orthophoto 2D view.
- M5: quote builder to Odoo (mappings with extra percentage, rounding and minimum; the calculation in the line description), inspection report PDF with the "Meetverantwoording" appendix, inspection page for the customer.

Phase 3:
- M6: notes, job photos, annotated screenshots, audit log.
- M7: job timeline with Odoo status sync, customer job page, dashboard, on-site PWA polish.

Phase 4:
- M8: whatever from phase 4 is still worth it by then. Only after I say go.

## Done when

Phase 1:
- An employee gets from two DJI exports to a cropped before/after video with marker photos, linked on an invoice, in under 10 minutes of clicking (uploading and processing time not counted).
- Processing time, peak memory and `web.glb` / `render.glb` sizes are measured on a whole-property sample and reported.
- Render time is measured on the whole-property sample on a machine without GPU and reported. Up to about 30 minutes per video is fine at this volume. If it's worse, tell me with real numbers and options.
- A downloaded `web.glb` from a share page contains nothing outside the boundary, and customer photo copies contain no EXIF or GPS data (tested).
- Everything works in manual mode without Odoo.
- All tests green, no secrets in the repo, deploy, backup and restore steps written down and tested.
- Production on Google Cloud is created from `infra/gcp/` without clicking in the console (except what Google requires, such as the billing account), and a full restore into a fresh environment has been done once.

Phase 2:
- An employee measures a property and gets a draft quote with the right quantities into Odoo in under 15 minutes.
- Measurement error against the tape-measured references is reported.
- Every number on a quote, report or customer page can be traced to its points, method, model file and algorithm version, and the shown ± is backed by the resolution estimate or by control measurements.

Phase 3:
- One link per job tells the customer the whole story.
- Job statuses match Odoo without manual work.
