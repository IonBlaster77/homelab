# Trivy Operator

Scans everything running in the cluster for known vulnerabilities, and keeps
doing it. Each container image is scanned when its workload appears or
changes, and again every day (reports expire after 24h, which triggers a
rescan), so a CVE published next week against an image already running still
gets caught. It also audits live resources for misconfigurations, Roles for
risky permissions, and images for secrets baked into their layers.

Results are Kubernetes objects (`VulnerabilityReport`, `ConfigAuditReport`,
`ExposedSecretReport`, `RbacAssessmentReport`, `SbomReport`,
`ClusterComplianceReport`) plus Prometheus metrics, which feed the Matrix
alerts, the weekly digest and the Patch Ops cards on Homepage.

Separate from Harbor's own Trivy: this has its own Trivy server and database.
The only link is that scan jobs pull images through Harbor's pull-through
cache.

| | |
|---|---|
| **URL** | None. Detail in Grafana: [Trivy Operator Dashboard](https://grafana.jupitertech.net/d/ycwPj724k); summary on Homepage → Patch Ops → Vulnerabilities |
| **Chart** | [`trivy-operator`](https://github.com/aquasecurity/trivy-operator) from `aquasecurity.github.io/helm-charts`, version pinned in `app.yaml` |
| **Namespace** | `trivy-system` (PSA baseline, warn restricted) |
| **Storage** | 5Gi PVC (default class) for the Trivy server's vulnerability database |
| **Depends on** | Harbor proxy cache (`registry.jupitertech.net`), `mirror.gcr.io` (databases, check bundle), Prometheus, Alertmanager → Matrix |
| **Design** | [`docs/projects/vulnerability-scanning.md`](../../../../docs/projects/vulnerability-scanning.md) |

## Files

| File | What it is |
|---|---|
| `app.yaml` | Argo CD Application with two sources: the chart, and this folder. Server-Side Apply |
| `values.yaml` | Built-in Trivy server, 2 scans at a time, scan jobs off talos2/talos4, Harbor mirrors, per-CVE metrics, accepted-risk list |
| `kustomization.yaml` | Lists this folder's own manifests |
| `networkpolicy.yaml` | Default deny, plus DNS, API server, Harbor VIP, HTTPS out, intra-namespace, and Prometheus scrapes |

Elsewhere:

| File | What it is |
|---|---|
| `platform/observability/monitoring/prometheusrule-trivy.yaml` | Recording rules and the "new finding" alerts |
| `platform/observability/monitoring/values.yaml` | Alertmanager routes for `#alerts-vulnerabilities` and `#alerts-critical` |
| `platform/observability/monitoring/cronjob-vulnerability-digest.yaml` (+ configmap) | Weekly digest, Monday 08:30 Adelaide |
| `apps/comms/matrix/configmap-alertmanager-receiver.yaml` | Room mapping for `alerts-vulnerabilities` |
| `apps/other/homepage/values.yaml` | Patch Ops → Vulnerabilities cards |

## What alerts, and where

| What | Where |
|---|---|
| New finding with a fix, any severity | `#alerts-vulnerabilities`, one message per image + severity, CVE IDs and fixed versions listed |
| New High/Critical with no fix | `#alerts-vulnerabilities` |
| New fixable Critical | also `#alerts-critical` |
| New secret found inside an image | `#alerts-vulnerabilities` |
| Medium/Low/Unknown with no fix | Nowhere (dropped at scrape time; still in the report objects and Grafana's totals) |
| Everything still outstanding, config audits and RBAC (our namespaces) | Weekly digest in `#alerts-vulnerabilities` |
| Operator metrics missing 30m | `#alerts-warning` (`TrivyOperatorDown`) |

"New" means present now but absent both 6h and 1d ago, so the alerts resolve
by themselves within 6h and never repeat. Receivers have `send_resolved` off:
"resolved" means "no longer new", not "fixed".

**The first day is silent on purpose.** Every alert waits for a full day of
history, so the first scan of the whole cluster becomes the baseline instead
of hundreds of messages. The first Monday digest lists that baseline.

## Accepting a risk

Add an entry under `trivy.ignoreFile.vulnerabilities` in `values.yaml`, by PR:

```yaml
    vulnerabilities:
      - id: CVE-2026-00000
        statement: "Only reachable via the admin UI, which is LAN-only"
        expired_at: 2027-01-31
```

After `expired_at` the finding comes back. Ignored findings disappear from the
next scan of each image (within a day, or delete the report to rescan now).

## Useful commands

```bash
kubectl get vulnerabilityreports -A -o wide        # per-container summary
kubectl get exposedsecretreports -A
kubectl get configauditreports -n hermes -o wide
# Rescan one workload now: delete its report and the operator recreates it.
kubectl delete vulnerabilityreport -n <ns> <name>
# Where is a package running? (SBOM reports)
kubectl get sbomreports -A -o json | grep -l openssh
```

## Gotchas

- **Never run Trivy 0.69.4–0.69.6.** Those releases (binary and images) were
  the March 2026 supply-chain compromise (CVE-2026-33634). The chart pins its
  Trivy image; check it on every chart bump.
- **The GHCR OCI chart is stale** (stops at 0.32.1); use the Helm repo.
- **Docker Hub mirror key is `index.docker.io`**, not `docker.io`: the
  operator matches mirrors against the normalised image name.
- **Scan jobs don't use the Talos registry mirrors.** They pull layers
  themselves, so mirrors are configured here too (`trivy.registry.mirror`).
  Keep both lists in step when Harbor gains a proxy project.
- **Node (infra) checks and CIS compliance are off.** They read kubelet/etcd
  files from the host, which don't exist on Talos.
- **Invisible to the scanner:** packages installed when a container starts
  (e.g. research-worker's `apk add`). Bake them into an image to get them scanned.
