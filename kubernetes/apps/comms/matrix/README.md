# Matrix

The homelab's alert inbox and chat workspace. Alerts arrive in rooms
(grouped in a space), you read and discuss them from the Element apps on
phone and computer, and AI agents (Hermes) join the rooms as bots to read and
analyse them.

Deployed with Element's official **ESS Community** chart: Synapse (the Matrix
server), Matrix Authentication Service (MAS, the sign-in service) and Element
Web.

| | |
|---|---|
| **URLs** | https://chat.jupitertech.net (Element Web, behind Cloudflare Access) · https://matrix.jupitertech.net (server API, public) · https://account.jupitertech.net (sign-in, public) |
| **Apps** | Element X (iPhone/Android): enter `matrix.jupitertech.net` as the server |
| **Matrix IDs** | `@<authentik username>:matrix.jupitertech.net` (the server name can never change) |
| **Chart** | [`matrix-stack`](https://github.com/element-hq/ess-helm) from `ghcr.io/element-hq/ess-helm` (OCI), version pinned in `app.yaml` |
| **Namespace** | `matrix` (PSA `restricted`) |
| **Storage** | Postgres via CloudNativePG (`matrix-db`, 2 × 5Gi NVMe, databases `synapse` and `mas`); Synapse media 10Gi Longhorn |
| **Depends on** | Authentik (sign-in), CloudNativePG, Gateway, Cloudflare tunnel, `bootstrap/argocd-ess-helm-repo.yaml` (OCI repo entry) |

## Files

| File | What it is |
|---|---|
| `app.yaml` | Argo CD Application with two sources: the chart, and this folder. Server-Side Apply |
| `values.yaml` | Chart values: server name, external database, federation off, push without content, Authentik-only sign-in |
| `kustomization.yaml` | Lists this folder's own manifests |
| `namespace.yaml` | Namespace with Pod Security `restricted` |
| `cluster-matrix-db.yaml` | CloudNativePG cluster; creates the `synapse` database (C locale, which Synapse requires) and the `mas` role |
| `database-mas.yaml` | The `mas` database in the same cluster |
| `secret-matrix-db-mas.sops.yaml` | Password of the `mas` database role (SOPS/age) |
| `secret-matrix-mas-upstream.sops.yaml` | MAS's Authentik provider config, with client id and secret (SOPS/age) |
| `httproute-matrix.yaml` | `matrix.` → Synapse and the well-known file; federation and the admin API blocked |
| `httproute-account.yaml` | `account.` → MAS |
| `httproute-chat.yaml` | `chat.` → Element Web |
| `referencegrant.yaml` | Lets the routes (in `networking`) reach this namespace's Services |
| `secret-matrix-alertbot.sops.yaml` | `@alertbot`'s access token and the bridge's webhook password (SOPS/age) |
| `configmap-alertmanager-receiver.yaml` | Alert bridge config: room mapping (`alerts-critical`, `alerts-warning`) |
| `deployment-alertmanager-receiver.yaml`, `service-alertmanager-receiver.yaml` | The alert bridge ([matrix-alertmanager-receiver](https://github.com/metio/matrix-alertmanager-receiver)), posting as `@alertbot` |

## Rooms

All in the **Homelab** space (`#homelab:matrix.jupitertech.net`), created by
`@alertbot` with you as co-creator (full power). Invite-only, unencrypted,
never federated.

| Room | Receives |
|---|---|
| `#alerts-critical` | Alertmanager `severity=critical`, batched every 5m, repeated hourly while firing |
| `#alerts-warning` | Alertmanager `severity=warning`, batched every 15m, repeated every 4h |
| `#log-digest` | Hermes' daily health review (22:00 UTC); a plain error-count digest at 23:00 UTC only if that review didn't arrive |

Routing lives in `kubernetes/platform/observability/monitoring/values.yaml`
(`alertmanager.config`). Rooms use room version 12: the creator must not be
listed in power levels, so the owner is added via `additional_creators`.
| `networkpolicy.yaml` | Default-deny plus explicit allows; see below |

## Security model

- **Sign-in is Authentik only** (password + 2FA). MAS's own passwords and
  self-registration are off; an account is created on first Authentik login.
  Who may log in is decided by the bindings on the **Matrix** application in
  Authentik.
- **Federation is off.** The server never talks to other Matrix servers, and
  `/_matrix/federation`, `/_matrix/key` and `/_synapse/admin` are blocked at
  the Gateway.
- **Public on purpose:** `matrix.` and `account.` have a Cloudflare Access
  Bypass, because native phone apps can't complete an Access login. Every
  request there still needs an Authentik-issued token. `chat.` stays behind
  Access.
- **Alert senders never touch the internet.** Alertmanager posts through an
  in-cluster bridge; there is no public webhook at all.
- **Push notifications carry no message content.**
- **Network policy:** everything is denied unless allowed. Components talk to
  each other inside the namespace; the Gateway reaches only HAProxy, MAS and
  Element Web; only the database and the chart's setup jobs may reach the
  Kubernetes API; Synapse may reach the internet on 443 (push gateway) only.

## Gotchas

- **The chart renders Ingress objects that nothing uses.** This cluster has no
  Ingress controller; routing is the HTTPRoutes above. If an Ingress
  controller is ever enabled, those Ingresses would go live, so check them
  first.
- **The chart uses Helm hooks** (secret generation, config checks). Argo CD
  runs them on a normal sync, but **a selective sync (`--resource`) skips
  them**.
- **Adding a user:** bind them to the Matrix application in Authentik; their
  account appears on first login.
- **Bot accounts** (Hermes, the alert bridge) have no Authentik login. Create
  them with `mas-cli manage register-user` and issue a token with
  `mas-cli manage issue-compatibility-token` (run inside the MAS pod).
- **Upgrades:** read the ESS release notes; chart versions are calendar-based
  (`26.10.x`).
