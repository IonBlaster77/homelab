# Kyverno

Policy engine for the cluster's manifest standards. **Phase 0: audit only.**
It checks every live object against the rules below and writes the results
as `PolicyReport` objects. It never blocks or changes anything: every
policy is `validationActions: [Audit]` and every webhook fails open.

Trivy Operator answers "what known vulnerabilities are in our images?".
Kyverno answers "is what we deploy configured the way we said it would be?".

| | |
|---|---|
| **URL** | None. Results via `kubectl get policyreports -A` (below); Atlas ingest and a Homepage card come later |
| **Charts** | [`kyverno`](https://github.com/kyverno/kyverno) and `kyverno-policies` from `kyverno.github.io/kyverno`, both pinned to the same release in `app.yaml` |
| **Namespace** | `kyverno` (PSA restricted) |
| **Storage** | None (reports are API objects) |
| **Depends on** | API server only; images through Harbor's GHCR proxy |
| **Design** | [`docs/projects/manifest-standards.md`](../../../../docs/projects/manifest-standards.md) |

## What it checks

| ID | Policy | What fails |
|---|---|---|
| MS-03 | `ms-03-requests` | A Pod container or init container without a CPU and memory request |
| MS-07 | `ms-07-probes` | A Deployment / StatefulSet / DaemonSet container without readiness and liveness probes |
| MS-08 | upstream `kyverno-policies`, 18 policies | Pod Security Standards **restricted** (baseline + restricted: privileged, host namespaces/ports/paths, capabilities, runAsNonRoot, seccomp, privilege escalation, volume types, ...) |
| MS-09 | `ms-09-image-tag` | An image with no digest and no tag, or `:latest` |
| MS-11 | `ms-11-psa-label` | A Namespace without a valid `pod-security.kubernetes.io/enforce` label |

MS-08 reports every pod against `restricted`, whatever its namespace's PSA
label says, so privileged-by-design pods (Cilium, Longhorn, node-exporter,
gluetun, music-assistant) show up as failures until their exceptions are
written. That is expected in phase 0.

Framework mapping, for Atlas: MS-08 is the Pod Security Standards profile
that CIS Kubernetes Benchmark section 5.2 and the NSA/CISA Kubernetes
Hardening Guide describe. Trivy Operator's `ClusterComplianceReport`
(`k8s-nsa-1.0`, `k8s-pss-*`) checks the same ground from the scanner side.

## Files

| File | What it is |
|---|---|
| `app.yaml` | Argo CD Application, three sources: engine chart, policies chart, this folder. Server-Side Apply |
| `values.yaml` | Engine: GHCR images, fail-open webhooks, admission reports off, exceptions only from this namespace, background/cleanup controllers off, 2 admission replicas, sizing |
| `values-policies.yaml` | Pod Security Standards set to `restricted`, Audit |
| `policies/` | Our own CEL `ValidatingPolicy` rules (MS-xx) |
| `policies/tests/` | `kyverno test` fixtures: a passing and a failing resource per rule, plus edge cases. Not applied to the cluster |
| `kustomization.yaml` | Lists this folder's own manifests |
| `networkpolicy.yaml` | Default deny, plus DNS, API server out, webhook in from the API server (:9443), intra-namespace, Prometheus scrapes (:8000) |

## Reading the results

```bash
# Per-namespace pass/fail counts
kubectl get policyreports -A
# One namespace's failures, by policy and resource
kubectl get policyreports -n media -o json \
  | jq -r '.items[].results[]? | select(.result=="fail") | [.policy, .resources[0].kind, .resources[0].name, .message] | @tsv'
# Cluster-scoped objects (Namespaces: MS-11)
kubectl get clusterpolicyreports
# Is a policy loaded and ready?
kubectl get validatingpolicies
```

The background scan runs hourly and on every change, so a fix shows up
in the report within minutes of Argo CD syncing it.

## Testing a policy change

The Kyverno CLI (same version as the engine) is in WSL at
`~/.local/bin/kyverno`. Both commands are read-only:

```bash
# Unit tests: every policy against the fixtures
cd kubernetes/platform/security/kyverno/policies/tests && kyverno test .
# Preview against the live cluster (reads objects, evaluates locally,
# writes nothing). Add --cluster-wide-resources for Namespace rules.
cd .. && kyverno apply validatingpolicy-ms-*.yaml --cluster -t
```

Add a fixture to `tests/resources.yaml` and an expected result to
`tests/kyverno-test.yaml` with every new rule or edge case.

## Gotchas

- **Kyverno 1.20 ignores legacy `ClusterPolicy` objects.** Policies found
  online in the older format do nothing here; write CEL `ValidatingPolicy`.
- **Fail-open on purpose.** `features.forceFailurePolicyIgnore` makes every
  webhook `Ignore`, even when Enforce comes. If Kyverno is down, admission
  goes ahead and the next background scan catches anything missed.
- **If the webhook network policy is wrong**, every matched request waits
  for the webhook timeout (10s) before going ahead. Symptom: slow
  `kubectl apply`/Argo syncs. Check Hubble for drops to `kyverno` on 9443.
- **Webhook-excluded namespaces:** `kube-system`, `longhorn-system`,
  `cnpg-system` (and `kyverno`) are never in the admission path, so they can
  heal on a cold boot before Kyverno is up. They are still in the
  background-scan reports.
- **Bump both charts together.** `kyverno-policies` is versioned with the
  engine.
- **Reports aren't in Argo CD.** Argo CD's default `resource.exclusions`
  already skip PolicyReports and Kyverno's intermediate reports.
