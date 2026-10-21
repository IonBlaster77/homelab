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
- **#alerts-critical:** every alert from `@alertbot` gets an automatic
  investigation, posted in that alert's thread (Summary / Investigation /
  Findings / Likely cause / Follow-ups), per the **alert-triage** skill
  (`configmap-skill-alert-triage.yaml`, mounted into the skills tree).
  Read-only: it diagnoses and plans, never changes anything.
- **#alerts-warning:** answers only when @mentioned. Warnings are covered
  by the **daily health review** instead (Hermes cron job, below).
- **Who can trigger it:** `@kmoorthy`, and `@alertbot` (critical alerts).
  Invites are only accepted from those two. The digest (an `m.notice`) is
  ignored. `MATRIX_APPROVAL_REQUIRE_SENDER=false` lets the owner answer
  approval prompts raised during alert-triggered turns.
- **Daily health review:** one cron job, `daily-health-review`
  (→ #log-digest), 22:00 UTC (08:30 Adelaide in summer, 07:30 in winter):
  warnings, restarts and error logs in one report. It lives in Hermes' own
  state (`~/.hermes/cron`, on the PVC), not in git; `hermes cron list` shows
  it. Settings that matter: continuity on (sees its previous report),
  `enabled_toolsets` `[infra-mcp, skills, file, todo]` (cron always blocks
  terminal/code execution, so don't offer them), report must end with
  "End of daily health review." The old `daily-warning-review` job is
  paused, not deleted.
- **Hardware deals:** three cron jobs (→ #hermes), one per category, daily:
  `hardware-deals-gpus` 21:00, `hardware-deals-ram` 21:20 and
  `hardware-deals-storage` 21:40 UTC (07:30–08:10 Adelaide in summer),
  continuity on. Each searches Australian prices for its part of the watchlist in
  the **hardware-deals** skill (`configmap-skill-hardware-deals.yaml`: RAM,
  DDR4/DDR5 SODIMM+UDIMM, SSD/NVMe incl. ServerPartDeals enterprise SSDs,
  GPUs, with target prices; edit it there) and reports deals worth
  acting on. Posts a daily digest every day (deals first, then today's prices; a week in review on Mondays).
  `enabled_toolsets` `[searxng, crawl4ai, skills, file, todo]`; it keeps a
  price log per category in `/opt/data/hardware-deals/price-log-*.csv` (the file tools run on research-worker over SSH and only write under /opt/data; that path is its workspace PVC subdirectory hardware-deals). Look only: never
  buys, signs in or contacts sellers. Created by
  `restructure-tools/hermes-deals-cron-setup.sh`.
- **Fallback:** if that report hasn't arrived by 23:00 UTC, the
  `log-digest` CronJob (monitoring namespace) posts plain error counts to
  #log-digest instead.
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
