# Architecture

How the property scan platform is built, for all four phases. `SPEC.md` says _what_ to build, `PLAN.md` holds the measured numbers and the approved decisions, and this file says _how_. Sections marked with a milestone (M1, M2, …) describe design that is not built yet; everything else exists in the code.

## 1. Principles

- **Small and boring.** About 5 jobs a month and one maintainer. No microservices, no Redis, no Kubernetes, no build step for the server. Prefer one obvious way over a clever one.
- **Postgres is the system of record** for app data and the job queue. Files live in a Cloud Storage bucket in production and on a local disk in development, behind one small storage interface (§7).
- **Portable.** Production runs on Google Cloud (§18), but Google-specific code lives only in the storage adapter and in `infra/gcp/`. The same images run on any Linux server with Docker.
- **Odoo stays the source of truth** for customers, quotes and invoices. This app caches only a partner id, display name and city.
- **Privacy by construction.** Everything a customer can download is generated from a copy cropped to the property boundary. Photos lose EXIF and GPS. Share links are unguessable and unlisted.
- **One source of truth per concept.** One coordinate convention (§8), one camera path function shared by preview and renderer (§11), one API contract shared by server and web (`packages/shared`).
- **Numbers are traceable.** Every measurement keeps its inputs, method, model hash and algorithm version, and documents keep the values they were issued with (§15, `docs/measurements.md`).

## 2. Repository and runtime

```
apps/server        Fastify API + background worker (one codebase, two modes)
apps/web           React staff app (Vite); later also the customer share page and the render route
packages/shared    API contract (zod), roles, coordinate conversion, branding defaults
e2e/               Playwright end-to-end tests
docker/            Caddyfile, dev database init
scripts/           odoo-init.sh (local Odoo)
preview/, bench/   the clickable demo and the benchmark scripts; not part of the app
```

**Processes.** `node apps/server/src/main.ts api` serves HTTP (and the built web app from `apps/web/dist`); `node apps/server/src/main.ts worker` runs pg-boss jobs. Both run TypeScript directly through Node's type stripping, so only erasable syntax is allowed and relative imports carry `.ts`. Node refuses to strip types inside `node_modules`, which is why the Docker image keeps the pnpm workspace layout (`@scan/shared` stays a symlink to `packages/shared`) instead of using `pnpm deploy`.

**Images.** One `Dockerfile` with two targets: `api` (slim) and `worker` (the same today; M2 adds Chromium and ffmpeg, M4 adds GDAL). `compose.yml` runs `db` (Postgres 18), `api`, `worker` and optionally `caddy` (profile `caddy`). The API publishes on `127.0.0.1:3000` so it also works behind an existing Nginx or Traefik. In production the same compose file runs on a Compute Engine VM with an override from `infra/gcp/` (§18).

**Startup.** The API runs migrations (under a Postgres advisory lock), seeds default settings and creates the first admin from `ADMIN_EMAIL`/`ADMIN_PASSWORD` when no admin exists. The worker does not migrate; Compose starts it after the API is healthy.

## 3. Request flow and security

**Authentication** (`apps/server/src/auth/`):

```
POST /api/auth/login (password ok)
  ├─ user has TOTP            → 'password' session, next = 'totp'        → POST totp/verify  → 'full'
  ├─ admin without TOTP       → 'password' session, next = 'totp_setup'  → POST totp/setup + totp/enable → 'full'
  └─ operator without TOTP    → 'full' session, next = null
```

- Passwords: argon2id (19 MiB, 2 passes, 1 lane). Unknown e-mail, wrong password and inactive account all answer the same `401 invalid_credentials` after the same argon2 work.
- Sessions: a random 256-bit token in the httpOnly cookie `sid` (SameSite=Lax, Secure when `COOKIE_SECURE=true`); the database stores only its SHA-256. `'password'` sessions live 10 minutes, `'full'` sessions `SESSION_TTL_DAYS` (absolute). Every step up to `'full'` issues a new token. A password change ends the user's other sessions. Expired sessions are deleted nightly (`cleanup.nightly`).
- TOTP: SHA1, 6 digits, 30 s, ±1 step. The accepted step is stored (`users.totp_last_step`) and only a newer step is accepted, so a code works once. Required for admins, optional for operators. `pnpm user:reset-totp` clears it for a lost phone.
- Rate limits (in memory, one API process): login 5/min per IP + e-mail and 30/min per IP; TOTP 5/min per user; password change 5/min per user.
- Guards (`requireSession`, `requireFull`, `requireRole('admin')`) are Fastify preHandlers.

**Request hygiene** (`apps/server/src/app.ts`, `security.ts`):

- State-changing `/api` requests must carry `Origin: <APP_ORIGIN>` (or `Sec-Fetch-Site: same-origin`). Bodies must be JSON; the `text/plain` parser is removed. Together with SameSite=Lax this covers CSRF.
- Helmet with a strict CSP (`default-src 'self'`, no inline scripts, `frame-ancestors 'none'`); HSTS and `upgrade-insecure-requests` only when `COOKIE_SECURE=true`.
- `STAFF_ALLOWED_CIDRS` (optional) limits everything except `/health`, `/v/*`, `/api/public/*`, `/assets/*` and the icons to the office or VPN networks, so customers can still open share pages (SPEC: Storage, retention, privacy).
- Errors: the server answers machine codes only (`{ "error": { "code": "invalid_code" } }`, see `ERROR_CODES`); the web app maps them to Dutch in `apps/web/src/nl.ts`. Stack traces are logged, never sent.
- Logs: JSON lines (pino) on stdout; Docker's json-file driver rotates them. Cookies and authorization headers are redacted.

## 4. Configuration

All configuration comes from the environment; `.env.example` is the contract and `apps/server/src/config.ts` validates it at startup with a message that names every invalid variable (never its value).

| Variable                      | Default                 | Notes                                                            |
| ----------------------------- | ----------------------- | ---------------------------------------------------------------- |
| `APP_ORIGIN`                  | `http://localhost:5173` | Public origin of the staff app; used for the Origin check        |
| `HOST`, `PORT`                | `0.0.0.0`, `3000`       |                                                                  |
| `TRUST_PROXY`                 | `false`                 | Number of proxies in front of the app, usually `1`; avoid `true` |
| `COOKIE_SECURE`               | `false`                 | `true` in production                                             |
| `SESSION_TTL_DAYS`            | `14`                    | 1 to 90                                                          |
| `STAFF_ALLOWED_CIDRS`         | empty                   | e.g. `192.168.1.0/24,10.8.0.0/24`                                |
| `DATA_DIR`                    | `./data`                | Files volume; `/data` in Docker                                  |
| `DATABASE_URL`                | required                |                                                                  |
| `DATABASE_PASSWORD`           | unset                   | Put into `DATABASE_URL` percent-encoded; any character works     |
| `DATABASE_URL_TEST`           | `…/scan_test`           | Wiped by the test suite; must be called `scan_test`              |
| `ADMIN_EMAIL/NAME/PASSWORD`   | unset                   | First admin, only while no admin exists                          |
| `ODOO_URL/DB/API_KEY`         | local Odoo              | Used from M3                                                     |
| `ODOO_DRY_RUN`                | `true`                  | Every Odoo write only logs what it would do                      |
| `ODOO_VIDEO_FIELD`            | `x_roof_video_url`      | Custom field on `account.move`                                   |
| `ODOO_VERSION`                | `19.0`                  | Local Odoo image (compose.dev.yml)                               |
| `DOMAIN`, `POSTGRES_PASSWORD` |                         | Production compose only                                          |

Secrets (`ADMIN_PASSWORD`, `ODOO_API_KEY`, `DATABASE_PASSWORD`) can also come from a file named by `<NAME>_FILE` (Docker secrets). On Google Cloud the VM writes them from Secret Manager to a tmpfs and the containers read them as files, so secrets are never in the process environment, which the worker's child processes (Chromium, ffmpeg) would inherit. M3b adds `STORAGE_DRIVER` (`local` or `gcs`) and `GCS_BUCKET`.

## 5. Data model (all phases)

Postgres, Drizzle ORM, migrations in `apps/server/drizzle/` generated from `apps/server/src/db/schema.ts`. Tables are created by the milestone that needs them (PLAN.md decision 8). Ids are UUIDs unless noted; every table has `created_at`. All geometry is in job-local metres east/north/up (§8).

### M0 (built)

| Table       | Columns                                                                                                                                         |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `users`     | email (unique, lower-case), name, role (`admin`/`operator`), password_hash, totp_secret, totp_enabled_at, totp_last_step, active, last_login_at |
| `sessions`  | id = SHA-256 of the token, user_id, stage (`password`/`full`), last_seen_at, expires_at                                                         |
| `settings`  | key, value (jsonb, validated by a zod schema per key), updated_by                                                                               |
| `audit_log` | bigint identity id, at, actor_id, action, target_type, target_id, details (jsonb; never IPs, passwords, codes)                                  |

Settings keys: `branding` now; later `label_presets` defaults, `pest_types`, `video` (timing, intro/outro texts), `share` (default expiry), `retention`, `measurement` (phase 2).

### Phase 1 (M1 to M3)

| Table                    | Main columns                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Milestone |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| `jobs`                   | odoo_partner_id, partner_name, partner_city (cache only), work_date, pest_types (text[]), status, origin_srs (e.g. `EPSG:32631`), origin_vertical (`EPSG:5709` NAP, `ellipsoidal` or null = unknown), origin_offset (E/N/U of the job origin in that SRS, double precision), projection_scale (scale factor of the SRS at the origin, from PROJ), nap_offset (metres to add to a local height for NAP; null when the vertical datum is unknown), boundary (jsonb, §9), boundary_source_data (raw cadastral GeoJSON, endpoint, fetched_at), created_by | M1        |
| `scans`                  | job_id, phase (`voor`/`na`), state (§5.1), srs, srs_vertical, srs_wkt (as read from `metadata.xml`), offset_to_job (E/N/U), nudge (E/N/U + yaw, manual alignment), up_axis (as delivered), stats (triangles, pages, texels, bbox), resolution_m (median texel size of `work.glb`), gsd_m and gsd_source (DJI Terra quality report, when present), source_sha256 (hash over the uploaded files' hashes), pipeline (app and tool versions, jsonb), derived_boundary_version, error_code, uploaded_by, processing timings                                | M1        |
| `files`                  | job_id, scan_id/marker_photo_id/render_id/measurement_revision_id (nullable owners), kind (§7), storage_key, size, sha256 (from `Storage.put`, or computed by `scan.import` for browser uploads), content_type, retention_class (`original`/`derived`), expires_at                                                                                                                                                                                                                                                                                    | M1        |
| `upload_sessions`        | storage_key, size, content_type, received (bytes), expires_at, created_by. Only for the local disk driver, which speaks Cloud Storage's resumable protocol itself (§7)                                                                                                                                                                                                                                                                                                                                                                                | M1        |
| `markers`                | scan_id, kind (`problem`/`solution`), label, sort_order, position (E/N/U), normal, surface_class (`roof`/`wall`/`ground`, auto + override), in_video, copied_from (marker id; pairs problem ↔ solution), note (phase 3)                                                                                                                                                                                                                                                                                                                               | M2        |
| `marker_photos`          | marker_id, original_file_id, customer_file_id, thumb_file_id, taken_at, sort_order, show_in_video                                                                                                                                                                                                                                                                                                                                                                                                                                                     | M2        |
| `label_presets`          | kind, label, sort_order, active, suggests (solution ids for a problem preset)                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | M2        |
| `camera_paths`           | job_id, version, params (§11), fitted_distances, keyframes (jsonb)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | M2        |
| `renders`                | job_id, state (§5.1), snapshot (path, markers, branding, boundary version; frozen so a re-render is reproducible), progress, timings, error_code, video_file_id, poster_file_id, rendered_by, outdated                                                                                                                                                                                                                                                                                                                                                | M2        |
| `share_links`            | job_id, token (32 random bytes, base64url), created_by, expires_at, revoked_at                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | M3        |
| `share_link_daily_views` | share_link_id, day, views (no IPs, no user agents)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | M3        |
| `odoo_links`             | job_id, move_id, move_name, linked_at, linked_by, field_written, note_message_id                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | M3        |
| `odoo_sync_log`          | at, operation, model, method, record_ids, dry_run, ok, duration_ms, error (never secrets)                                                                                                                                                                                                                                                                                                                                                                                                                                                             | M3        |

### Phase 2 and 3

Measurements follow `docs/measurements.md`. Revisions are append-only: a database trigger refuses `UPDATE` on `measurement_revisions`, and rows only disappear when the whole job is deleted.

| Table                   | Main columns                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Phase |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| `measurements`          | job_id, scan_id, kind (`distance`/`length`/`height`/`roof_area`/`ground_area`), name, tag, view (`3d`/`2d`), current_revision_id, created_by, deleted_at (soft delete: issued documents may still refer to it)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | 2     |
| `measurement_revisions` | measurement_id, revision (1, 2, …), reason (`created`/`edited`/`recalculated`), method (`distance_3d`/`polyline_3d`/`height_diff`/`plane_fit`/`mesh_clip`), algorithm_version, params (jsonb: every threshold and factor used), model_file_id and model_sha256 (`work.glb`), pick_sha256 (the browser mesh the points were picked on), points (jsonb: per point the view ray, the picked point, the final point on `work.glb`, its original-SRS coordinates, the difference and a flag), values (jsonb: length, height, area along the slope, area from above, pitch, flatness RMS, vertex and triangle counts), uncertainty (jsonb: source `resolution`/`control`, resolution, σ per point, σ per value, the control statistics used), screenshot_file_id, created_by, created_at | 2     |
| `control_measurements`  | measurement_id, revision_id, quantity (which value was checked), tape_value, model_value, deviation (model − tape), relative_deviation, instrument (`meetlint`/`laser`), note, entered_by, entered_at                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | 2     |
| `quote_mappings`        | name, measurement_kind, value (`area_slope`/`area_plan`/`length`/`distance`/`height`/`fixed`), tag, odoo_product_id (+ cached name and unit), extra_percent, extra_label (e.g. "overlap"), rounding (`up`/`nearest`/`none`), rounding_step (1, 0.5, 0.1), min_quantity, fixed_quantity, active, sort_order                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | 2     |
| `quotes`                | job_id, version, odoo_sale_order_id, lines (jsonb snapshot per line: mapping, measurement revision ids, measured value, extra, raw and rounded quantity, minimum applied, the Dutch description as sent), pushed_at, pushed_by. Never changed after the push; a change is a new version                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | 2     |
| `reports`               | job_id, kind (`inspection`), file_id, measurement_revision_ids (uuid[]), snapshot (jsonb: the "Meetverantwoording" values as printed), generated_at, generated_by, odoo_attachment_id                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | 2     |
| `notes`                 | job_id or marker_id, body, visibility (`internal`/`customer`), author_id                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | 3     |
| `job_photos`            | job_id, original_file_id, customer_file_id, thumb_file_id, taken_at, caption, visibility                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | 3     |
| `screenshots`           | job_id, file_id, annotations (jsonb), camera (jsonb)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | 3     |
| `job_status_history`    | job_id, status, source (`app`/`odoo`), at                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | 3     |

Settings key `measurement` (phase 2): the σ factor, the coverage factor of the shown ± (2), the flatness threshold (5 cm), the re-projection flag threshold, the minimum number of control measurements before they replace the estimate (10 per kind). Changing one only affects new revisions, because every revision stores the parameters it used.

### 5.1 State machines

- **Scan:** `uploading → uploaded → importing → imported → deriving → ready`, any step `→ failed` (with a Dutch error code). A boundary change sets `ready → deriving` again and bumps `derived_boundary_version`.
- **Render:** `queued → rendering → encoding → done | failed`; `done` becomes `outdated` when markers, the path, branding or the boundary change.
- **Job status (phase 3):** `inspectie → offerte_verstuurd → akkoord → uitgevoerd → gefactureerd → betaald`. Phase 1 derives a simpler status from the scans and renders; phase 3 polls Odoo every few minutes (`sale.order.state`, `account.move.state`, `payment_state`) and records changes in `job_status_history`.

## 6. Background jobs

pg-boss 12 in schema `pgboss` of the same database (`apps/server/src/queue.ts`). The worker takes one job at a time, so memory stays predictable (PLAN.md section 4).

| Queue                 | Payload                       | Does                                                                                                        | Retries / timeout | Milestone |
| --------------------- | ----------------------------- | ----------------------------------------------------------------------------------------------------------- | ----------------- | --------- |
| `cleanup.nightly`     | none                          | Deletes expired sessions; later retention cleanup of originals and expired derived files                    | 2 / 10 min        | M0        |
| `scan.import`         | `{ scanId }`                  | Unpack, detect OBJ/GLB, validate, merge up to 4 blocks, recentre (§8), OBJ → GLB, `work.glb`, thumbnail     | 1 / 30 min        | M1        |
| `scan.derive`         | `{ scanId, boundaryVersion }` | Crop and mask (§9), `render.glb`, `web.glb`, thumbnail; skipped when the version is already derived         | 1 / 30 min        | M1        |
| `photo.process`       | `{ markerPhotoId }`           | HEIC → JPEG, EXIF orientation, strip metadata, resize, thumbnail, read `taken_at`                           | 2 / 2 min         | M2        |
| `render.video`        | `{ renderId }`                | Playwright frames → ffmpeg MP4 + poster (§12)                                                               | 1 / 60 min        | M2        |
| `odoo.link`           | `{ jobId, moveId }`           | Write the video field, post the internal note (§14)                                                         | 3 / 2 min         | M3        |
| `backup.db`           | none (nightly)                | `pg_dump` to the backup bucket (only with Postgres on the VM, §18)                                          | 2 / 30 min        | M3b       |
| `measurement.compute` | `{ revisionId }`              | Re-project the picked points onto `work.glb`, compute values and σ, render the highlighted screenshot (§15) | 2 / 10 min        | M4        |
| `report.generate`     | `{ reportId }`                | Inspection report PDF with the "Meetverantwoording" appendix                                                | 1 / 10 min        | M5        |

Handlers are idempotent: they read the row, check its state and version, and do nothing when the work is already done. Progress and failures are written to the row, so the UI shows them without polling pg-boss.

## 7. Files and storage

`apps/server/src/storage/`: a `Storage` interface with two drivers. `LocalDiskStorage` (built) keeps files under `DATA_DIR`, for development and for servers outside Google Cloud; `GcsStorage` (M3b) keeps them in a Cloud Storage bucket in europe-west4 and is the only app code that knows about Google. Keys are validated relative paths; writes are atomic (local: temp file + rename; Cloud Storage: objects appear whole).

```ts
interface Storage {
  put(key, data): Promise<{ size; sha256 }>; // built; the hash goes into `files`
  getStream(key, range?): Readable; // built (range from M1)
  stat(key); exists(key); delete(key); // built
  createUploadSession(key, { size, contentType, origin }): Promise<{ url }>; // M1
  downloadUrl(key, { expiresInS, filename? }): Promise<string | null>; // M3; null = stream through the API
}
```

**Uploads (M1).** Scans use Cloud Storage's resumable upload protocol, from one client in `apps/web`:

1. The browser asks the API for a session per file (the Terra export is a folder of files). The API checks the operator's session, fixes the object key and the exact size, and calls `createUploadSession`.
2. The browser `PUT`s chunks of 16 MiB (a multiple of 256 KiB) to the session URL with `Content-Range`. After a network error it asks for the status (`Content-Range: bytes */<size>`, answer `308` with a `Range` header) and continues from there.
3. When every file is in, the browser tells the API, which checks the sizes and queues `scan.import`; the import computes the SHA-256 of every original.

On Google Cloud the session URL is Google's own resumable session URI (valid for a week, created with the app's `Origin` so CORS works), so uploads go straight to the bucket and never touch the VM. The local driver serves the same protocol at `PUT /api/uploads/<sessionId>` (table `upload_sessions`). This replaces tus: through the VM, every upload would cross Caddy and Node, need the VM disk as a staging area and be cut by every deploy; straight to the bucket it uses Google's upload front ends and survives a restart of the app. Photos stay plain multipart uploads (they are small).

**Customer files.** The share page only links to `/api/public/share/<token>/…`, which checks the token and the file. The local driver streams the file; the Cloud Storage driver answers with a redirect to a V4 signed URL valid for 15 minutes, signed with the VM's service account (no key file). Revoking a link stops new URLs at once.

```
jobs/<jobId>/scans/<scanId>/original/…        upload as received            retention: original (90 days)
jobs/<jobId>/scans/<scanId>/work.glb          full model, lossless, staff   derived (final measurements use it)
jobs/<jobId>/scans/<scanId>/crop.glb          cropped full resolution       derived
jobs/<jobId>/scans/<scanId>/render.glb        cropped, for the video        derived
jobs/<jobId>/scans/<scanId>/web.glb           cropped, for the browser      derived
jobs/<jobId>/scans/<scanId>/thumb.jpg
jobs/<jobId>/photos/<photoId>/original.<ext>  staff only                    original
jobs/<jobId>/photos/<photoId>/customer.jpg    no EXIF/GPS                   derived
jobs/<jobId>/photos/<photoId>/thumb.jpg
jobs/<jobId>/renders/<renderId>/video.mp4, poster.jpg
jobs/<jobId>/measurements/<revisionId>.png    highlighted screenshot        derived (phase 2)
jobs/<jobId>/reports/<reportId>.pdf           (phase 2)
```

Every file is a row in `files`, so "delete job" and retention cleanup are one query plus deletes. On Google Cloud a bucket lifecycle rule also deletes `jobs/*/scans/*/original/` objects after 90 days, as a safety net under the nightly cleanup. Staff downloads go through authenticated routes; customer files only through the share routes above, which only ever serve `web.glb`, `customer.jpg`, thumbnails, measurement screenshots and the video of that job.

`work.glb` keeps the original geometry: no simplification and no position quantization (float32 relative to the job origin is about 8 µm at 100 m). Final measurement values are computed on it, so it is kept as long as the job, unlike the original upload.

## 8. Coordinate frames

- **Input.** DJI Terra OBJ exports come with `metadata.xml` holding the SRS (default UTM 31N, `EPSG:32631`) and `SRSOrigin`; vertex coordinates are offsets from that origin. When the origin is 0,0,0 the vertices carry full projected coordinates (huge numbers), which jitter in float32. Terra is Z-up.
- **Job origin.** The first scan of a job fixes the job origin (its `SRSOrigin`, or its bounding-box centre rounded to the metre) and the job SRS. Stored with it: the vertical datum (NAP, ellipsoidal or unknown), the projection scale factor at the origin (PROJ) and, when the datum allows it, the offset to NAP (`docs/measurements.md`). Every later scan of the job is expressed relative to that origin: its `offset_to_job` is the difference of origins; a different SRS is reprojected (PROJ) or rejected with a clear message. The operator can nudge the after scan (E/N/U and yaw) when RTK is a few centimetres off.
- **Storage.** Everything stored (boundary, markers, measurements, camera keyframes) is in job-local metres **east, north, up**. Measurements also store each point in the original SRS (local + origin, in double precision).
- **Rendering.** three.js is Y-up. The conversion lives in exactly one place, `packages/shared/src/coords.ts`: `three = (east, up, -north)`. Both frames are right-handed (tested). GLB files written by the worker are already Y-up and recentred, so the viewer never sees large coordinates.
- **Cadastre (M1).** PDOK works in RD New (`EPSG:28992`). Conversion UTM ↔ RD uses PROJ with the official RDNAPTRANS2018 grid; the epsg.io proj4 string is about 175 m off and must never be used (PLAN.md 2.1).

## 9. Crop to the property (M1)

PLAN.md 2.1 is the design. Summary:

- `jobs.boundary = { kind: 'polygon' | 'box' | 'none', polygon: [[e, n], …], zMin, zMax, source: 'manual' | 'cadastre', version }`. `kind: 'none'` needs the explicit "geen uitsnede" confirmation.
- `scan.derive` builds the customer files from a cropped copy: drop triangles whose centroid is outside the prism, drop unused texture pages, blank texels used only by removed triangles (rasterised UV mask), remove small disconnected fragments, then build `render.glb` and `web.glb` within the budgets (`web.glb` ≈ 500k triangles, ≈ 64 Mpx KTX2 ETC1S textures, hard cap 25 MB; `render.glb` ≈ 1.5 M triangles, ≈ 270 Mpx).
- The operator viewer shows the full `work.glb` with the outside dimmed (the "Perceelgrens" view of the preview) and a "klantweergave" toggle that loads `web.glb`.
- Markers outside the boundary are flagged and never sent to customers. The e2e test asserts that no vertex of a downloaded `web.glb` lies outside the boundary.

## 10. Markers and photos (M2)

- Placed by raycasting the full mesh (three-mesh-bvh). Each marker stores position and normal; the surface class comes from the normal and the height above local ground, with an operator override, and drives the camera angle in the video.
- Problems are red and solutions green. Copying a problem to the after scan creates a solution at the same spot with `copied_from` set, so problem 4 and solution 4 stay paired. The label picker shows the solutions a problem preset suggests first.
- Photos: multipart upload (not tus; photos are small), processed by `photo.process` with sharp (`heic-convert` for HEIC). The customer copy is re-encoded, max 2048 px, without any metadata; a test asserts no EXIF/GPS remains. Originals are staff-only.

## 11. Camera path and video timeline (M2)

The camera path is a versioned JSON document stored in `camera_paths` and frozen into `renders.snapshot`. The browser preview and the renderer both call the same `sample(path, t)` in `apps/web` (the render route is a web page), exactly like `sample(t)` in the clickable demo (`preview/src/page.html`).

```jsonc
{
  "version": 1,
  "fps": 30,
  "aspect": [16, 9],
  "orbit": {
    "target": [-1.0, -0.3, 2.4], // ENU, area-weighted centroid of the boundary, median mesh height
    "pitchDeg": 35,
    "startDeg": -126, // compass bearing the orbit starts from
    "durationS": 7,
    "distances": [41.2, 41.5, "…"], // fitted per heading, N samples around the circle (PLAN.md 2.4)
    "margin": 0.92,
  },
  "visits": [
    { "markerId": "…", "moveS": 1.4, "holdS": 2.0, "viewDir": [0.4, -0.3, 0.86], "distance": 4.2, "insetPhotoId": "…" },
  ],
  "segments": [
    // derived from the above; what sample() walks through
    { "type": "intro", "durationS": 3 },
    { "type": "title", "phase": "voor", "durationS": 3 },
    { "type": "orbit", "phase": "voor" },
    { "type": "visit", "phase": "voor", "visit": 0 },
    { "type": "wipe", "durationS": 1.2 },
    { "type": "title", "phase": "na", "durationS": 1.6 },
    { "type": "orbit", "phase": "na" },
    { "type": "visit", "phase": "na", "visit": 0 },
    { "type": "outro", "durationS": 3.8 },
  ],
}
```

`sample(path, t)` returns the camera pose, the active scene (voor/na), the active marker and every overlay's state (title, lower third, photo inset, wipe progress, watermark) as plain data. It is pure: no wall-clock, no `requestAnimationFrame`. Moves between markers interpolate around the target and climb over the highest obstacle on the way (sampled with BVH raycasts on the cropped mesh), so the camera never flies through trees. Total length follows the number of markers in the video (30 to 90 s), with a configurable minimum time per marker.

## 12. Rendering (M2)

`render.video` starts headless Chromium (Playwright) on the render route `/render/<renderId>?frame=N` with a short-lived token, waits until every texture has loaded, then for each frame sets `t = N / fps`, renders, and pipes PNG frames into ffmpeg: H.264, 1920×1080, 30 fps, yuv420p, `+faststart`, AAC only with music. Software GL (SwiftShader) by default; a GPU is a config switch, untested (PLAN.md decision 5). Supersampling is set per render (1.5× or 2×) to stay within about 30 minutes; the first real render time is measured early in M2.

## 13. Share links (M3)

`/v/<token>` with a 32-byte random token (base64url), no customer name or address in the URL, `noindex`, no third-party requests. The page shows the video first (poster = thumbnail) and loads the 3D view (`web.glb`, Voor/Na, pins with photo sheets) only on tap. Links can be revoked and expire (default from settings). Views are counted per link per day, without IPs or user agents. Phase 3 turns this into one job page (inspection, quote, result); old links keep working.

## 14. Odoo (M3)

- JSON-2 only: `POST /json/2/<model>/<method>`, `Authorization: bearer <API key>`, `X-Odoo-Database`. XML-RPC/JSON-RPC are deprecated and leave Odoo Online in 21.1.
- A dedicated integration user with minimal rights (Invoicing; Sales from phase 2) and its own API key, from env. The key never reaches the browser.
- Reads: `res.partner` search; `account.move` (`out_invoice`) for a partner.
- Writes, all with dry-run (`ODOO_DRY_RUN=true` logs the call instead of making it) and all logged in `odoo_sync_log`: set `ODOO_VIDEO_FIELD` on the move, post an internal note (`mail.mt_note`) with the link and thumbnail. Linking again overwrites the field and posts one new note; it never changes lines, amounts, taxes or state, and never sends anything.
- "Test connection" reports version, user, API reachability (Custom plan) and whether the field and rights exist. Manual mode (link, QR PNG, ready-made Dutch sentence) works without Odoo.
- Local development uses the Odoo 19 container from `compose.dev.yml` (`scripts/odoo-init.sh`); never the production database without asking first.

## 15. Phase 2 and 3 in brief

- **Measuring (M4):** tools on the 3D model (distance, length, height, roof area with pitch, ground area) with live values while drawing, on `web.glb`. Saving a measurement creates a revision and queues `measurement.compute`, which re-projects each picked point along its view ray onto `work.glb`, computes the values and their uncertainty exactly as `docs/measurements.md` describes, flags points that moved more than the threshold, and renders a screenshot with the shape highlighted. The "Hoe berekend?" panel reads everything from the revision. The orthophoto GeoTIFF is converted with GDAL to web tiles and cropped to the boundary; a click on it is a vertical view ray, so 2D measurements use the same pipeline. The math lives in `packages/shared` (pure functions, unit-tested against exact geometry and by Monte Carlo); the worker runs it on the full mesh, the browser on the light mesh for live values.
- **Quotes and reports (M5):** `quote_mappings` turn a measurement value into a quantity: value × (1 + extra %), rounded by the mapping's rule and step, at least the minimum. The line description shows that calculation in Dutch ("Vogelnet: 48,6 m² gemeten + 10% overlap = 53,5 m², afgerond 54 m²"). The operator reviews the lines and pushes a draft `sale.order`; prices always come from Odoo. The quote stores a snapshot of every line and the revision ids it used. The inspection report is an HTML template printed to PDF by the worker's Chromium, with the "Meetverantwoording" appendix, and attached to the quote with an internal note.
- **Notes, photos, timeline (M6, M7):** notes per job or marker (internal or customer-visible), job photos with the same stripping, annotated screenshots, the job timeline synced from Odoo by polling, a dashboard, and a PWA for phones and tablets with an upload queue that retries.

## 16. Operations

- `GET /health`: 200 when the database answers, otherwise 503; later also red on failed renders and failing Odoo calls. Cloud Monitoring uptime checks poll it and a customer page and send e-mail alerts (§18). This replaces Uptime Kuma (PLAN.md decision 6, superseded).
- Logs: JSON on stdout, rotated by Docker (10 MB × 5 per container). On Google Cloud the Ops Agent ships them to Cloud Logging, where log-based metrics count failed renders and failed Odoo calls for the alerts.
- Backups (M3b): daily VM disk snapshots, a nightly `pg_dump` to a separate backup bucket, soft delete on the buckets and a nightly copy of the files to a second EU region. The restore procedure is tested once as a full restore into a fresh environment and written down in `docs/runbook.md`.
- `docs/server-requirements.md` (M3b): CPU, RAM and disk per phase from the measured numbers (4 vCPU, 16 GB RAM, about 2.5 GB disk per job during processing), also for servers outside Google Cloud.

## 17. Testing

- `pnpm check`: ESLint, `tsc` per package, Vitest (shared unit tests, server unit and integration tests against a real Postgres `scan_test` database, web component tests with jsdom).
- `pnpm e2e`: Playwright against the real API serving the built web app and a fresh `scan_e2e` database, on a desktop and a phone viewport.
- CI (GitHub Actions) runs both, plus the Docker build, on every push and pull request.
- From M1: synthetic before/after properties with known dimensions and fake `metadata.xml` (SPEC: Test data); integration tests against the local Odoo from M3.

## 18. Hosting on Google Cloud (M3b, proposed)

`docs/gcp-hosting.md` is the proposal, with the monthly cost; nothing of it is built before the OK. In short:

- One Compute Engine VM in europe-west4 (Ubuntu LTS, e2-standard-4) runs `compose.yml` with an override from `infra/gcp/`: images from Artifact Registry, `STORAGE_DRIVER=gcs`, secrets mounted as files. Static IP, only ports 80 and 443 open, SSH only through IAP, automatic security updates.
- Files in a Cloud Storage bucket in europe-west4 (§7); backups in a second bucket in another EU region.
- The VM's attached service account has only the roles it needs (bucket objects, its secrets, signing its own URLs, logs and metrics, pulling images). No key files anywhere.
- Secrets in Secret Manager. A boot unit on the VM reads them with the VM's credentials into a tmpfs, and compose mounts them as files (§4). So the secrets "adapter" is a few lines of shell in `infra/gcp/`, and the app has no Google code for secrets.
- Everything is OpenTofu under `infra/gcp/` (state in a versioned bucket), deployed with one command (build, push to Artifact Registry, `docker compose pull && up -d` on the VM through IAP).
- Phase 4: OpenDroneMap runs on a Spot VM per job that the worker creates and deletes; that needs a third small adapter ("compute runner") next to storage and secrets.
