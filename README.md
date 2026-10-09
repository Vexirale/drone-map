# Property scan platform

In-house web app for a Dutch pest-control company. They drone-scan a whole property (DJI RTK, processed in DJI Terra) before and after the work. The app turns the two scans into a before/after video with markers and site photos, cropped to the property boundary, a share page for the customer, and a link on the invoice in Odoo. Built in phases; see `SPEC.md`.

Status: **M0** (skeleton, login with two-step verification, Docker, CI). Uploads and 3D come in M1.

## Quick start

```bash
pnpm i
cp .env.example .env                       # set ADMIN_EMAIL and ADMIN_PASSWORD (12+ characters)
docker compose -f compose.dev.yml up -d    # Postgres 18
pnpm dev                                   # then log in at http://localhost:5173
```

The first login as admin asks you to set up two-step verification with an authenticator app. `pnpm check` runs lint, typecheck and tests; `pnpm build && pnpm e2e` runs the browser tests.

## Documents

- `SPEC.md`: the requirements.
- `PLAN.md`: approved decisions, measured benchmarks, budgets, open questions.
- `docs/architecture.md`: how it is built, for all phases.
- `CLAUDE.md`: commands, conventions and gotchas.
- `preview/`: the clickable demo shown to the owner.
- `bench/`: the processing and browser benchmarks behind `PLAN.md`.
