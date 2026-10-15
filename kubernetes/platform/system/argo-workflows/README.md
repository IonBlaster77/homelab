# Argo Workflows

A workflow engine: each step of a job runs as its own pod. Here it is used
for one thing, building container images from this repo with rootless
BuildKit (the `build-image` template). Separate from Argo CD, which deploys;
this runs jobs.

| | |
|---|---|
| **URL** | None yet. The UI is reachable only by `kubectl port-forward` (see Gotchas) |
| **Chart** | [`argo-workflows`](https://github.com/argoproj/argo-helm/tree/main/charts/argo-workflows) from `argoproj.github.io/argo-helm`, version pinned in `app.yaml` |
| **Namespaces** | `argo-workflows` (controller + UI, PSA `restricted`), `argo-builds` (build pods, PSA `privileged`; see below) |
| **Storage** | None |
| **Depends on** | Kubernetes API; github.com and ghcr.io for builds |

## Files

| File | What it is |
|---|---|
| `app.yaml` | Argo CD Application with two sources: the chart, and this folder. Uses Server-Side Apply |
| `values.yaml` | Chart values: workflow pods go to `argo-builds`, parallelism 2, seccomp for restricted PSA, `server` auth mode |
| `kustomization.yaml` | Lists this folder's own manifests |
| `namespace-argo-builds.yaml` | The build sandbox namespace; its header explains the `privileged` label |
| `networkpolicy.yaml` | Default-deny for both namespaces, plus DNS, API server, HTTPS out for builds, Prometheus and Homepage in |
| `workflowtemplate-build-image.yaml` | The reusable image build (BuildKit, daemonless, as uid 1000) |

The chart makes the CRDs, controller, UI server and RBAC. The `argo-workflows`
namespace itself is created by Argo CD with its PSA labels
(`managedNamespaceMetadata` in `app.yaml`).

## Gotchas

- **`argo-builds` is labelled `privileged`, but the pods aren't.** Rootless
  BuildKit needs an `Unconfined` seccomp profile, which `baseline` forbids,
  and PSA has nothing in between. The build pod still runs as uid 1000 with
  no privileged flag, host namespaces or added capabilities. Treat any pod
  there that wants more as a red flag.
- **`server` auth mode means no login.** The UI acts as its own
  ServiceAccount. That's only acceptable because it isn't exposed. Switch to
  SSO (Authentik) or put it behind Cloudflare Access before giving it a hostname.
- **The build template has no push credential yet**, so it can't publish
  images until one is added.
- **Parallelism is capped at 2** to protect cluster CPU; raise it when there
  is dedicated build capacity.
- **Project `default`.** This app still uses the `default` AppProject;
  moving it to `homelab` is a pending cleanup.
- **Server-Side Apply** is required: the Workflow CRDs are too large for a
  client-side apply's last-applied annotation.
