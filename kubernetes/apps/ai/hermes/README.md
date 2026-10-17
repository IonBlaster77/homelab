# Hermes

[Hermes Agent](https://github.com/NousResearch/hermes-agent) from Nous
Research: a self-hosted AI agent with memory, a web UI and a CLI. It calls
hosted LLM APIs and uses the rest of `kubernetes/apps/ai/` as its tools:

| Tool | App | How |
|---|---|---|
| Web search | [searxng](../searxng/) | MCP bridge, bearer token |
| Read a URL | [crawl4ai](../crawl4ai/) | MCP over SSE, bearer token |
| Interactive browser | [playwright-mcp](../playwright-mcp/) | MCP over HTTP |
| Cluster/infra status (read-only) | [infra-mcp](../infra-mcp/) | MCP over HTTP, bearer token |
| Terminal / code execution | [research-worker](../research-worker/) | `terminal.backend: ssh` |

| | |
|---|---|
| **URL** | https://hermes.jupitertech.net (web UI, via the Gateway, behind Cloudflare Access); SSH sidecar on `hermes-ssh:2222` from the Trusted VLAN |
| **Image** | `nousresearch/hermes-agent`, pinned by tag and digest |
| **Namespace** | `hermes` (PSA `baseline`, for the SSH sidecar) |
| **Storage** | `hermes-data`, 10Gi Longhorn RWO: `~/.hermes` (config, memory, sessions) |
| **Depends on** | The five tool apps above, Gateway, Longhorn, the sops-kustomize plugin, outbound internet for LLM APIs |

## Files

| File | What it is |
|---|---|
| `app.yaml` | Argo CD Application for this folder. Server-Side Apply |
| `kustomization.yaml` | Lists the manifests below |
| `namespace.yaml` | Namespace, PSA `baseline` |
| `serviceaccount.yaml`, `role.yaml`, `rolebinding.yaml` | The pod's ServiceAccount and its (namespace-scoped) role |
| `secret.sops.yaml` | `hermes-secret`: LLM API keys, MCP bearer tokens, SSH keys (SOPS/age encrypted) |
| `pvc.yaml` | `hermes-data` |
| `configmap.yaml` | Base Hermes settings |
| `configmap-mcp-servers.yaml` | The MCP/terminal/approvals fragment merged into `config.yaml` at start |
| `deployment.yaml` | Init containers (permissions, config merge) + `hermes-agent`, `hermes-webui`, `hermes-ssh` |
| `service-webui.yaml` / `service-ssh.yaml` | Web UI on 8787, SSH on 2222 |
| `httproute.yaml`, `referencegrant.yaml` | `hermes.jupitertech.net` → the web UI |
| `networkpolicy.yaml` | Default-deny; internet for LLM APIs; one egress rule per tool; Gateway, Homepage and Trusted-VLAN SSH in |

## Matrix

Hermes is on Matrix as `@hermes:matrix.jupitertech.net` (gateway platform
`matrix`, settings `MATRIX_*` in `configmap.yaml`, token `MATRIX_ACCESS_TOKEN`
in `secret.sops.yaml`, synced into `.env` by `sync-env-secrets`).

- **#hermes** (in the Homelab space): answers every message; also its home
  room for scheduled output.
- **#alerts-critical / #alerts-warning:** answers only when @mentioned,
  e.g. reply to an alert with "@hermes why did this fire?".
- **Only `@kmoorthy` can trigger it.** Alerts posted by `@alertbot` do not
  start agent turns, and the daily digest (an `m.notice`) is ignored.
- Rooms are unencrypted (`MATRIX_E2EE_MODE=off`). Element X makes **direct
  messages encrypted by default**, so DMs to `@hermes` won't be readable:
  use the #hermes room.
- The token is a MAS compatibility token for device `hermes-gateway`
  (`mas-cli manage issue-compatibility-token hermes hermes-gateway`).

## Gotchas

- **`configmap-mcp-servers.yaml` is merged at startup, not live.** An init
  container deep-merges it into `~/.hermes/config.yaml` on the volume. After
  changing it, bump `hermes/config-fragment-rev` in `deployment.yaml` so the
  pod restarts and re-merges. The fragment is authoritative for `mcp_servers`.
- **Shell commands never run in this pod.** `terminal.backend: ssh` sends
  them to research-worker, which holds no secrets. This pod has the API
  keys, so local execution here would expose them.
- **Tokens are duplicated across namespaces.** `CRAWL4AI_AUTH_TOKEN`,
  `SEARXNG_MCP_AUTH_TOKEN`, `INFRA_MCP_AUTH_TOKEN` and the research-worker
  SSH key must match the copies in those apps' secrets. Rotate in pairs.
- **The internet egress rule excludes cluster and LAN ranges**, so a
  confused or prompt-injected agent can't reach the API server or the
  management VLAN. Each in-cluster tool gets its own explicit rule.
- **Restart by deleting the pod**, never `kubectl rollout restart`.
