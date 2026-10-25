# Paperclip

Control plane for lightweight agents. Pi runs Hermes' routine crons here, so
those crons stop paying for Hermes' full context. Phase 3 of task #50. Plan and
decisions: [`docs/projects/agent-observability.md`](../../../../docs/projects/agent-observability.md).

| | |
|---|---|
| **URL** | https://paperclip.jupitertech.net (LAN only, via an AdGuard rewrite to the Gateway VIP) |
| **Image** | `ghcr.io/paperclipai/paperclip:2026.1023.0`, pinned by digest |
| **Pi** | `@earendil-works/pi-coding-agent` 1.4.0, installed onto the data volume by the `install-pi` initContainer |
| **Namespace** | `paperclip` (PSA `restricted`) |
| **Database** | CNPG `paperclip-db` (2 instances), point-in-time recovery to RustFS `s3://cnpg/paperclip-db/` |
| **Storage** | `paperclip-data`, 10Gi Longhorn: config, workspaces, agent sessions, the Pi install |
| **Secrets** | `paperclip-secrets` (SOPS): auth, agent-JWT, approval-signing and secrets-encryption keys |

## How it's sandboxed

Paperclip's adapters start agent CLIs as child processes **inside the server
pod**, so the pod itself is the sandbox (decided 2026-10-24):

- **Pod hardening:** non-root (uid 1000), read-only root filesystem, every
  capability dropped, and no service-account token.
- **Egress:** the public internet on 80/443 only, for model providers and npm.
  Private, link-local and loopback ranges are excluded.
- **Other egress:** its own Postgres, DNS, and replies to the Gateway. Reply
  traffic may go to the four node IPs, never to the NAS, the API VIP or the
  rest of the LAN. Update the list in `networkpolicy.yaml` if nodes change.
- **No in-cluster services yet.** A cron that needs one (searxng, crawl4ai,
  Langfuse) gets its own egress rule here plus ingress on the service's side,
  added when that cron moves.

## Tracing to Langfuse

Every Pi run is traced by `pi-extension-langfuse.ts`. It's home-grown with no
npm dependencies, so no third-party code runs next to the model sign-in.

- **What it sends:** one "Pi run" trace per run, with the Pi session as the
  Langfuse session. Each model call is a generation with its token usage, and
  each tool call is a tool span.
- **Before it leaves the pod:** text is masked with the Claude Code hook's
  rules and truncated.
- **Where it goes:** the "agents" project, over OTLP/HTTP JSON to
  `langfuse-web` in-cluster, using the `pi-langfuse` secret mounted at
  `/etc/pi-langfuse`.
- **How it's installed:** the ConfigMap generator ships the file, and the
  initContainer copies it into `~/.pi/agent/extensions/` on every start.
- **Failure and opt-out:** an export failure is logged to stderr and never
  fails the run. `PI_LANGFUSE_DISABLE=1` turns it off.

Test the masking in the pod with `node` (Node 24 runs `.ts` directly):
`import("/paperclip/.pi/agent/extensions/langfuse.ts")` and call `mask()`.

## MCP

Pi 1.4 has built-in MCP (stdio and streamable HTTP, **not SSE**) in
`~/.pi/agent/mcp.json`. Its default `codemode` exposure keeps tool definitions
out of the model's context. So crons can use the same MCP servers as Hermes,
not CLI wrappers.

- **Network:** each server needs an egress rule here and ingress on its side.

Pi's agent config lives in this folder and is copied into `~/.pi/agent/` by the
initContainer on every start. Git is the source of truth, so changes made in
Pi's `/mcp` UI don't survive a restart.

| File | Goes to | What it is |
|---|---|---|
| `pi/mcp.json` | `~/.pi/agent/mcp.json` | searxng-mcp (search tool `direct`, `web_url_read` hidden). The token is read from `/etc/pi-tools` by a header command |
| `pi/hardware-deals-SKILL.md` | `~/.pi/agent/skills/hardware-deals/SKILL.md` | Port of Hermes' hardware-deals skill 1.6.2 (see below) |
| `pi/md.sh` | `…/hardware-deals/scripts/md.sh` | Page → markdown through crawl4ai's REST `/md` |

**crawl4ai** (0.9.5) offers MCP only over SSE, which Pi can't use, so the skill
calls the REST `/md` endpoint through `md.sh`. That's the same thing Hermes' `md`
tool does. Tokens: the `pi-tools` secret, the same ones as Hermes'.

**What the Pi port of hardware-deals changes:**
- **Tools:** `scripts/md.sh` instead of crawl4ai's `md` tool.
- **Files:** the price logs live in `/paperclip/data/hardware-deals/`.
- **Budget:** about 60–70 calls instead of Hermes' 100-turn cap.
- **Previous report:** read from `last-report-<category>.md` instead of
  Hermes' `context_from`, so each run can start a fresh session rather than
  growing one.
- **Delivery:** the report is the run's final answer in Paperclip. Matrix
  delivery isn't wired: that's still to decide.

Before cutting over, copy Hermes' `/opt/data/hardware-deals/price-log-*.csv`
here, then disable the Hermes crons.

## First start (needs the user)

1. Open the URL, create an account, and choose **Claim this instance**. In
   `authenticated/private` mode, the first person to sign in can claim it, so
   do this right after the first sync.
2. Set `PAPERCLIP_AUTH_DISABLE_SIGN_UP` to `"true"` in `deployment.yaml` so
   nobody else on the LAN can register.
3. Sign Pi in to the model provider. ChatGPT plan first (decision #11): run
   `kubectl -n paperclip exec -it deploy/paperclip -- pi`, then `/login`. With
   no browser in the pod, paste the redirect URL or code back in. Don't copy
   Hermes' ChatGPT credentials: the two clients would rotate one refresh token
   between them and log each other out.
4. Take the first base backup of `paperclip-db` by hand (see the
   cnpg-barman-cloud README).

## Upgrades

Renovate bumps the image (`2026.MMDD.N` CalVer). The Pi version is
`PI_VERSION` in the initContainer: Renovate doesn't see it, so bump it by hand.
The initContainer reinstalls only when that version changes.
