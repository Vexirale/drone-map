# Google Cloud hosting (proposal)

Status: **proposal of 2026-10-09, waiting for an OK.** Nothing here is built yet; milestone M3b builds it as OpenTofu code under `infra/gcp/`. Prices are USD list prices for europe-west4 (Eemshaven, Netherlands), read on 2026-10-09 from Google's pricing pages, excluding VAT. A billing account in euros pays Google's fixed euro price per SKU instead.

**In one line:** one VM runs the app as today (Docker Compose with Caddy, API, worker and Postgres), files live in a Cloud Storage bucket that browsers upload to directly, backups go to two buckets in Belgium (europe-west1), and everything is created by code. About **$120 a month** on demand, about **$80** with a one-year commitment on the VM (section 13).

```
 customers (share pages)        staff (browser)
          │ HTTPS                    │ HTTPS, plus uploads straight to the bucket ──────────┐
          ▼                          ▼                                                    │
 ┌─ VM "scan" · e2-standard-4 · Ubuntu 26.04 · static IP · ports 80/443 only ────────────┐  │
 │  Caddy (Let's Encrypt) ─► api ─┐   worker (Chromium, ffmpeg)   postgres 18 (volume)   │  │
 └────────────────────────────────┼────────────────┬─────────────────────┬──────────────┘  │
     redirects to signed URLs     │                │ reads/writes files  │ pg_dump every 6 h │
                                  ▼                ▼                     ▼                  │
                   bucket "files" (europe-west4) ◄───────────────────────┼──────────────────┘
                                  │ nightly mirror (Storage Transfer)    │
                                  ▼                                      ▼
                   bucket "backup-files" (europe-west1)      bucket "backup-db" (europe-west1)
```

## 1. Decisions in this proposal

| #   | Decision                                                           | Why                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| --- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Postgres stays in Docker on the VM**, not Cloud SQL              | At 5 jobs a month the database is a few hundred MB. The VM is the single point of failure for the app either way, so Cloud SQL does not make the app more available. The cheap Cloud SQL tiers (db-f1-micro, $8.47; db-g1-small, $28.11) are shared-core, not covered by the SLA and meant for test and development; the smallest SLA tier (1 vCPU, 3.75 GB) is $54 a month plus storage, half the VM again. In Docker, dev, CI and production run the same Postgres 18 image, with no private service networking to set up. A dump every 6 hours to the backup bucket gives at most 6 hours of data loss. |
| 2   | **Uploads go straight from the browser to the bucket** (resumable) | Up to 3 GB per scan never touches the VM: no staging disk, no proxy limits, and a deploy or restart does not cut an upload. The API still decides the object name and the exact size (PLAN.md decision 15).                                                                                                                                                                                                                                                                                                                                                                                                |
| 3   | **Caddy keeps doing HTTPS**                                        | A Google load balancer costs $0.025 an hour per forwarding rule, about $18 a month before traffic, and adds parts for a single VM.                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 4   | **Secrets reach the app as files**                                 | A boot unit reads them from Secret Manager with the VM's identity into a tmpfs; compose mounts them (`<NAME>_FILE`). No Google SDK in the app, and secrets stay out of the environment that Chromium and ffmpeg inherit (PLAN.md decision 17).                                                                                                                                                                                                                                                                                                                                                             |
| 5   | **Backups in europe-west1 (Belgium)**                              | A second EU region, in two buckets of their own: a nightly mirror of the files, and the database dumps, which the VM can only add to, never read or delete.                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 6   | **OpenTofu**                                                       | The same HCL and Google provider as Terraform, under the open MPL licence.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 7   | **Start on demand, commit after 2 to 3 months**                    | The real render time on the VM is measured in M2. Once the size is right, a 1-year commitment on the VM saves about $40 a month.                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

Switching to Cloud SQL later is a dump, a restore and a new `DATABASE_URL`; the OpenTofu code would get one more file. Worth it when the database gets valuable enough that 6 hours of loss is too much, or when a second VM appears.

## 2. Project and accounts

- One Google Cloud **organization** for the company's domain, one **project** (for example `bedrijf-scan-prod`) and a **billing account** owned by the company. If the company has no Google Workspace, the free Cloud Identity edition creates the organization from their own domain. That is what "no personal accounts" needs: people log in with company addresses that the company controls and can remove.
- Two people get admin rights (section 12). Nobody else needs Google Cloud access: staff use the app.
- OpenTofu state lives in a versioned bucket in the same project.
- Region europe-west4 for everything except the backup bucket.

## 3. The VM

- **e2-standard-4** (4 vCPU, 16 GB): the benchmark sizing (PLAN.md section 4). The renderer is the heaviest job (about 3 GB of RAM, all four cores for 10 to 35 minutes per video). n2d-standard-4 costs the same per month on demand once its automatic sustained-use discount applies, and may render faster; M2 measures that before any commitment.
- **Ubuntu 26.04 LTS** (supported until 2031; 24.04 LTS if Docker's repository does not support 26.04 yet when M3b starts), Docker Engine from Docker's apt repository. Google's Ubuntu images install security updates daily by themselves but never reboot; the VM is set to reboot at 04:00 when an update needs it, and `restart: unless-stopped` brings the stack back.
- **Disk**: one 50 GB pd-balanced boot disk (OS, Docker images, Postgres data, and scratch space for the worker, which needs about 2.5 GB per job while processing).
- **Static external IPv4**, attached to the VM; DNS `A` records for the staff app and the share domain point at it.
- **Service account** `scan-vm` attached, with the cloud-platform scope; its roles are in section 12. No key files exist anywhere.

## 4. Files (Cloud Storage)

- Bucket **`<project>-files`** in europe-west4, Standard class, uniform bucket-level access, public access prevention enforced.
- **Lifecycle**: delete objects under `jobs/` whose key contains `/original/` 90 days after creation, as a safety net under the app's own nightly retention cleanup (the app deletes the database rows and files; the rule catches anything it missed).
- **Soft delete** 30 days (default 7): deleted and replaced objects can be restored for a month.
- **Uploads**: the API opens each resumable session with the staff app's `Origin` header, the declared size and content type. Sessions go through Cloud Storage's JSON API, which answers CORS requests for that origin by itself, so the bucket needs no CORS configuration. The session URL works like a password for a week, so it is only handed to the logged-in operator who asked for it, and the import checks size and hash afterwards.
- **Customer files**: the share page asks the API, which checks the share token and answers with a redirect to a V4 signed URL valid for 15 minutes, signed with the VM's service account through the IAM Credentials API.
- The app talks to the bucket only through `GcsStorage` in `apps/server/src/storage/` (`@google-cloud/storage`). That and `infra/gcp/` are the only Google-specific code.

## 5. Database

Postgres 18 in Docker on the VM, as in `compose.yml` (decision 1).

- A queue job `backup.db` runs `pg_dump --format=custom` every 6 hours and uploads the dump to the bucket `<project>-backup-db` with the date and time in the name. Dumps are kept 35 days (lifecycle rule).
- The data volume also lands in the daily disk snapshot.
- If a dump fails twice in a row, an alert goes out (section 10).

## 6. Secrets

- In Secret Manager, replicated in europe-west4 only: `db-password`, `odoo-api-key`, `admin-password` (only needed until the first admin exists). No session secret exists: sessions are random tokens and the database keeps only their SHA-256.
- A systemd unit on the VM (`scan-secrets.service`, before Docker) runs `gcloud secrets versions access latest` for each secret with the VM's identity and writes them to `/run/scan-secrets/` (tmpfs, root-only, readable by the containers' user). The compose override mounts them and sets `<NAME>_FILE`.
- Rotating a secret: add a new version, run the deploy command (which restarts the unit and the stack), then disable the old version.

## 7. Network and access

- Default VPC network replaced by one custom VPC with one subnet in europe-west4.
- Firewall: ports 80 and 443 from anywhere to the VM; port 22 only from Google's IAP range `35.235.240.0/20`. Nothing else.
- SSH only through IAP TCP forwarding with OS Login (`gcloud compute ssh scan --tunnel-through-iap`). There are no SSH keys in project metadata.
- `STAFF_ALLOWED_CIDRS` still works if the staff app should only be reachable from the office or a VPN.

## 8. Backups and restore

| What                | How                                                                                 | Kept                 | Worst-case loss |
| ------------------- | ----------------------------------------------------------------------------------- | -------------------- | --------------- |
| Whole VM disk       | Snapshot schedule, daily at 03:00 UTC, stored in europe-west4                       | 14 days              | 24 hours        |
| Database            | `pg_dump` every 6 hours to `<project>-backup-db` (europe-west1)                     | 35 days              | 6 hours         |
| Files               | Soft delete on the files bucket                                                     | 30 days after delete | none            |
| Files, other region | Storage Transfer Service, nightly mirror to `<project>-backup-files` (europe-west1) | soft delete 30 days  | 24 hours        |

- Both backup buckets have soft delete. The VM may only create objects in `backup-db` (no read, no delete) and has no access to `backup-files` at all, so a compromised VM cannot wipe its own backups.
- The mirror deletes files in `backup-files` that were deleted in the source, so "delete a job" (SPEC: AVG) reaches the backups within a night; soft delete keeps them 30 more days, which the privacy text states. That deleting mirror is why the dumps live in a bucket of their own.
- **Restore test (once, in M3b, written down in `docs/runbook.md`):** create a second environment from the same OpenTofu code with another project id, restore the newest dump and copy the files from `backup-files`, then open a share page and a job. Measure how long it takes.

## 9. Monitoring and alerts

- **Uptime checks** (Cloud Monitoring), every 5 minutes from three checker locations (Google's minimum): `https://<staff domain>/health` (must answer 200 with `"status":"ok"`) and a test share page.
- **Log-based alerts** from the app's JSON logs: render failed, Odoo call failed, database backup failed. Each alerts when it repeats (for example 2 within 6 hours), so one retry that succeeds stays quiet.
- **Ops Agent** on the VM for memory, disk and CPU metrics and for the container logs (Docker's JSON log files, parsed as JSON). An alert when the disk is over 85 % full.
- All alerts go to one e-mail notification channel (the owner and the maintainer).

## 10. Billing budget

A budget on the billing account for this project, with e-mail alerts at 50 %, 90 % and 100 % of the monthly limit the owner sets (a required OpenTofu variable). Budgets only warn; they never stop anything.

## 11. Deploy

- Artifact Registry Docker repository in europe-west4, with a cleanup policy that keeps the last 10 versions.
- `infra/gcp/deploy.sh <version>`: builds the `api` and `worker` images, pushes them, then over IAP SSH runs `docker compose pull && docker compose up -d` on the VM with the GCP override and waits for `/health`. Rollback is the same command with the previous version.
- Later: GitHub Actions with Workload Identity Federation (no keys) runs the same script.

## 12. IAM: every role and who has it

This table moves to `docs/runbook.md` when M3b is built and is kept in step with the OpenTofu code (one file, `iam.tf`).

| Who                                             | Role                                                                                | On                         | Why                                         |
| ----------------------------------------------- | ----------------------------------------------------------------------------------- | -------------------------- | ------------------------------------------- |
| Owner (company account)                         | Owner                                                                               | project                    | Break-glass; can do everything              |
| Owner                                           | Billing Account Administrator                                                       | billing account            | Pays, sets the budget                       |
| Maintainer (company account)                    | Owner                                                                               | project                    | Runs OpenTofu, which manages IAM itself     |
| Maintainer                                      | Billing Account Costs Manager                                                       | billing account            | Creates and edits the budget from OpenTofu  |
| `scan-vm` (VM service account)                  | Storage Object User (`roles/storage.objectUser`)                                    | files bucket               | Read, write and delete app files            |
| `scan-vm`                                       | Storage Object Creator (`roles/storage.objectCreator`)                              | `backup-db` bucket         | Write database dumps; cannot read or delete |
| `scan-vm`                                       | Service Account Token Creator (`roles/iam.serviceAccountTokenCreator`)              | itself                     | Sign URLs (`signBlob`) without a key file   |
| `scan-vm`                                       | Secret Manager Secret Accessor                                                      | each of its 3 secrets      | Read its own secrets, nothing else          |
| `scan-vm`                                       | Artifact Registry Reader                                                            | the image repository       | Pull images                                 |
| `scan-vm`                                       | Logs Writer, Monitoring Metric Writer                                               | project                    | Ops Agent                                   |
| Storage Transfer Service agent (Google-managed) | Storage Object Viewer + Legacy Bucket Reader                                        | files bucket               | Read the files for the nightly mirror       |
| Storage Transfer Service agent                  | Storage Object Admin + Legacy Bucket Writer                                         | `backup-files` bucket      | Write and remove mirrored files             |
| Phase 4: `scan-vm`                              | Compute Instance Admin (v1), limited by an IAM condition to instances named `odm-*` | project                    | Create and delete the per-job Spot VM       |
| Phase 4: `scan-vm`                              | Service Account User                                                                | `scan-odm` service account | Start the Spot VM as `scan-odm`             |
| Phase 4: `scan-odm`                             | Storage Object User, limited to `odm/` by an IAM condition                          | files bucket               | Read photos, write the model                |

Two human admins with Owner is a deliberate choice: the alternative (a deploy service account impersonated by humans, with a dozen admin roles) is better at scale but more to maintain for two people. All Owner actions are in the Admin Activity audit log, which Google keeps for 400 days for free.

## 13. Monthly cost

USD, europe-west4, list prices of 2026-10-09, excluding VAT.

| Item                                                                    | Year 1 (≈ 50 GB of files) | After 2 years (≈ 200 GB) | Source price                                          |
| ----------------------------------------------------------------------- | ------------------------- | ------------------------ | ----------------------------------------------------- |
| VM e2-standard-4, on demand                                             | 107.71                    | 107.71                   | $0.14754/hour                                         |
| Boot disk 50 GB pd-balanced                                             | 5.50                      | 5.50                     | $0.11/GB-month                                        |
| Daily snapshots, 14 days (about 15 to 25 GB stored, regional)           | 1.00                      | 1.00                     | $0.053/GB-month                                       |
| Static IPv4 in use                                                      | 3.65                      | 3.65                     | $0.005/hour                                           |
| Files bucket, Standard                                                  | 1.00                      | 4.00                     | $0.02/GB-month                                        |
| Backup buckets (files mirror, database dumps), transfer between regions | 1.30                      | 4.30                     | $0.02/GB-month, $0.02/GB transferred, STS itself free |
| Traffic to customers (about 2 GB of video and models)                   | 0.30                      | 0.30                     | $0.12/GB                                              |
| Artifact Registry (about 2 GB of images)                                | 0.15                      | 0.15                     | $0.10/GB-month above 0.5 GB                           |
| Secret Manager, monitoring, logging, uptime checks, IAP, budget         | 0                         | 0                        | within the free tiers                                 |
| **Total, on demand**                                                    | **≈ 121**                 | **≈ 127**                |                                                       |
| Total with a 1-year commitment on the VM ($67.86 instead of $107.71)    | ≈ 81                      | ≈ 87                     |                                                       |
| Total with a 3-year commitment on the VM ($48.47)                       | ≈ 61                      | ≈ 67                     |                                                       |

Notes:

- Commitments are paid whether the VM runs or not; a "flexible" 1-year commitment ($77.55 for this VM) also covers a later change of machine type.
- E2 machines get no sustained-use discount.
- Cloud Monitoring will start charging for alerting policies no sooner than September 2027, at $0.35 per metric referenced per month. Uptime and log-based alerts as planned here stay free or cost a few dollars.
- With Cloud SQL instead (decision 1), add about $10 a month for db-f1-micro (no SLA) or about $57 for the smallest SLA-covered tier (db-custom-1-3840) with 10 GB of SSD.
- Phase 4 (OpenDroneMap) adds about $1 to $3 per processed job (section 14).

## 14. Phase 4: OpenDroneMap on Spot VMs

Only after the owner says go (SPEC phase 4). The worker creates a Spot VM per job (`odm-<jobId>`, from a fixed image with NodeODM), uploads nothing (the VM reads the photos from the bucket), polls until the model is in the bucket, and deletes the VM. The VM also deletes itself when done or after a maximum run time, so a crashed worker cannot leave it running.

- Machine: n2-highmem-16 (16 vCPU, 128 GB) at $0.32 an hour as Spot, or c2d-highcpu-32 (32 vCPU, 64 GB) at $0.50. Spot prices change up to once a day.
- A preempted job restarts from the start on a new Spot VM; at a few hours per job that is acceptable.
- This needs a third small adapter next to storage and secrets ("compute runner"), the only other place with Google-specific code. Requirements get written down before it is built.

## 15. What has to be done by hand once

OpenTofu cannot create these, or should not:

1. The organization (Cloud Identity or Workspace domain verification) and the billing account with its payment method.
2. A bootstrap project and the state bucket (`infra/gcp/bootstrap/` documents the three commands), plus the first `tofu apply` by an admin.
3. DNS records at the domain registrar, pointing at the static IP from `tofu output`.
4. The secret values (`gcloud secrets versions add …`), so they never pass through OpenTofu state.

Everything else, from APIs and networks to alerts and the budget, is code.

## 16. Layout of `infra/gcp/` (M3b)

```
infra/gcp/
  README.md            first-time setup, daily use, restore
  bootstrap/           state bucket and the APIs OpenTofu needs
  main.tf              provider, project services
  network.tf           VPC, subnet, firewall, static IP
  vm.tf                VM, service account, snapshot schedule, boot units (cloud-init)
  storage.tf           files bucket and the two backup buckets, lifecycle, soft delete, transfer job
  secrets.tf           secret containers (no values)
  iam.tf               every binding from section 12
  monitoring.tf        uptime checks, log-based metrics, alert policies, notification channel
  budget.tf            billing budget
  registry.tf          Artifact Registry and its cleanup policy
  compose.gcp.yml      compose override: images from Artifact Registry, STORAGE_DRIVER=gcs, secret files
  deploy.sh            build, push, pull and restart over IAP
```

## Sources

- Compute Engine prices (general purpose, compute-optimized, Spot): https://cloud.google.com/products/compute/pricing/general-purpose, https://cloud.google.com/spot-vms/pricing
- Sustained use discounts: https://cloud.google.com/compute/docs/sustained-use-discounts
- Disks and snapshots: https://cloud.google.com/compute/disks-image-pricing
- IP addresses and network egress: https://cloud.google.com/vpc/network-pricing
- Cloud Storage, soft delete, transfer between regions: https://cloud.google.com/storage/pricing
- Storage Transfer Service: https://cloud.google.com/storage-transfer/pricing
- Cloud SQL: https://cloud.google.com/sql/pricing
- Secret Manager: https://cloud.google.com/secret-manager/pricing
- Cloud Monitoring and Logging: https://cloud.google.com/stackdriver/pricing
- Artifact Registry: https://cloud.google.com/artifact-registry/pricing
- Load balancing: https://cloud.google.com/load-balancing/pricing
- IAP: https://cloud.google.com/iap/pricing
