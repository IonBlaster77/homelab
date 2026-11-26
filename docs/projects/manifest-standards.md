# Manifest standards (Kyverno)

**Status:** designed 2026-11-07. **Phase 0 (Audit only) drafted 2026-11-26**:
`kubernetes/platform/security/kyverno/` installs Kyverno with fail-open webhooks
and reports MS-03, MS-07, MS-08 (upstream Pod Security Standards), MS-09 and
MS-11. Nothing blocks. CI (step 3) waits for the Forgejo move.

**Changed since the design (2026-11-26):**
- **Kyverno 1.20 no longer runs the legacy `ClusterPolicy` kind.** The open
  question below is decided: every policy is a CEL `ValidatingPolicy`
  (`policies.kyverno.io/v1beta1`), and exceptions will use the matching
  `policies.kyverno.io` PolicyException. The `podSecurity` subrule mentioned
  under MS-08 doesn't exist for these; MS-08 is the upstream
  `kyverno-policies` chart (18 CEL policies, baseline + restricted) instead.
- **Priority classes already exist** from oom-protection.md:
  `homelab-critical` (1e8, tier 1) and `homelab-batch` (-1000). MS-06 and the
  tier table below still name `homelab-tier1`/`homelab-tier2`; reconcile them
  before MS-06 is written. Kyverno itself runs on `homelab-critical`.
- **Not in phase 0 yet:** MS-01/02/06 (tier label, purpose, priority) wait for
  the tier list (open decision), MS-04 needs the tier label, MS-05 (CNPG
  Guaranteed) and the exceptions folder come with the `kyverno test` fixtures
  in step 2. MS-10 and MS-12 stay in repo-lint.
- The baseline numbers below are from 2026-11-07 (4 nodes). The first
  background scan replaces them.
**Related:** [`oom-protection.md`](oom-protection.md) (plan step 2 becomes the
first backfill batch here), [`vulnerability-scanning.md`](vulnerability-scanning.md)
(roadmap step 8, "Admission policy: Kyverno", is folded into this project).

## Goal

Every manifest that reaches `main` has to say **what it is, what it's for and how
much it needs**, the way sizing a VM and filling in mandatory tags works in Azure.
No field is left empty or at a default because nobody decided. The same gate applies
to people, Renovate, Claude sessions and Hermes: if CI is red, it doesn't merge.

Why now: on 2026-11-07, Talos' OOM controller killed kube-apiserver, the Longhorn
instance-manager, CNPG and Argo CD pods on talos1 and talos3. It picks victims from
pods without memory limits, and the scheduler couldn't keep pods apart because
**90 of 169 running pods are BestEffort**. Requests on talos1 add up to 21% of RAM
while about 45% is in use. Standards stop that from happening again in each new app.

## Design in one picture

```
            one rule set: kubernetes/platform/security/kyverno/policies/
                         │                                  │
   CI (every PR, push)   ▼                                  ▼   cluster (Argo CD app "kyverno")
   render-apps.sh ──► kyverno apply/test ──► report      admission webhook (Audit → Enforce)
   (rendered output,      + repo-lint.sh                 + background scan ──► PolicyReports
    exactly what Argo      (cross-object checks)            (operator-created pods,
    CD applies)                                              kubectl/Hermes drift)
```

- **CI is the real gate.** It checks the rendered output from
  `scripts/ci/render-apps.sh`, so Helm defaults count, not just what the values file
  says. A new step in `.github/workflows/manifest-checks.yml` runs the Kyverno CLI
  next to kubeconform and repo-lint.
- **Admission is the backstop.** It catches what CI can't see: pods that operators
  create (CNPG, Longhorn, Prometheus, Trivy scan jobs, Argo Workflows) and anything
  applied outside Git. It starts in Audit and moves to Enforce only after the ratchet
  below reaches zero.
- Checks that need to see **more than one object at once** (does this namespace
  have a default-deny policy? does a PolicyException have an expiry?) go in
  `repo-lint.sh`, where yq can see the whole rendered app. Kyverno's CLI evaluates
  one resource at a time.

### Why Kyverno and not native ValidatingAdmissionPolicy

Native ValidatingAdmissionPolicy (VAP) is tempting: it runs inside the apiserver,
needs no pods (no extra memory, no webhook that can go down), and it is GA. Kyverno
still wins here:

| Need | Kyverno | Native VAP |
|---|---|---|
| Test offline against rendered YAML in CI | `kyverno apply` / `kyverno test`, with fixtures | No upstream CLI. The Kyverno CLI can evaluate VAPs, but then we depend on Kyverno anyway |
| Report on what is **already running** (the baseline, the ratchet) | Background scan writes PolicyReports, which Grafana and Patch Ops can show | Checks only at admission; existing objects are never reported |
| Exceptions as separate, reviewable files | `PolicyException` resources | Only through hand-written param objects and CEL |
| Later: mutate (default labels), generate, image signature checks for images we build in Harbor | Built in | Not available |

Cost: about 1 GiB of RAM for the admission, background and reports controllers,
plus one more webhook in the request path. The webhook risk is handled under
[Failure modes](#failure-modes-and-kyverno-ha).

Two options to evaluate when this is built (check the Kyverno version pinned then):
- Write the rules as Kyverno's CEL-based `ValidatingPolicy` instead of the older
  `ClusterPolicy`. Upstream is moving to it, and its rules read like VAP.
- Let Kyverno **generate native VAPs** from those policies
  (`autogen.validatingAdmissionPolicy`). The apiserver would enforce them, so a
  Kyverno outage could never block admission. Not every feature carries over
  (exceptions, background reports), so this has to be tested first.

## The rules

Each rule has an ID that CI output, exceptions and the backfill tracker all use.

| ID | Rule | Applies to | Where checked |
|---|---|---|---|
| `MS-01 tier` | Label `homelab/tier` is `"0"`, `"1"` or `"2"` | Workload controllers and their pod templates, CNPG `Cluster` (`inheritedMetadata`), Namespaces | Kyverno |
| `MS-02 purpose` | Annotation `homelab/purpose` is set and is at least 10 characters (a sentence, not `app`) | Workload controllers, Namespaces | Kyverno |
| `MS-03 requests` | `resources.requests.cpu` and `.memory` on **every** container, init containers included | Pod templates, CNPG `Cluster.spec.resources`, Prometheus/Alertmanager CRs | Kyverno |
| `MS-04 mem-limit` | Tier 0–1: `limits.memory` set. Tier 2: optional (these pods stay in Talos' victim pool on purpose) | Same as MS-03 | Kyverno |
| `MS-05 cnpg-guaranteed` | CNPG `Cluster`: requests == limits for CPU and memory (Guaranteed QoS) | `postgresql.cnpg.io/v1 Cluster` | Kyverno |
| `MS-06 priority` | `priorityClassName` set and matches the tier (table below) | Pod templates, CNPG `Cluster.spec.priorityClassName` | Kyverno |
| `MS-07 probes` | Readiness and liveness probes on every long-running container (not init containers, not Jobs) | Deployment, StatefulSet, DaemonSet | Kyverno |
| `MS-08 security` | Pod Security `restricted`: runAsNonRoot, capabilities drop `ALL`, seccomp `RuntimeDefault`, no privilege escalation, unless the namespace declares a lower PSA level and has an exception | Pod templates | Kyverno (`podSecurity` subrule) |
| `MS-09 images` | Pinned tag (no `:latest`, no bare name) | All containers | `repo-lint.sh` (exists today), Renovate `pinDigests` for floating tags |
| `MS-10 netpol` | Each namespace has a namespace-wide (`endpointSelector: {}`) CiliumNetworkPolicy, so anything not explicitly allowed is denied | Namespaces in the rendered app | `repo-lint.sh` (cross-object) |
| `MS-11 psa-label` | Each Namespace has an explicit `pod-security.kubernetes.io/enforce` label | Namespaces | Kyverno |
| `MS-12 exception-hygiene` | Every PolicyException has `homelab/reason` and `homelab/expires` (a date within 12 months that hasn't passed) | `kyverno.io PolicyException` | `repo-lint.sh` |

Deliberately **not** required:
- **CPU limits.** They throttle instead of protecting anything. CPU requests are
  enough for scheduling and for CFS weight.
- **Memory limits for tier 2.** They would shrink the Talos victim pool to tier 0–1
  pods, which is the opposite of what we want.

### Tiers

| Tier | Meaning | Members (proposed) | PriorityClass |
|---|---|---|---|
| **0** | The cluster itself: if it dies, nothing else works | kube-apiserver / controller-manager / scheduler (Talos static pods), Cilium, CoreDNS, Longhorn | Existing only: `system-node-critical`, `system-cluster-critical`, `longhorn-critical` |
| **1** | The household and the platform: DNS, DHCP, logins, certs, GitOps, alerting | AdGuard, Kea and its DB, every CNPG cluster, Authentik, cert-manager, cloudflared, Argo CD, Prometheus and Alertmanager, Harbor, Kyverno itself | New `homelab-tier1` (value 100000) |
| **2** | Everything else: apps, media, AI, dashboards | the rest | New `homelab-tier2` (value 1000) |

- **New classes use `preemptionPolicy: Never`.** They move ahead in the scheduling
  queue and rank later for kubelet eviction, but they never evict a running pod to
  make room. That is safe to roll out without surprise evictions.
- **Neither new class is `globalDefault`.** MS-06 requires an explicit class anyway,
  and a global default would quietly cover pods nobody decided about.
- **The three existing classes stay as they are** (`PreemptLowerPriority`).
- **CNPG clusters are tier 1, whatever app they serve.** Losing a DB primary costs
  more than losing its app pod. The tier 2 app above it is still the one that gets
  killed.

### Labels through charts that don't expose them

Our 40 Applications come in three shapes:
- **Plain manifests or Kustomize** (most of `kubernetes/apps/`): add the label and
  annotation to the YAML, or use a Kustomize `labels:` entry with
  `includeTemplates: true` and `includeSelectors: false`.
- **Kustomize `helmCharts:`** (langfuse, nextcloud, harbor): the same Kustomize
  `labels:` / `commonAnnotations` transformers run on the chart output.
- **Argo CD Helm sources** (authentik, cert-manager, longhorn, monitoring, cnpg,
  loki, metrics-server, and others):
  1. Use the chart's own values first: `podLabels`, `commonLabels`,
     `podAnnotations`, `global.podLabels`.
  2. If the chart has none for some objects, convert the app to the Kustomize
     `helmCharts:` form, which the `sops-kustomize` plugin already renders with
     `--enable-helm`, and use the transformers.
  3. Last resort: a Kyverno **mutate** rule keyed on the namespace. This is
     in-cluster only, so CI must run the same mutation before validating
     (`kyverno apply` with the mutate policy first). Avoid it; it hides the decision
     outside the app folder.

> ⚠ Never use Kustomize's old `commonLabels`, or `labels` with
> `includeSelectors: true`, on existing workloads. Both add the label to
> `spec.selector`, which is immutable on Deployments, StatefulSets and DaemonSets,
> so the Argo CD sync fails. The `homelab/tier` label goes on metadata and pod
> templates only, never on selectors.

`homelab/purpose` goes on **controller metadata**, not the pod template. Changing
the text then never restarts a pod. `homelab/tier` must go on the pod template,
because admission and the priority check look at pods. Adding it causes **one**
rollout per workload, so batch it with that workload's resource change.

## Sizing method

The goal is requests that tell the scheduler the truth, and limits that only catch
runaways.

**Data.** Prometheus holds about 39 days, so a 30-day window works. Queries go
through the apiserver service proxy, which is read-only and needs no port-forward:
`kubectl get --raw /api/v1/namespaces/monitoring/services/http:prometheus-operated:9090/proxy/api/v1/query?query=…`

| Field | Formula (per container) | Round to |
|---|---|---|
| `requests.memory` | p99 of `container_memory_working_set_bytes` over 7 days × 1.15 | 32 Mi |
| `requests.cpu` | p95 of `rate(container_cpu_usage_seconds_total[5m])` over 7 days, minimum 10m | 5m |
| `limits.memory` (tier 0–1) | max(30-day max × 1.5, 30-day max + 256 Mi) | 64 Mi |
| CNPG (Guaranteed) | requests = limits = max(30-day max × 1.3, `shared_buffers` + connections × `work_mem` + 256 Mi) | 64 Mi |

- **Requests use p99, not the absolute maximum.** Per-container peaks don't happen
  at the same moment, so a sum of maximums reserves memory nobody uses. The limit is
  where the true maximum goes.
- Apps with less than 7 days of history (new apps) start from the upstream chart's
  recommendation or a similar app here. Add a `homelab/sizing: provisional`
  annotation, which a later check can list for review after 14 days.
- **Helper (to build):** `scripts/sizing/suggest-resources.sh <namespace> [workload]`.
  It runs the queries above through the service proxy and prints a ready-to-paste
  `resources:` block per container, with the numbers behind it. Read-only, so it is
  fine for Claude and Hermes to run.

**Capacity check.** Run it for every batch, before merging:
1. **Per node:** the memory requests of the pods that run there now, plus the
   change, stay ≤ 85% of allocatable. Use the scheduler's view
   (`kube_pod_container_resource_requests`), not usage.
2. **N−1:** the total of all memory requests fits in the cluster minus the largest
   node. A Talos upgrade drains one node at a time, and its pods must land
   somewhere.

Today (2026-11-07, from Prometheus):

| Node | RAM | Working set now | 7-day peak | Memory requests now |
|---|---|---|---|---|
| talos1 | 23.3 GiB | 9.8 | 11.6 | 4.9 |
| talos2 | **15.5 GiB** | 9.7 | 11.3 | 6.3 |
| talos3 | 23.3 GiB | 5.7 | 13.0 | 3.6 |
| talos4 | 23.3 GiB | 9.2 | 9.1–11.8 (30-day) | 4.5 |
| **Total** | 85.5 GiB | 34.4 | | 19.3 |

- **N−1 budget:** 85.5 − 23.3 = **62 GiB**. Truthful requests should land around
  40–48 GiB, so the plan fits with room for growth.
- **talos2 is the constraint.** 85% of its allocatable is about 12.8 GiB, close to
  its 11.3 GiB peak. Once requests are honest the scheduler will place fewer pods
  there, which is the point. Don't pin anything heavy to it. Its slow kernel
  memory leak (about 0.46 GiB/day, still unexplained) also shrinks headroom over
  time.

## Exceptions

- **One folder:** `kubernetes/platform/security/kyverno/exceptions/`, holding
  `PolicyException` resources.
- **Who may change it:** CODEOWNERS on the folder (once branch rulesets exist,
  task #11) means only the user approves changes.
- **Where they count:** Kyverno is configured to honour exceptions only from the
  `kyverno` namespace (`features.policyExceptions.namespace`), so an exception
  created anywhere else does nothing.
- **What each entry needs** (enforced by MS-12):

```yaml
apiVersion: kyverno.io/v2
kind: PolicyException
metadata:
  name: longhorn-instance-manager-mem-limit
  namespace: kyverno
  annotations:
    homelab/reason: >-
      Longhorn creates instance-manager pods itself and has no memory-limit
      setting; the OOM protection comes from tier 0 priority and Talos v1.12.9+
      QoS ordering instead.
    homelab/expires: "2027-05-01"
    homelab/tracking: "oom-protection.md step 2"
spec:
  exceptions:
    - policyName: ms-04-mem-limit
      ruleNames: ["mem-limit-tier-0-1"]
  match:
    any:
      - resources:
          kinds: [Pod]
          namespaces: [longhorn-system]
          selector:
            matchLabels:
              longhorn.io/component: instance-manager
```

The Kyverno CLI takes the same files (`--exception`), so CI and the cluster agree.
An expired exception fails CI, which forces a re-decision instead of a silent
forever-waiver.

**Known exceptions at the start:**

| Who | Rules | Why |
|---|---|---|
| Longhorn instance-manager, engine-image, CSI plugin, longhorn-manager | MS-04, MS-08 | Pods created by longhorn-manager; privileged by design (block devices, iSCSI); no memory-limit setting for instance-manager |
| Cilium agent, envoy, operator | MS-08 | Host network, privileged, BPF |
| node-exporter | MS-08 | hostNetwork, hostPID, host filesystem |
| Alloy (logs) | MS-08 | hostPath for `/var/log/pods` |
| music-assistant | MS-08 | hostNetwork for AirPlay/mDNS (no repeater can fix it for a pod) |
| media-stack (gluetun) | MS-08 | `NET_ADMIN` for the VPN tunnel |
| Talos static pods (apiserver, controller-manager, scheduler) | all | **Excluded in the policy match**, not via exceptions. They are mirror pods (annotation `kubernetes.io/config.mirror`); the kubelet runs them whatever the API says, and rejecting a mirror pod only hides it from the API. Their resources live in Talos machine config (`cluster.apiServer.resources` etc.), handled after the v1.12.12 rollout, outside this repo's Kyverno rules |

## Rollout: a ratchet

Repo-lint and the workflow already have the plumbing: everything is advisory while
`ENFORCE: "false"`, and a final `Enforce` step fails the job when it's `"true"`.
This adds a separate `POLICY_MODE` so policy enforcement can tighten on its own.

| Phase | `POLICY_MODE` | CI behaviour | Cluster |
|---|---|---|---|
| **0. Baseline** | `report` | Kyverno CLI runs on every app; the PR comment shows per-app and per-rule counts; never fails | Kyverno installed, all policies `Audit`, failurePolicy `Ignore`; PolicyReports give the live view |
| **1. No new debt** | `no-regress` | Fails if any app's violation count **goes up** compared with the base commit (render-diff already renders base and head) | Audit |
| **2. Touched apps clean** | `touched` | An app whose rendered output changes must be at **zero**, except PRs from Renovate (an image bump must not block on old debt) | Audit |
| **3. Global** | `enforce` | Every app at zero, once the backfill is done | Policies move to `Enforce`, one rule at a time, starting with MS-01/02/03 |

- **Backfill order.** One PR per app or small group, each with the sizing helper's
  output and the capacity check in the description:
  1. Tier 0–1 first, which is `oom-protection.md` step 2. Start with the
     BestEffort household pods: AdGuard, Kea and its DB, cert-manager,
     cilium-operator.
  2. Then CNPG clusters (rolling restarts, see below).
  3. Then tier 2, namespace by namespace.
- **Track progress** as a line in the PR comment, "N violations in M apps (was X)",
  and as PolicyReport totals on a Grafana panel.
- **Claude and Hermes:**
  - Link this doc from the repo README.
  - Add `scripts/ci/policy-check.sh`, which renders plus runs the Kyverno CLI
    locally. Agent sessions run it before opening a PR.
  - The Kyverno CLI has to be installed in WSL and in the Hermes / research-worker
    image.

## Gotchas

- **Resource changes restart pods.** Any change to a pod template's resources,
  labels or priority class is a rollout. Batch all of an app's fields in one PR so
  each workload restarts once.
  - RWO Deployments need `maxSurge: 0`, which repo-lint checks.
  - StatefulSets roll one pod at a time.
  - DaemonSets (Cilium) roll node by node. Cilium is manual-sync, and the agent and
    envoy must restart as a pair.
- **QoS class can't change in place.** Even with in-place resize, moving
  BestEffort → Burstable → Guaranteed needs a new pod.
- **PriorityClass can't change on a running pod.** It is read at creation. A new
  class only affects pods created after it exists, so create the classes (one PR)
  before the backfill PRs that use them.
- **CNPG restarts switch the primary.** Changing `spec.resources` or
  `priorityClassName` on a `Cluster` rolls the replicas first, then switches over
  (`primaryUpdateStrategy: unsupervised`): a few seconds of write downtime.
  - Single-instance clusters restart outright.
  - Do one cluster per PR, out of hours.
  - Afterwards, check Authentik logins and Grafana.
  - The same thing happens on a CNPG operator upgrade (1.29 → 1.30 rolled every
    cluster).
- **A memory limit can OOMKill a critical pod.** That is why tier 0–1 limits use 30-day
  maximum × 1.5, and why an alert on `kube_pod_container_status_last_terminated_reason{reason="OOMKilled"}`
  for tier 0–1 should exist before limits go on.
- **CI can't see operator-created pods.** CNPG instance pods, Longhorn
  instance-manager, Prometheus and Alertmanager StatefulSets, Trivy scan jobs and
  Argo Workflows step pods don't appear in the rendered output. The rules check
  their CRs instead:
  - `Cluster.spec.resources`
  - `Prometheus.spec.resources`
  - the Trivy operator's `scanJob` resources
  - the WorkflowTemplate `podSpecPatch`

  Admission audit covers the pods themselves.
- **Argo CD SSA:** a field the chart used to render and no longer does can stay on
  the live object, so check the live pod, not just CI, after each backfill PR.

### Failure modes and Kyverno HA

A Kyverno outage must never stop the cluster from healing itself, especially on a
cold boot with no UPS.

- **3 admission controller replicas** with anti-affinity across nodes and a
  PodDisruptionBudget (`minAvailable: 2`). Kyverno is tier 1: it gets requests,
  limits and `homelab-tier1`.
- **`failurePolicy: Ignore` on every webhook, in every phase, including Enforce.**
  When Kyverno is down, admission falls open. CI is the gate that matters; admission
  only catches drift, and drift during an outage gets caught by the background scan
  afterwards. `Fail` would turn a Kyverno crash into "no pod anywhere can be created",
  including Kyverno's own replacement pods.
- **Webhook namespace exclusions**, whatever the failurePolicy: `kube-system`,
  `longhorn-system`, `kyverno` and `cnpg-system` (Kyverno's `webhooks` and
  `resourceFilters` config). Their pods still show up in background-scan reports.
  These namespaces are checked in CI and by reports only, never blocked at
  admission.
- **Reports controller memory** grows with object count. Cap it with a memory
  limit, and drop admission reports
  (`features.admissionReports.enabled: false`) if background reports are enough.
- If generated native VAPs prove workable (see above), enforcement moves into the
  apiserver and the outage question mostly goes away.

## Pod Security Admission (PSA) and MS-08

- **PSA namespace labels are the cluster's enforcement for MS-08.** PSA runs inside
  the apiserver: it can't go down or fall open, and it is already set up.
- **Kyverno does not duplicate it at admission.** Its MS-08 job is to fail **in CI**
  before a PR merges, with the same semantics: Kyverno's `podSecurity` subrule uses
  the upstream PSA library.
- **The level for each pod comes from its namespace's PSA label.** CI reads it from
  the Namespace object in the same rendered app.
  - **`restricted`:** MS-08 is just PSA restricted.
  - **`baseline` or `privileged`:** MS-08 checks that level, and the Namespace must
    have an MS-08 PolicyException explaining why it is below restricted. Lowering a
    namespace's level then becomes a reviewed, expiring decision.
- **MS-11** requires the label on every Namespace. 15 namespaces have none today,
  which means the cluster default (`privileged`):
  argocd, authentik, cert-manager, cilium-secrets, cloudflared, cnpg-system,
  default, homepage, homepage-preview, kea, kube-node-lease, kube-public,
  kube-system, pgadmin, streamystats.
  - Some (kube-system, default, kube-public, kube-node-lease) aren't owned by an
    app. They get their labels from the `kube-system` app or are excluded.
  - Before raising a namespace to `restricted`, set `warn` and `audit` to
    `restricted` first. The apiserver then reports which pods would fail, without
    blocking.

## Baseline (2026-11-07)

From live pods (`kubectl get pods -A -o json`, Running only, read-only). These are
the numbers phase 0 starts from; the CI baseline over rendered output will differ
a little (operator pods aren't rendered, CRs are).

| | Count |
|---|---|
| Running pods | 169 (9 are Talos static mirror pods) |
| Containers, init included | 283 |
| QoS | **90 BestEffort**, 79 Burstable, **0 Guaranteed** (none of the 16 CNPG instance pods is Guaranteed) |
| Pods by owner | 96 ReplicaSet, 32 DaemonSet, 12 StatefulSet, 16 CNPG Cluster, 4 Longhorn InstanceManager, 9 Node (static) |

| Rule | Violations |
|---|---|
| MS-01 `homelab/tier` label | 169 / 169 pods (the label doesn't exist yet) |
| MS-03 no CPU request | 186 / 283 containers |
| MS-03 no memory request | 189 / 283 containers |
| MS-04 no memory limit (any tier, for scale) | 212 / 283 containers |
| MS-06 no `priorityClassName` | 110 / 169 pods (59 have one: 25 kube-system on system-*-critical, 34 Longhorn on longhorn-critical) |
| MS-07 no readiness probe | 83 main containers |
| MS-07 no liveness probe | 80 main containers |
| MS-08 runAsNonRoot not true | 137 containers |
| MS-08 capabilities not dropping ALL | 119 containers |
| MS-08 no seccomp RuntimeDefault | 147 containers |
| MS-08 privileged | 24 containers (Cilium, Longhorn only) |
| MS-08 host namespaces / hostPath | 23 pods / 54 pods |
| MS-10 no namespace-wide CiliumNetworkPolicy | 15 / 33 namespaces with pods: adguard, argocd, authentik, cert-manager, cnpg-system, homepage, homepage-preview, kea, kube-system, logging, longhorn-system, media, monitoring, music-assistant, pgadmin |
| MS-11 no PSA enforce label | 15 namespaces (listed above) |

Pods missing a CPU or memory request, by namespace (the backfill map):

| All pods affected | Partly affected | Already clean |
|---|---|---|
| adguard 3/3, argocd 7/7, authentik 5/5, cert-manager 3/3, hermes 1/1, home-assistant 1/1, homepage 1/1, homepage-preview 1/1, kea 3/3, longhorn-system 34/34, playwright-mcp 1/1, redis 3/3 | kube-system 17/29, monitoring 12/14, harbor 8/9, matrix 2/7, langfuse 2/5, nextcloud 2/4, paperclip 2/3, cnpg-system 1/2, logging 1/5 | media, streamystats, searxng, argo-workflows, cloudflared, crawl4ai, infra-mcp, music-assistant, pgadmin, research-worker, rustfs, trivy-system |

Most of the tier 0–1 list sits in the "all pods affected" column. That is the first
backfill batch, and it is the same list as `oom-protection.md` step 2.

## Implementation steps (each its own PR, after this doc is agreed)

1. **Kyverno app in Audit mode:**
   - `kubernetes/platform/security/kyverno/`: chart pinned, HA values, webhook
     exclusions, `failurePolicy: Ignore`, PolicyExceptions limited to the `kyverno`
     namespace.
   - **Ask before syncing.** It adds webhooks cluster-wide.
2. **Policies plus tests:**
   - Policies MS-01…08 and MS-11 under `policies/`.
   - `kyverno test` fixtures under `policies/tests/`: one passing and one failing
     resource per rule.
   - The known exceptions.
3. **CI:**
   - Install the Kyverno CLI, pinned, in the workflow.
   - Add `scripts/ci/policy-check.sh`, run in `report` mode with per-app counts in
     the PR comment.
   - Add MS-10 and MS-12 to `repo-lint.sh`.
4. **PriorityClasses** `homelab-tier1` and `homelab-tier2`.
5. **Sizing helper** `scripts/sizing/suggest-resources.sh`, plus an OOMKilled alert
   for tier 0–1.
6. **Backfill PRs** (oom-protection step 2 first). Move `POLICY_MODE` to
   `no-regress`, then `touched`.
7. **Global enforce:** CI `enforce`, then cluster policies to `Enforce` rule by rule.

## Open decisions

- **Exact thresholds:** the 1.15 / 1.5 / 1.3 multipliers, p99 vs max for requests,
  and the 85% per-node ceiling.
- **The tier list itself:** is Harbor really tier 1 (nodes fall back to upstream
  registries when it's down), and is Grafana tier 1 or 2?
- **Probe exemptions:** Jobs and CronJobs are exempt. Do one-shot sidecars or
  workers with no HTTP port get an exec probe, or an exception?
- **Should tier 2 get memory limits at some point**, for noisy apps (media
  transcodes, crawl4ai)? That would be a per-app opt-in, not a rule.
- **`ClusterPolicy` vs `ValidatingPolicy`**, and whether to use generated native VAPs.
  Decide when step 1 pins a Kyverno version.
