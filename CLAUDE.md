# CLAUDE.md

Notes for whoever works on this repo next (a future Claude session or the maintainer). Requirements: `SPEC.md`. Decisions and measured numbers: `PLAN.md`. Design for all phases: `docs/architecture.md`. Measurement methods: `docs/measurements.md`. Google Cloud hosting (proposal): `docs/gcp-hosting.md`.

## Commands

```bash
pnpm i                                              # Node >= 22.18 locally (Docker/CI use 24)
cp .env.example .env                                # then set ADMIN_EMAIL and ADMIN_PASSWORD
docker compose -f compose.dev.yml up -d             # Postgres 18 (databases scan and scan_test)
pnpm dev                                            # API on :3000, web on http://localhost:5173
pnpm --filter @scan/server dev:worker               # background worker (optional in dev)
pnpm check                                          # lint + typecheck + all tests; run before every commit
pnpm format                                         # Prettier; CI runs pnpm format:check
pnpm build && pnpm e2e                              # Playwright against the built app and a fresh scan_e2e database
pnpm db:generate                                    # after changing apps/server/src/db/schema.ts
pnpm db:migrate                                     # the API also migrates on startup
pnpm user:add -- --email jan@x.nl --name Jan --role operator   # prints a generated password once
pnpm user:reset-totp -- --email jan@x.nl            # lost phone
pnpm user:reset-password -- --email jan@x.nl        # forgotten password; prints a new one once
./scripts/odoo-init.sh                              # local Odoo 19 with Invoicing (profile "odoo")
docker build --target api . / --target worker .     # production images; compose.yml runs them
```

## Layout

- `apps/server`: Fastify API and pg-boss worker, one codebase (`node src/main.ts api|worker`). `src/auth/` login, sessions, TOTP; `src/db/` Drizzle schema and migrations; `src/storage/` file storage (local disk now, Cloud Storage in M3b); `src/queue.ts` queues.
- `apps/web`: React staff app (Vite, Tailwind 4, React Router 8, TanStack Query). `src/nl.ts` holds every Dutch string.
- `packages/shared`: API contract (zod), roles, coordinate conversion, branding defaults. Imported as TypeScript source.
- `e2e/`: Playwright. `preview/` and `bench/`: standalone demo and benchmarks, not part of the app or the workspace.

## Conventions

- **No server build step.** Node runs the TypeScript directly (type stripping): only erasable syntax (no enums, namespaces, parameter properties, decorators) and relative imports end in `.ts`. `erasableSyntaxOnly` in `tsconfig.base.json` enforces it.
- **Dutch UI text only in `apps/web/src/nl.ts`.** Staff are addressed with "je", customers with "u". The server never sends user-facing text: it answers `{ "error": { "code": … } }` with a code from `ERROR_CODES` in `packages/shared/src/api.ts`, and `nl.errors` maps every code (typed, so a new code fails the typecheck until it has text).
- **The contract lives in `packages/shared/src/api.ts`.** Add a route there first (path + zod schemas), then the server route (`parseBody` validates) and the web client (`apps/web/src/api.ts` parses responses).
- **Coordinates:** stored as job-local metres east/north/up; convert to three.js only with `enuToThree`/`threeToEnu` from `@scan/shared`.
- **Odoo:** every write supports dry-run (`ODOO_DRY_RUN`), every call is logged, never touch the production database without asking first.
- **Audit:** state changes by people get an `audit()` row; never IPs, passwords, codes or secrets in it. Add new actions to the `AuditAction` union.
- **Secrets only in `.env`** (or `<NAME>_FILE`; Secret Manager in production). Never commit secrets, customer data or real scans (`samples/` and `data/` are gitignored).
- **Portable:** Google-specific code only in the storage adapter and `infra/gcp/`. Secrets reach the app as files (`<NAME>_FILE`), never through a Google SDK in the app.
- **Measurements are traceable:** follow `docs/measurements.md` exactly; a change to a method or threshold is a new algorithm version, revisions are never updated, and issued quotes and reports keep their values. Dutch number format (`12,4 m²`) everywhere.
- Tests that touch the database use `scan_test` (wiped per run) or `scan_e2e`; the setup refuses any other database name.
- Each milestone gets its own branch and PR; run `pnpm check` (and `pnpm e2e` when the UI or auth changes) before pushing.

## How auth works (M0)

Login checks the password (argon2id) and creates a `'password'`-stage session when a second factor is due, else a `'full'` one. Admins must set up TOTP (`next: 'totp_setup'`), users with TOTP enter a code (`next: 'totp'`); each step up issues a new session token. The cookie holds a random token, the database only its SHA-256. Guards: `requireSession`, `requireFull`, `requireRole('admin')`. The web app has one `me` query; `MeResponse.next` decides the screen.

## Gotchas

- **Docker Hub rate-limits the cloud dev container (HTTP 429).** Pull through the mirror and tag: `docker pull mirror.gcr.io/library/postgres:18-alpine && docker tag mirror.gcr.io/library/postgres:18-alpine postgres:18-alpine`. Keep official image names in the files.
- **Docker builds in the cloud container** cannot reach npm on the default network and see a TLS-intercepting proxy. Verify builds there with `--network host` and a throwaway Dockerfile copy that copies `/root/.ccr/ca-bundle.crt` (via `--build-context`) and sets `NODE_EXTRA_CA_CERTS` in the `base` stage. Never commit that.
- **Node majors move LTS to LTS (24 → 26) by hand**, together in the Dockerfile, `.github/workflows/ci.yml` and `.nvmrc`; Dependabot ignores Node majors. Node 25+ ships without corepack, so the Dockerfile installs pnpm with npm (keep its version in step with `packageManager`).
- **TypeScript stays on 6.0.x:** typescript-eslint 8 supports TypeScript below 6.1 only (Dependabot ignores TS majors for now).
- **Postgres 18 images** keep data under `/var/lib/postgresql/18/docker`; mount the volume at `/var/lib/postgresql`, not `/var/lib/postgresql/data`.
- **Never `pnpm deploy`** the server: Node refuses to strip types inside `node_modules`, and deploy copies `@scan/shared` there. The Dockerfile keeps the workspace layout instead.
- **Fastify 5** treats a numeric `trustProxy` as "trust nobody"; `security.ts` turns `TRUST_PROXY=<hops>` into a function. Prefer `1` over `true` behind a proxy when `STAFF_ALLOWED_CIDRS` is used.
- **Fastify parses `text/plain` by default**; the app removes that parser so bodies must be JSON (CSRF).
- **The rate limiter is in memory**: fine for one API process. A second process would need a shared store.
- **The router decodes percent-escapes** (`/%61pi/...` matches `/api/...`), so never guard by testing the raw `request.url`; the Origin check covers every mutating request.
- **Database password in Docker:** passed as `DATABASE_PASSWORD` (or `DATABASE_PASSWORD_FILE`), never written into `DATABASE_URL` by hand; `config.ts` inserts it percent-encoded, so `/ @ # ? %` in it cannot break the URL.
- **Storage `put` returns `{ size, sha256 }`**; record both in `files`. Measurements cite `work.glb` by that hash.
- **Odoo 19 CLI:** demo data is off by default (`--with-demo` to add it); `odoo db init <name> --language nl_NL --country NL` creates a database; the image's entrypoint appends DB flags at the end, which `odoo db …` rejects, so `scripts/odoo-init.sh` passes them explicitly with `--entrypoint odoo`.
- **Playwright:** pinned to 1.56.1 because the cloud container ships Chromium build 1194; CI installs its own browser.
- Measured while benchmarking (PLAN.md section 4), for M1:
  - the gltf-transform CLI `resize` silently drops meshopt; do resize, KTX2/WebP and meshopt in one pass;
  - OBJ without normals needs `--unlit` (right for photogrammetry anyway);
  - obj2gltf 3.1.6 crashes with a current Cesium (3.2.0 works); pin versions;
  - KTX2 encoding needs KTX-Software 4.4 or newer in the worker image.
