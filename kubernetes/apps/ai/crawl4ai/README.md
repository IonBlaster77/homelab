# Crawl4AI

A web crawler built on headless Chromium. It loads a page like a real browser
(JavaScript included) and returns clean markdown. Hermes uses it over MCP as
its one "read this URL" tool; SearXNG finds pages, Crawl4AI reads them.

| | |
|---|---|
| **URL** | https://crawl4ai.jupitertech.net (playground and REST API, via the Gateway). Hermes uses `crawl4ai.crawl4ai.svc:11235/mcp/sse` in-cluster |
| **Image** | `unclecode/crawl4ai` |
| **Namespace** | `crawl4ai` (PSA `restricted`) |
| **Storage** | None (stateless; a 1Gi in-memory `/dev/shm` for Chromium) |
| **Depends on** | Gateway (`homelab-gateway`), the sops-kustomize plugin. Used by Hermes |

## Files

| File | What it is |
|---|---|
| `app.yaml` | Argo CD Application for this folder. Server-Side Apply |
| `kustomization.yaml` | Lists the manifests below |
| `namespace.yaml` | Namespace with Pod Security `restricted` |
| `serviceaccount.yaml`, `role.yaml`, `rolebinding.yaml` | A token-less ServiceAccount bound to an empty Role: the pod gets no API access |
| `secret.sops.yaml` | `crawl4ai-secret`: the API bearer token (SOPS/age encrypted) |
| `configmap.yaml` | The full `config.yml` mounted over the image's own, tuned for one user |
| `deployment.yaml` | The crawler; prefers `talos3`/`talos4` for memory headroom |
| `service.yaml` | ClusterIP on 11235 |
| `httproute.yaml` | `crawl4ai.jupitertech.net` → the Service (lives in the `networking` namespace) |
| `referencegrant.yaml` | Lets that cross-namespace route reach the Service |
| `networkpolicy.yaml` | Default-deny plus explicit allows; see below |

## Network policy

Everything is denied unless allowed. The pod may reach DNS and the internet
(it has to fetch arbitrary sites), and accepts traffic only from Hermes, the
Gateway and Homepage's status widgets. **It cannot reach the Kubernetes API
server**: the reply-traffic rule carves out the API VIP, because a scraper
fed untrusted pages has no reason to talk to the cluster.

## Gotchas

- **The token does two jobs.** `CRAWL4AI_API_TOKEN` turns on bearer auth for
  every route (MCP included), and without it the server refuses to bind beyond
  loopback at all.
- **The token is duplicated in Hermes** as `CRAWL4AI_AUTH_TOKEN`. A SOPS secret
  can't be shared across namespaces, so rotate both together.
- **`enableServiceLinks: false` is required.** Kubernetes injects
  `CRAWL4AI_PORT=tcp://...` for the `crawl4ai` Service, which collides with the
  entrypoint's own `$CRAWL4AI_PORT`.
- **`configmap.yaml` is the whole config file, not a delta.** Check it against
  the new image's default `config.yml` before upgrading; the schema changes
  between releases.
- **`/dev/shm` must be a real memory volume.** The container default (64Mi)
  makes Chromium crash tabs under load.
- **UID 999 is set explicitly.** The image's `USER appuser` is a name, which
  kubelet can't check against `runAsNonRoot`.
