# playwright-mcp

Microsoft's Playwright MCP server: a headless Chromium that Hermes can drive
step by step (navigate, click, type, read the page). Crawl4AI reads a page
once; this is for interactive browsing. It runs in its own pod rather than
as a subprocess of Hermes, so a compromised browser lands in a disposable pod
with no secrets and no way back into Hermes.

| | |
|---|---|
| **URL** | None. Hermes uses `playwright-mcp.playwright-mcp.svc:8931` in-cluster; deliberately not on the Gateway |
| **Image** | `mcr.microsoft.com/playwright`, pinned by digest; `@playwright/mcp` (pinned version) is installed from npm at start |
| **Namespace** | `playwright-mcp` (PSA `restricted`) |
| **Storage** | None (emptyDirs only; a 1Gi in-memory `/dev/shm`) |
| **Depends on** | npm registry at pod start. Used by Hermes |

## Files

| File | What it is |
|---|---|
| `app.yaml` | Argo CD Application for this folder |
| `kustomization.yaml` | Lists the manifests below |
| `namespace.yaml` | Namespace with Pod Security `restricted` |
| `serviceaccount.yaml`, `role.yaml`, `rolebinding.yaml` | A token-less ServiceAccount bound to an empty Role: no API access |
| `deployment.yaml` | An init container installs the MCP server and browser; the main container runs it as UID 1000 |
| `service.yaml` | ClusterIP on 8931 |
| `networkpolicy.yaml` | Default-deny, DNS, public internet on 80/443 only, ingress from Hermes and Homepage only |

## Security model

Hermes has no per-call approval for MCP tools, so the controls are around the
browser rather than a human clicking approve:

- **Network:** egress only to the public internet on 80/443, with private,
  link-local and loopback ranges excluded. Playwright's own origin filters
  don't apply to redirects, so this is enforced by Cilium instead.
- **`--isolated`:** an in-memory profile, so no cookies or logins persist.
- **`--no-webmcp`:** stops pages registering their own "tools", which Hermes
  would otherwise see as real MCP tools (a prompt-injection path).
- **`--idle-timeout`:** the browser is recycled after 10 idle minutes.
- **Downloads stay in the pod**, on a volume Hermes can't see.
- **Never root.** `fsGroup: 1000` lets the init container install into shared
  emptyDirs without root or chown.

## Gotchas

- **`@playwright/mcp` is pinned** (in `deployment.yaml`'s init container),
  though it's still downloaded from npm at every start. Until October 2026 it
  was `@latest`, so any restart could silently upgrade it. Upgrade by bumping
  the version; the browser build it installs changes with it.
- **The browser needs `install-browser chrome-for-testing`.** `--browser
  chromium` actually means that channel, and a plain `playwright install
  chromium` doesn't fetch it ("Browser not installed" on every navigate).
- **The init and main containers must use the same image** so the downloaded
  browser matches the OS libraries.
- **`--allowed-hosts` lists the exact in-cluster names.** The default host
  check rejects anything that isn't literally the bind address. Add a name
  there if a new client uses a different one.
- **`--no-sandbox`:** Chromium's sandbox needs user namespaces the cluster
  doesn't grant; the pod's own isolation is the boundary.
