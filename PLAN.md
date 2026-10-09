# Plan

Status on 2026-10-09: the clickable preview is done and merged (`preview/`). The 10 decisions in section 1 were approved on 2026-10-09 and M0 is built (scaffold, login with TOTP, Docker, CI, `docs/architecture.md`). Two changes came in the same day: traceable measurements and hosting on Google Cloud. Decisions 11 to 20 below are proposed for them and wait for an OK; the hosting proposal with costs is `docs/gcp-hosting.md` (summary in section 9). M1 waits for the answers in section 7, above all a real whole-property export. `SPEC.md` holds the requirements; this file holds how I intend to build them, with the numbers behind the choices.

## 1. Decisions (approved 2026-10-09)

Proposed in the first planning round:

1. **One `apps/server` instead of `apps/api` + `apps/worker`.** Same code, two entrypoints (API, worker), two Docker images (slim API, heavy worker with Chromium, ffmpeg, later GDAL). The API also serves the built web app. Saves a package of shared server code. Scene code lives in `apps/web`, because the render route is a web route.
2. **Hand-rolled auth.** argon2id, DB sessions, `otpauth` for TOTP, Fastify rate limiting. About 300 lines, no auth framework.
3. **Share page: video first, 3D on tap.**
4. **Odoo video field created in developer mode, not Studio** (Studio prefixes `x_studio_`); field name configurable.
5. **GPU rendering is a config switch, untested** until there is a GPU machine.
6. **Alerts through Uptime Kuma polling a health endpoint**, no mail server in the app.
7. **Audit log table from M0**, UI in phase 3.
8. **Data model designed for all phases now, tables created per milestone.**
9. **One coordinate convention:** everything stored in job-local metres east/north/up; conversion to three.js Y-up in one function.

Changed by the new measurements:

10. **KTX2 textures for `web.glb` after all.** I proposed WebP-only earlier. A whole property has many texture pages, and decoded WebP needs about 4x the GPU memory of KTX2 ETC1S (340 MB vs 85 MB measured for 64 pages at 1024 px). That is the difference between working and crashing on many phones. WebP stays the fallback.

Decision 6 (Uptime Kuma) is superseded by decision 19.

### Proposed 2026-10-09, waiting for an OK

Traceable measurements (`docs/measurements.md` has the methods, formulas and the worked example):

11. **Final values are computed on `work.glb`, not on `render.glb`.** The change request said "render.glb (or the original)". But `render.glb` is simplified to about 1.5 M triangles for the renderer, which rounds off edges and ridges by centimetres. And the original upload is deleted after 90 days, so a measurement could not be recomputed or checked later. `work.glb` is the original geometry, losslessly converted, and kept as long as the job. M1 therefore keeps `work.glb` unsimplified and unquantized.
12. **Measurement revisions are append-only.** A database trigger refuses updates. Quotes, reports and customer pages store the revision id plus a copy of the values they showed. Each revision stores its algorithm version and every parameter it used, so a changed setting or a better algorithm never changes an old number. Recalculating is an explicit operator action that creates a new revision.
13. **Uncertainty:** @@SIGMA_DECISION@@
14. **The inputs are captured from the first upload (M1),** not from M4: file hashes, coordinate systems and vertical datum, the projection scale and NAP offset at the job origin, the median texel size, the Terra quality report's GSD when present, and tool versions. That is the "store the data from M0" part. M0 itself has no scans, so nothing changes in its tables; the storage layer now returns a SHA-256 for every file it writes.

Google Cloud (proposal and costs in `docs/gcp-hosting.md`):

15. **Uploads go straight from the browser to the bucket** with Cloud Storage's resumable protocol, and the local disk driver implements the same protocol in the API. tus is dropped. Through the VM, every upload of up to 3 GB would pass Caddy and Node, need the VM disk as a staging area, and break on every deploy. Straight to the bucket, it uses Google's upload front ends and survives a restart of the app. The API still decides the object name and exact size, and the import verifies size and hash.
16. **Database:** @@DB_DECISION@@
17. **Secrets reach the app as files, not through a Google SDK.** A boot unit on the VM reads them from Secret Manager with the VM's own credentials into a tmpfs, and compose mounts them (`<NAME>_FILE`). The app keeps zero Google code for secrets and runs unchanged anywhere, and secrets stay out of the environment that Chromium and ffmpeg inherit. Built now: `config.ts` reads `<NAME>_FILE` and `DATABASE_PASSWORD`. There is no session secret to store: sessions are random tokens, and the database keeps only their SHA-256.
18. **Caddy keeps doing HTTPS on the VM,** with Let's Encrypt. A Google load balancer with a managed certificate costs about $18 a month plus traffic, and adds moving parts for a single VM.
19. **Cloud Monitoring replaces Uptime Kuma:** uptime checks on `/health` and on a customer page, log-based alerts for failing renders and Odoo calls, Ops Agent for logs and metrics, e-mail alerts.
20. **OpenTofu rather than Terraform.** It is the same HCL and the same Google provider, under the open MPL licence instead of BUSL. Switching to Terraform later would be a one-line change.

## 2. What the whole-property scope changes

### 2.1 Crop to the property

- **Server-enforced.** A viewer-only clip would still ship the neighbours' geometry and textures inside `web.glb`. The worker produces every customer file from a cropped copy:
  1. remove triangles whose centroid lies outside the boundary prism;
  2. drop texture pages no remaining triangle uses;
  3. blank texels used only by removed triangles (rasterise the kept triangles' UV footprints into a mask, fill the rest with a neutral colour). Measured: about 20 % of a kept page was still outside imagery before masking;
  4. remove small disconnected fragments (a 2D boundary cuts overhanging tree crowns and leaves floating pieces of the neighbour's tree);
  5. derive `render.glb`, `web.glb` and the thumbnail from the result.
- **Boundary model:** one per job, in job-local E/N metres: `{ polygon: [[e, n], ...], kind: 'polygon' | 'box' | 'none', source: 'manual' | 'cadastre', zMin, zMax, version }`. Both scans use it. Changing it bumps `version`, re-derives the customer files (about 1 minute for a large property) and marks existing videos outdated.
- **Editor:** a top-down orthographic view of the full model. Draw or edit a polygon, or a rotated box, with a buffer slider (-2 to +3 m). The outside stays visible to the operator, dimmed; a "klantweergave" toggle previews exactly what the customer gets.
- **Cadastral pre-fill (optional, never blocking):** the server fetches parcels from PDOK's Kadastrale Kaart, OGC API Features `https://api.pdok.nl/kadaster/brk-kadastrale-kaart/ogc/v1/collections/perceel/items`. Query by bounding box in EPSG:28992 (0.4 to 0.9 s); point-only CQL queries took 13 to 33 s. Point-in-polygon runs locally.
  - **Seed parcel:** the job address via PDOK Locatieserver, else the dominant BAG building inside the model, else the model centre. Neighbouring parcels show as clickable outlines to add (union), for example a separate driveway parcel.
  - **Coordinates:** UTM 31N to RD New with PROJ and the official RDNAPTRANS2018 grid (`nl_nsgi_rdtrans2018.tif`, 278 KB, bundled in the image). The RD New proj4 string on epsg.io is about 175 m off; never use it.
  - **Expect a 0.4 to 1.5 m offset** from map accuracy (quality labels C to E), ETRS89 vs WGS84 (about 0.9 m) or an unsurveyed RTK base. So the outline can be dragged and nudged before applying.
  - **Licence:** CC BY 4.0. Label it "Indicatieve perceelgrens (Kadaster)" and credit "© Kadaster" on the customer page when a pre-fill was used. Store the raw parcel GeoJSON, endpoint and fetch time with the job.
- **Rules:**
  - Markers outside the boundary are flagged and never shown to the customer.
  - Sharing and rendering need a boundary or an explicit "geen uitsnede" confirmation.
  - The e2e test downloads `web.glb` from the share page and asserts no vertex lies outside the boundary.

### 2.2 Markers anywhere

- **Placement:** raycast on the full mesh (three-mesh-bvh for speed on millions of triangles). Each marker stores position and surface normal. A surface class (roof, wall, ground) is derived from the normal and the height above local ground, and the operator can override it. The class drives the camera angle in the video.
- **Labels:** presets are extended with the land problems and solutions, and pest types are a seeded, editable list (see SPEC).
- **"In video" flag** per marker, because a whole property easily gets 10+ pins. The time per marker shrinks towards a configurable minimum, and the total target is 30 to 90 s.

### 2.3 Photos on markers (phase 1)

- **Upload:** operators attach photos to a marker from desktop or phone. Plain multipart upload with a size cap (photos are small; tus is for scans).
- **Processing** (worker, sharp):
  - apply the EXIF orientation, resize to max 2048 px, re-encode to JPEG or WebP q82; this drops all metadata, including GPS;
  - also make a 400 px thumbnail;
  - read the capture time from EXIF before stripping and store it in the database;
  - keep the original staff-only, under the originals' retention;
  - a test asserts the customer copy has no EXIF or GPS.
- **HEIC:** iPhones shoot HEIC. sharp's prebuilt binaries do not decode HEIC, so convert with `heic-convert` (WASM) in the worker. Also check in M2 whether iOS Safari already sends JPEG through the file input; it usually does.
- **Customer side:** clicking a pin opens a small sheet with the label and its photos (swipeable). The 3D note cards from the preview are the visual model.
- **Video inset (optional):** during a marker's hold, the first photo appears next to the lower third, framed and with a soft drop shadow. The inset is per-marker opt-out, because videos get forwarded.

### 2.4 Camera path fitted to the crop

- **Centre:** the area-weighted centroid of the boundary polygon. The look-at height is the median mesh height inside the boundary.
- **Distance per angle:** for each orbit angle, project the boundary prism (polygon at ground level up to the 95th-percentile mesh height inside it) into the camera and solve the distance that keeps it within the frame margin. Smooth the distances with a circular moving average, so elongated plots (typical Dutch 10 x 40 m gardens) get a smooth, ellipse-like orbit instead of a circle that is either too far or cuts off the garden.
- **Pitch:** about 35 degrees by default, 45 degrees for very large plots. Sliders adjust height, distance and speed.
- **Marker visits** come after the orbit, as in the preview:
  - Ground markers get a low angle (about 30 degrees) at 3 to 5 m; roof markers about 45 degrees.
  - Moves between markers "hop": they climb to the highest obstacle along the path plus a clearance, sampled with BVH raycasts on the cropped mesh, so the camera goes over trees instead of through them.
  - Visit order is optimised for path length (nearest neighbour plus 2-opt, a few lines of code) unless the operator reorders.
- **One source of truth:** the path stays a JSON keyframe list, and the browser preview and the renderer both sample it.

### 2.5 Bigger exports

Measured in two ways (details in section 3):

1. a synthetic Terra-like whole property of 30 x 50 m at three sizes, through the real tools;
2. DJI's own Terra sample export (Mavic 3E RTK, 70 photos), which grounds the extrapolation to real Terra densities.

What it means:

- **Real Terra exports are smaller than I feared.** With the reconstruction region (ROI) set to the property, a 0.1 to 0.5 ha property at 25 to 30 m altitude should export about 0.2 to 3.3 M faces and 50 to 550 MB. This is extrapolated from one real sample; without an ROI, expect 2 to 4x more.
- **Processing time is a non-issue:**
  - about 0.5 / 1.3 / 2.6 minutes for 2 / 6 / 12 M triangles on 4 cores, from import to all cropped derivatives;
  - each pipeline step peaks under 3 GB of RAM;
  - `obj2gltf` grows about 0.18 GB per million triangles.
- **The video renderer drives server RAM.** At 1.5 M triangles with 64 textures at 4096 px, headless Chromium used 10.6 GB; with textures capped at 2048 px it was 3.0 GB at the same speed. So `render.glb` gets a texel budget.
- **`web.glb` under 25 MB is easy if the texture budget holds:** 500k triangles cost only 2.6 to 3.4 MB with meshopt, so textures decide the size.

## 3. Benchmark numbers

Machine: 4 vCPU, 15.7 GB RAM, no GPU. Tools: obj2gltf 3.2.0, @gltf-transform/cli 4.5.1 (meshoptimizer), sharp 0.35.5, three 0.170.0, Chromium 1194 with SwiftShader. Synthetic property 30 x 50 m: S = 2 M triangles and 12 JPG pages at 4096 px; M = 6 M and 32 pages; L = 12 M and 64 pages. The synthetic textures are denser than a real Terra export (1.7 to 4.2 mm per texel vs about 1 cm), so texture-driven numbers are conservative.

**Processing (time / peak RAM / output)**

| Step | S | M | L |
|---|---|---|---|
| Export size on disk | 179 MB | 554 MB | 1.12 GB |
| OBJ to GLB (obj2gltf) | 9 s / 0.5 GB | 26 s / 1.0 GB | 53 s / 2.1 GB |
| web.glb, 500k tri, 2048 WebP, meshopt | 5 s / 8.4 MB | 11 s / 19.8 MB | 22 s / 37.5 MB |
| render.glb, 1.5 M tri, original JPG | 3 s / 76 MB | 6 s / 149 MB | 14 s / 276 MB |
| Crop (61 % of area) + texture mask | 12 s / 0.9 GB | 31 s / 1.2 GB | 60 s / 2.9 GB |
| web.glb from the crop | 3 s / 4.5 MB | 7 s / 10.9 MB | 12 s / 20.6 MB |

**web.glb in the browser (500k triangles, 1280 x 720, SwiftShader)**

| Variant | File | Est. GPU textures | First frame |
|---|---|---|---|
| L, 64 x 2048 WebP | 37.5 MB | 1362 MB | 19.3 s |
| L, 64 x 1024 WebP | 14.0 MB | 340 MB | 3.8 s |
| L, 64 x 1024 KTX2 ETC1S | 13.4 MB | 85 MB | 2.2 s |
| L, 64 x 512 WebP | 6.1 MB | 85 MB | 1.2 s |

At 20 Mbit/s: 2048 WebP takes 15.9 s to download plus 14.8 s to the first frame; KTX2 1024 takes 5.7 s plus 2.3 s.

**Renderer (render.glb, 1.5 M triangles, 1080p, SwiftShader)**

| Textures | Chromium RAM | First frame | Per frame |
|---|---|---|---|
| 12 x 4096 | 2.4 GB | 14 s | 413 ms |
| 64 x 4096 | 10.6 GB | 70 s | 461 ms |
| 64 x 2048 | 3.0 GB | 15 s | 410 ms |

A 45 s video at 30 fps is 1350 frames: about 9 to 10 minutes at 1x, and an estimated 25 to 35 minutes with 2x supersampling (4x the pixels). Frame capture and ffmpeg are not included. That sits at the edge of the 30-minute budget, so M2 measures the real number, and I may use 1.5x supersampling or a lighter `render.glb` (about 1 M triangles) if needed.

**DJI's own Terra sample (real data):** 380k faces, 3 JPG atlases (one 8192, two 4096), 6.1 cm GSD, only 38 % of the atlas area used.

- Converting to GLB took 1.9 s.
- `web.glb` was 9.6 MB in 6.3 s.

## 4. Budgets and limits (proposed defaults, all configurable)

| What | Default | Why |
|---|---|---|
| Max upload | 3 GB | typical 50 to 550 MB with a Terra ROI; headroom for exports without an ROI |
| Max input triangles | hard 12 M, warn above 3 M | 12 M measured fine; above 3 M the operator should tighten the ROI or Reduce Model |
| Max blocks | 4, warn above 1 | Terra multi-block OBJ corruption status unknown |
| Max texture pages | 64, each up to 8192 px | |
| web.glb | 500k triangles, about 64 Mpx of KTX2 ETC1S textures (e.g. 64 x 1024 or 16 x 2048), meshopt; target 8 to 15 MB, hard cap 25 MB | GPU memory on phones |
| render.glb | 1.5 M triangles, about 270 Mpx of textures (e.g. 64 x 2048) | renderer RAM stays near 3 GB |
| Simplify | ratio = target / input together with error 0.02 | a strict error setting stops early on trees and hedges (measured 781k and 1.2 M instead of 500k) |
| Worker | one job at a time, Node `--max-old-space-size` set explicitly | |
| Server | 4 vCPU, 16 GB RAM (8 GB works with the texture caps), disk about 2.5 GB per job during processing | |

Gotchas found while measuring, for `CLAUDE.md`:
- The gltf-transform CLI `resize` command silently drops meshopt compression, so do resize, KTX2/WebP and meshopt in one pass.
- OBJ without normals needs `--unlit`, which is right anyway for photogrammetry.
- obj2gltf 3.1.6 crashes with a current Cesium (3.2.0 worked); pin versions.
- KTX2 encoding needs KTX-Software 4.4 or newer in the worker image. The WASM encoder works but takes 3 s per 1024 texture, which is fine at 5 jobs a month.

## 5. Data model (all phases)

Phase in brackets; tables are created by migrations in their milestone.

- `users`, `sessions`, `settings`, `audit_log` (M0)
- `jobs` (P1):
  - Odoo partner id plus cached name and city;
  - date, pest types, status;
  - job origin and SRS, the vertical datum, the projection scale at the origin and the offset to NAP when known (decision 14);
  - `boundary` (jsonb, see 2.1) and `boundary_source_data` (raw cadastral GeoJSON, endpoint, fetch time).
- `scans` (P1):
  - voor/na, processing state, SRS (horizontal, vertical, WKT as read), offset to the job origin, manual nudge, up axis;
  - stats (triangles, pages, texels), the median texel size, and the GSD from a Terra quality report when present;
  - a hash over the uploaded files and the pipeline's tool versions;
  - `derived_boundary_version`, so outdated customer files are detected.
- `files` (P1): every stored file with kind, retention class, size and SHA-256. Kinds:
  - scan files: original upload, `work.glb` (full model, staff), `crop.glb`, `render.glb`, `web.glb`, thumbnail;
  - video files: video, video poster;
  - photo files: original, customer copy, thumbnail;
  - later: orthophoto (P2), measurement screenshot (P2), report PDF (P2), screenshot (P3).
- `upload_sessions` (P1): only for the local disk driver, which speaks the resumable protocol itself (decision 15).
- `markers` (P1): scan, kind (problem or solution), label, order, position and normal, surface class, `in_video`, `copied_from`.
- `marker_photos` (P1): marker, original file, customer file, thumbnail file, `taken_at`, order, `show_in_video`.
- `label_presets` (P1): kind, label, order, active. Pest types are seeded in `settings`.
- `camera_paths` (P1): orbit parameters, the fitted per-angle distances, keyframes, version.
- `renders` (P1): frozen snapshot of the path, branding and boundary version; status, timings, output files.
- `share_links` and `share_link_daily_views` (P1); `odoo_links` and `odoo_sync_log` (P1, M3).
- `measurements` and `measurement_revisions` (P2): the measurement with its name and tag, and its append-only revisions with points, view rays, method, model hash, algorithm version and parameters, values, uncertainty and screenshot (decision 12).
- `control_measurements` (P2): tape-measured value, model value and deviation per checked value.
- `quote_mappings` (P2): measurement type and value, product, extra percentage and its label, rounding rule and step, minimum quantity.
- `quotes`, `reports` (P2): snapshots of what was issued, with the revision ids used.
- `notes`, `job_photos`, `screenshots`, `job_status_history` (P3)

Worker queues:
- `scan.import`: unpack, validate, OBJ to GLB, `work.glb`;
- `scan.derive`: crop, mask, `render.glb`, `web.glb`, thumbnail; runs on boundary changes;
- `photo.process`;
- `render.video`;
- `cleanup.nightly`;
- `odoo.link` (M3);
- `backup.db` (M3b, only with Postgres on the VM);
- `measurement.compute` (M4): re-project the picks onto `work.glb`, compute values and uncertainty, render the screenshot;
- `report.generate` (M5).

## 6. Milestones (updated)

- **M0:** as planned (scaffold, Docker dev with Postgres and local Odoo, auth, `CLAUDE.md`, `docs/architecture.md`). The architecture doc covers the crop, photos and fitted camera path from the start.
- **M1:**
  - upload and import: OBJ and GLB, up to 4 blocks merged, limits from section 4;
  - resumable uploads with Cloud Storage's protocol, served by the local disk driver for now (decision 15);
  - provenance for later measurements: file hashes, SRS and vertical datum, projection scale and NAP offset, median texel size, Terra quality report GSD when present, tool versions (decision 14); `work.glb` stays lossless (decision 11);
  - alignment and the operator viewer;
  - boundary editor with the optional PDOK pre-fill;
  - `scan.derive` (crop, mask, fragment cleanup, KTX2/meshopt `web.glb`, `render.glb`);
  - a "klantweergave" preview;
  - a benchmark report on the synthetic samples and on the first real export.
- **M2:**
  - markers anywhere with surface class, presets and the in-video flag;
  - marker photos (upload, HEIC, EXIF strip, customer view);
  - fitted orbit with marker hops;
  - render worker with optional photo insets;
  - measured render time on a whole property;
  - branding settings.
- **M3:** as planned, without the operations part (moved to M3b); the share page gets pins with photo sheets; `HANDLEIDING.md` covers the Terra export settings (section 7) and drawing the boundary.
- **M3b, Google Cloud** (after the OK on `docs/gcp-hosting.md`; it can start as soon as the project exists, in parallel with M1 to M3):
  - OpenTofu under `infra/gcp/` with a README, state in a versioned bucket;
  - the Cloud Storage adapter (uploads, signed URLs) and the secrets boot unit;
  - backups and one full restore into a fresh environment, written down;
  - monitoring and alerts, the billing budget;
  - one-command deploy through Artifact Registry;
  - `docs/runbook.md` with every IAM role and who has it, and `docs/server-requirements.md`.
- **M4:** measuring as in SPEC, implemented exactly as `docs/measurements.md`: the math in `packages/shared` with the exact-geometry and Monte Carlo tests, `measurement.compute`, revisions, control measurements and their statistics in settings, the "Hoe berekend?" panel; the 2D orthophoto view on the cropped area.
- **M5:** quote builder with the calculation in the Odoo line description, inspection report with the "Meetverantwoording" appendix, inspection page.
- **M6 to M8:** as in SPEC.

## 7. Open questions for the owner (updated)

1. **Odoo version**: Instellingen, at the bottom (for example "saas~19.3").
2. **Odoo plan**: Standard or Custom? The invoice link needs Custom; without it, manual mode.
3. **Are jobs planned in Odoo** (Buitendienst, Project, Planning)?
4. **When does the invoice go out** relative to the work?
5. **DJI Terra:**
   - version (5.3.5 is current, and older versions can no longer be downloaded);
   - output coordinate system;
   - whether a reconstruction region (ROI) is used;
   - quality and "Reduce Model To" settings.
6. **RTK correction source**: a network service such as 06-GPS, or a D-RTK base on an unsurveyed point? This decides how far the cadastral outline will be off.
7. **Drone model**: Mavic 3E, Matrice 4E or other.
8. **Domain for share links; retention** (default: originals 90 days, everything else 2 years).
9. **A real before/after whole-property export with consent**: needed for the M1 benchmark and the render test. If Terra writes a quality report, include it: it states the GSD.
10. **Google Cloud**: is there an organization and project already, who owns the billing account, and which Google accounts (company e-mail addresses, no personal ones) should get admin and deploy access?
11. **Does their Odoo run in this Google Cloud project?** I assume not (it is Odoo Online). If it did, the app would talk to it over the private network, and a custom Odoo module would become possible.
12. **Monthly budget limit** for the billing alerts at 50, 90 and 100 %.
13. **Tape measures for control measurements**: on the first real jobs, measure a few edges and areas by hand (gutter length, a flat roof part, a driveway), so the accuracy shown to customers is backed by real deviations as soon as possible.

Draft export settings for the owner, to confirm on a real job:
- Quality High, "Reduce Model To" 50 %, format OBJ only.
- ROI drawn around the property with 5 to 10 m margin, tree tops included.
- One block; "Output Editable in DJI Modify" off.
- Default UTM output, Custom Model Origin off.
- Upload only the OBJ output folder, never the Terra project folder: DJI's sample project was 3.9 GB for a 34 MB mesh.

## 8. Unverified, to check on the first real export

- The exact Terra `metadata.xml` schema and OBJ layout (folder `terra_obj` or `terra_objs`, normals or not, precision).
- Whether the multi-block OBJ corruption (Terra 3.7+) is fixed in 5.3.5. It is not in the release notes.
- Real texel density, page count and size per property (all extrapolated from one 6 cm GSD sample).
- Render time with supersampling, frame capture and ffmpeg included.
- iOS behaviour for HEIC uploads, and GPU memory limits on older iPhones.
- Which vertical datum Terra writes in `metadata.xml` for the chosen output (ellipsoidal or NAP), and whether its quality report is part of the OBJ output folder and in what format (for the GSD).

## Sources

- PDOK Kadastrale Kaart OGC API: https://api.pdok.nl/kadaster/brk-kadastrale-kaart/ogc/v1
- PDOK BAG OGC API: https://api.pdok.nl/kadaster/bag/ogc/v2
- DJI Terra manual (3D mesh options, ROI, coordinate systems, known issues, release notes): https://terra.dji.com/user-manual/en/
- DJI Terra downloads: https://enterprise.dji.com/dji-terra/downloads
- Nira on corrupt multi-block OBJ in Terra 3.7+: https://help.nira.app/articles/18613464828059-dji-terra-370-and-newer-may-export-corrupt-obj-files
- meshoptimizer: https://meshoptimizer.org/
- obj2gltf: https://github.com/CesiumGS/obj2gltf
- WebGL MAX_TEXTURE_SIZE survey: https://web3dsurvey.com/webgl2/parameters/MAX_TEXTURE_SIZE
- Benchmark scripts and raw logs are in the session scratchpad, not committed (`bench/pipeline/scripts/`, `bench/terra-export-size/scripts/`, `bench/cadastral-prefill/`); they move into the repo with M1.
