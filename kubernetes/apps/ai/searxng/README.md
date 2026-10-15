# SearXNG

A private metasearch engine. It queries upstream search engines on your
behalf and returns combined results without tracking. A second pod, the MCP
bridge (`mcp-searxng`), turns it into a `web_search` tool for the Hermes agent.

| | |
|---|---|
| **URL** | https://searxng.jupitertech.net (web UI, via the Gateway). The MCP bridge has no route: Hermes reaches it in-cluster on `searxng-mcp.searxng.svc:3000` |
| **Images** | `searxng/searxng`, `isokoliuk/mcp-searxng` |
| **Namespace** | `searxng` (PSA `restricted`) |
| **Storage** | None (stateless) |
| **Depends on** | Gateway (`homelab-gateway`), the sops-kustomize plugin. Used by Hermes |

## Files

| File | What it is |
|---|---|
| `app.yaml` | Argo CD Application for this folder |
| `kustomization.yaml` | Lists the manifests below |
| `namespace.yaml` | Namespace with Pod Security `restricted` |
| `serviceaccount.yaml`, `role.yaml`, `rolebinding.yaml` | A token-less ServiceAccount bound to an empty Role: the pods get no API access |
| `secret.sops.yaml` | `searxng-secret`: the whole `settings.yml` plus the bridge's bearer token (SOPS/age encrypted) |
| `configmap-mcp.yaml` | Bridge settings: SearXNG URL, listen address, result trimming |
| `deployment.yaml` / `service.yaml` | SearXNG itself, port 8080 |
| `deployment-mcp.yaml` / `service-mcp.yaml` | The MCP bridge, port 3000 |
| `httproute.yaml` | `searxng.jupitertech.net` → the SearXNG Service (lives in the `networking` namespace) |
| `referencegrant.yaml` | Lets that cross-namespace route reach the Service |
| `networkpolicy.yaml` | Default-deny plus explicit allows; see below |

## Network policy

Everything is denied unless allowed:

- **SearXNG** may reach DNS and the internet (it has to query search engines),
  and accepts traffic from the bridge, the Gateway and Homepage's status widgets.
- **The bridge** may only reach the SearXNG Service, and only Hermes may call it.
- **Neither pod can reach the Kubernetes API server.** The reply-traffic rules
  carve out the API VIP on purpose (see the comments in `networkpolicy.yaml`).

## Gotchas

- **`settings.yml` lives in the Secret, not a ConfigMap.** SearXNG's
  entrypoint only generates `server.secret_key` when no `settings.yml` is
  mounted, so the mounted file must already contain the real key.
- **`enableServiceLinks: false` is required.** Kubernetes injects
  `SEARXNG_PORT=tcp://...` for the `searxng` Service, which collides with
  SearXNG's own `$SEARXNG_PORT` and breaks startup.
- **The bridge token is duplicated in Hermes.** `SEARXNG_MCP_AUTH_TOKEN` here
  must match the same key in Hermes' secret. A SOPS secret can't be shared
  across namespaces, so rotate both together.
- **Result trimming is in the bridge** (`SEARXNG_MAX_RESULTS`,
  `SEARXNG_MAX_RESULT_CHARS`), not in SearXNG, to keep the agent's token use down.
