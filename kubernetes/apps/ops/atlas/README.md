# Atlas

Homelab ops, security and governance in one place: the collector and its
database (vulnerability and policy-violation history, risk ranking), and
since 2026-11-28 the web UI (`atlas-web`, Security tab first). The
collector's metrics also feed the Homepage Patch Ops → Compliance cards. Code: [`services/atlas/`](../../../../services/atlas/README.md).

| | |
|---|---|
| **URL** | https://atlas.jupitertech.net (Security tab; read-only). Public through the Cloudflare tunnel behind Cloudflare Access (Authentik + passkey), **no AdGuard rewrite on purpose**: the API rejects requests without a valid Access token, so a LAN rewrite to the Gateway VIP would only ever get 401 |
| **Image** | `registry.jupitertech.net/homelab/atlas:<git sha>`, built from `services/atlas` by the `build-image` WorkflowTemplate |
| **Namespace** | `atlas` (PSA `restricted`) |
| **Database** | CNPG `atlas-db` (2 instances), point-in-time recovery to RustFS `s3://cnpg/atlas-db/` |
| **Reads** | Trivy `VulnerabilityReports`, `ReplicaSets`, Kyverno `PolicyReports`/`ClusterPolicyReports`, Pod and Job metadata, Services, `HTTPRoutes` (cluster-wide, read-only), the `cloudflared-config` ConfigMap, Prometheus |
| **Internet egress** | HTTPS to `www.cisa.gov`, `epss.empiricalsecurity.com`, `cloudflare-dns.com` only (`toFQDNs`, policy `atlas-collector-internet-feeds`) |

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

The same run then reads Kyverno's reports (on its own: a Kyverno failure
never stops the vulnerability part, `stats.policy.error` records it):

- **policy_violations:** one row per policy + rule + **workload**. Kyverno
  reports every Pod, ReplicaSet and controller separately; they are folded
  up to the owner (Pod → ReplicaSet → Deployment, Pod → Job → CronJob, CNPG
  pods → their `Cluster`, Longhorn pods → their `InstanceManager`), so a
  rollout doesn't look like a fix plus a new violation. Static pods keep
  their own name. Resolved as `fixed` (workload still reported, now passes)
  or `removed` (nothing reports it any more).
- **policy_violation_events:** first_seen, resolved, reopened.
- The first policy run is marked `baseline`, so "new this week" doesn't count
  the starting backlog. The same half-the-reports guard applies.

Metrics (`/metrics`): `atlas_policy_violations_open{policy,category,workload_namespace}` (not `namespace`: Prometheus sets that to `atlas` at scrape time),
`atlas_policy_workloads{policy,category,result}`,
`atlas_policy_violations_new_7d`, `atlas_policy_violations_resolved_7d{resolution}`,
`atlas_policy_last_success_timestamp_seconds` (alert `AtlasPolicyIngestStale`).

## Risk ranking

Open findings are ranked P1–P4 by real risk, CVSS severity second
(`services/atlas/src/collector/priority.ts`, defaults to tune):

| | Rule |
|---|---|
| **P1** | Known exploited: in CISA's KEV catalog |
| **P2** | EPSS ≥ 10%, or Critical/High on an internet-reachable workload |
| **P3** | Critical/High with EPSS ≥ 1%, or on a LAN-reachable workload |
| **P4** | Everything else |

The SLA stays per severity (Critical 7, High 30, Medium 90, Low 180 days),
but a KEV finding gets at most 7 days.

Inputs, each refreshed on its own (a failure never stops the rest of the run):

- **vuln_intel** (every 6 h): CISA KEV (dates, ransomware use) and FIRST EPSS
  (score and percentile) for every CVE Atlas has. GHSA-only IDs never match.
  A failed download keeps the previous values (`atlas_intel_feed_ok`). A CVE
  newly added to KEV writes a `kev_listed` event on each of its open findings
  (`baseline` on the very first refresh).
- **workload_exposure** (every run): `internet` = a hostname with a public
  DNS record that the Cloudflare tunnel forwards (through an HTTPRoute, or a
  direct tunnel rule such as `auth`), still behind Cloudflare Access;
  `lan` = an HTTPRoute without a public record, or a LoadBalancer Service.
  Services are followed to pods by selector and folded up to the workload
  the same way as policy violations, so names match `finding_sightings`.
  Public DNS is checked through Cloudflare DNS-over-HTTPS, because the
  cluster's DNS (AdGuard) answers every hostname with the LAN VIP. A
  finding's exposure is its most exposed active sighting.

Metrics: `atlas_findings_open_priority{priority,severity,exposure,kev}`,
`atlas_workloads_exposed{exposure}`, `atlas_intel_matched{feed}`,
`atlas_intel_feed_ok{feed}`; alerts `AtlasExposureStale`,
`AtlasThreatIntelStale`, `AtlasThreatIntelFeedFailing`.

## Numbers differ from Homepage

Homepage counts Prometheus series (unique image + CVE + package +
severity + fixed version), and unfixed Medium/Low/Unknown are dropped at
scrape time. Atlas counts one finding per image + CVE + package and keeps
every severity, including the ~10,000 `UNKNOWN` ones.

## Gotchas

- **New images:** build from `services/atlas` with the `build-image`
  template (it runs on talos4, the only node allowing user namespaces), then
  update the tag and digest in `deployment-collector.yaml`. Merging a
  Renovate PR for `services/atlas` deploys nothing until that happens.
- **Backup key:** `secret-atlas-db-backup.sops.yaml` was made by
  `REPO=<worktree> ~/homelab/restructure-tools/rustfs-cnpg-provision.sh atlas-db`
  (RustFS user `cnpg-atlas-db`, prefix `s3://cnpg/atlas-db/` only).
- **First base backup by hand** after the first sync (cnpg-barman-cloud
  README), like every new CNPG cluster.
- **Schema changes** are migrations: edit `services/atlas/src/db/schema.ts`,
  run `npm run db:generate`, commit the new SQL. The collector applies it on
  start.
