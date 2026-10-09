#!/usr/bin/env bash
# Initialise the LOCAL development Odoo (compose.dev.yml, profile "odoo"): a database "odoo" with
# Invoicing installed, Dutch language and country, no demo data. Safe to run twice.
# This script only ever talks to the Docker containers on this machine, never to Odoo Online.
set -euo pipefail
cd "$(dirname "$0")/.."

compose=(docker compose -f compose.dev.yml --profile odoo)
db_args=(--db_host odoo-db --db_port 5432 -r odoo -w odoo)

# Refuse when .env points the app at a non-local Odoo: this script must never be confused with production.
if [[ -f .env ]]; then
  odoo_url=$(grep -E '^ODOO_URL=' .env | tail -1 | cut -d= -f2- || true)
  if [[ -n "${odoo_url}" && ! "${odoo_url}" =~ ^https?://(localhost|127\.0\.0\.1)(:[0-9]+)?/?$ ]]; then
    echo "ODOO_URL in .env is ${odoo_url}, not a local Odoo. Refusing to continue." >&2
    exit 1
  fi
fi

"${compose[@]}" up -d --wait odoo-db

exists=$("${compose[@]}" exec -T odoo-db psql -U odoo -d postgres -Atc "select 1 from pg_database where datname = 'odoo'")
if [[ "${exists}" == "1" ]]; then
  echo "Database 'odoo' already exists; leaving it as it is."
else
  echo "Creating database 'odoo' (Dutch, Netherlands, no demo data)..."
  "${compose[@]}" run --rm --no-deps --entrypoint odoo odoo db "${db_args[@]}" init odoo \
    --language nl_NL --country NL --username admin --password admin
  echo "Installing Invoicing (module account)..."
  "${compose[@]}" run --rm --no-deps --entrypoint odoo odoo -d odoo -i account --stop-after-init "${db_args[@]}"
fi

"${compose[@]}" up -d odoo
cat <<'MSG'

Local Odoo is starting at http://localhost:8069 (database "odoo", login admin / admin).
Local only: never reuse these credentials anywhere else.
Next steps (M3): create an integration user and API key, the custom field and the seed data by script.
Stop it with: docker compose -f compose.dev.yml --profile odoo stop
MSG
