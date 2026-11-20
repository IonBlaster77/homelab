# Atlas

Homelab ops, security and governance in one place. **Phase 1:** only the
vulnerability collector and its database, so the findings history starts
building up before there's a UI. Code: [`services/atlas/`](../../../../services/atlas/README.md).

| | |
|---|---|
| **URL** | None yet (no UI) |
| **Image** | `registry.jupitertech.net/homelab/atlas:<git sha>`, built from `services/atlas` by the `build-image` WorkflowTemplate |
| **Namespace** | `atlas` (PSA `restricted`) |
| **Database** | CNPG `atlas-db` (2 instances), point-in-time recovery to RustFS `s3://cnpg/atlas-db/` |
| **Reads** | Trivy `VulnerabilityReports` and `ReplicaSets` (cluster-wide, read-only), Prometheus |

## What the collector does

Every 10 minutes it lists Trivy's reports, skips those of ReplicaSets scaled
to 0 (old rollout revisions), and compares what it sees with the database:

- **findings:** one row per image repository + vulnerability + package, with
  first seen, fix available (exposure clock), fix within our control
  (remediation clock, the SLA one), resolved and how.
- **finding_events:** append-only history of every change.
- **finding_sightings:** which namespace, workload, container and image
  digest each finding is in.
- **scan_reports:** each distinct raw report, stored once.
- **collector_runs:** one row per run, with counts or the error.

On its first start (empty database) it imports history from Prometheus
(`trivy:vulnerability:present`, kept 60 days). If a run sees fewer than half
the reports of the last good run, it resolves nothing, so an API hiccup
can't close every finding at once.

## Numbers differ from Homepage

Homepage counts Prometheus series (unique image + CVE + package +
severity + fixed version), and unfixed Medium/Low/Unknown are dropped at
scrape time. Atlas counts one finding per image + CVE + package and keeps
every severity, including the ~10,000 `UNKNOWN` ones.

## Gotchas

- **Deploy order:** the image must be built (and its tag set in
  `deployment-collector.yaml`) and `secret-atlas-db-backup.sops.yaml`
  generated (`REPO=<worktree> ~/homelab/restructure-tools/rustfs-cnpg-provision.sh atlas-db`)
  before the first sync.
- **First base backup by hand** after the first sync (cnpg-barman-cloud
  README), like every new CNPG cluster.
- **Schema changes** are migrations: edit `services/atlas/src/db/schema.ts`,
  run `npm run db:generate`, commit the new SQL. The collector applies it on
  start.
