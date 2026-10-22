# infra-mcp

A small, homegrown MCP server that gives the Hermes agent **read-only** eyes
on the homelab: pods, deployments, events and logs; Cilium policies and
HTTPRoutes; Argo CD apps and workflows; Longhorn volumes; CNPG clusters;
Talos node status; Prometheus and Loki queries; and Hubble network flows.
Every tool call is written to stdout as a JSON audit line.

| | |
|---|---|
| **URL** | None. Hermes uses `infra-mcp.infra-mcp.svc:8000` in-cluster (bearer token); deliberately not on the Gateway |
| **Image** | `python:3.14-slim`; `server.py` comes from the ConfigMap, and `talosctl` and `hubble` are downloaded at pinned versions at start |
| **Namespace** | `infra-mcp` (PSA `restricted`) |
| **Storage** | None (emptyDir home) |
| **Depends on** | Kubernetes API, Talos API, Prometheus, Loki, Hubble relay, PyPI/GitHub at pod start, the sops-kustomize plugin. Used by Hermes |

## Files

| File | What it is |
|---|---|
| `app.yaml` | Argo CD Application for this folder. Server-Side Apply |
| `kustomization.yaml` | Lists the manifests below |
| `namespace.yaml` | Namespace with Pod Security `restricted` |
| `serviceaccount.yaml` | `infra-mcp-sa`; the only app here that mounts its token, because reading the API is its job |
| `clusterrole.yaml` | `infra-mcp-read`: get/list/watch only, on an explicit list of resources |
| `clusterrolebinding.yaml` | Binds that role to the ServiceAccount |
| `secret.sops.yaml` | `infra-mcp-secret`: the MCP bearer token and a talosconfig (SOPS/age encrypted) |
| `configmap.yaml` | `entrypoint.sh` (installs deps, fetches CLIs) and `server.py` (the MCP tools) |
| `deployment.yaml` | The server, as UID 1000 |
| `service.yaml` | ClusterIP on 8000 |
| `networkpolicy.yaml` | Default-deny plus one rule per backend it reads; ingress from Hermes only |

## Security model

- **Read-only RBAC.** `get`/`list`/`watch` only. No Secrets, no `exec`, no
  RBAC objects, and no write verb anywhere. Adding a resource to a tool means
  adding it to `clusterrole.yaml` first.
- **Egress is per backend.** API server (Cilium's `kube-apiserver` entity),
  Talos API on the VIP and the 4 node IPs, Prometheus, Loki, Hubble relay,
  and public internet on 80/443 with private ranges excluded.
- **Two locks on ingress:** the network policy admits only the Hermes pod,
  and the server also checks a bearer token.

## Gotchas

- **Network policy ports are container ports.** Hubble relay is 4245, not
  the Service's 80, because Cilium enforces after the Service DNAT.
- **Talos needs the VIP *and* the node IPs.** `talosctl` dials the
  talosconfig endpoint (the VIP) first, then routes to each `-n` node through it.
- **`mcp<2` is pinned.** mcp 2.x renamed FastMCP and changed the API.
- **The allowed Host headers are the in-cluster names.** The mcp SDK rejects
  other Host headers (421). Add a name to `allowed_hosts` in `server.py` if a
  new client uses a different one.
- **Keep the CLIs in step with the cluster.** `talosctl` and `hubble` are
  pinned in `entrypoint.sh` to match Talos and Cilium; bump them on upgrades.
- **The bearer token is duplicated in Hermes** as `INFRA_MCP_AUTH_TOKEN`.
  Rotate both together.
- **Backend URLs are hard-coded in `server.py`** (Prometheus, Loki, Hubble).
  If those services move or are renamed, update them here too.
