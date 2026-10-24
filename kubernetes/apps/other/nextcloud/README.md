# Nextcloud

File storage for the household: OneDrive-style folder sync on desktops and
phones, and share links (download, or upload-only "File drop") for people
without an account.

| | |
|---|---|
| **URL** | https://cloud.jupitertech.net. **LAN-only for now**: AdGuard rewrite, no Cloudflare record (see "Going public") |
| **Chart** | [`nextcloud`](https://github.com/nextcloud/helm) from `nextcloud.github.io/helm`, version pinned in `kustomization.yaml` (`helmCharts`) |
| **Image** | `nextcloud:<appVersion>-fpm-alpine` behind `nginxinc/nginx-unprivileged` |
| **Namespace** | `nextcloud` (PSA `restricted`) |
| **Storage** | Files: 20Gi `longhorn-nvme-double` (`nextcloud-nextcloud-data`). App/config: 5Gi `longhorn-nvme-double` (`nextcloud-nextcloud`). Both two replicas, NAS-backed-up |
| **Database** | CloudNativePG `nextcloud-db` (2 × 5Gi NVMe), database `nextcloud` |
| **Redis** | Its own single pod, `nextcloud-redis` (no volume). Not the shared Sentinel Redis: Nextcloud can't use Sentinel |
| **Depends on** | CloudNativePG, Longhorn (`longhorn-nvme-double`), Gateway, AdGuard (DNS), the sops-kustomize plugin with `--enable-helm`; Authentik for sign-in |

## Files

| File | What it is |
|---|---|
| `app.yaml` | Argo CD Application: this folder through the sops-kustomize plugin. Server-Side Apply |
| `kustomization.yaml` | Renders the chart (`helmCharts`, values `values.yaml`) plus the manifests below |
| `values.yaml` | Chart values: image, security contexts, config.php additions, hooks, database, Redis, storage, CronJob |
| `secret-nextcloud-admin.sops.yaml` | `nextcloud-admin`: the break-glass local admin (`admin` + password) |
| `secret-nextcloud-redis.sops.yaml` | `nextcloud-redis`: the Redis password (server and Nextcloud) |
| `cluster-nextcloud-db.yaml` | CloudNativePG cluster `nextcloud-db` (connection details generated into `nextcloud-db-app`) |
| `deployment-redis.yaml`, `service-redis.yaml` | The in-namespace Redis |
| `httproute.yaml`, `referencegrant.yaml` | `cloud.jupitertech.net` → the `nextcloud` Service (nginx, 8080) |
| `networkpolicy.yaml` | Default-deny; see below |
| `namespace.yaml` | Namespace with Pod Security `restricted` |

## How it runs

- **One pod, two containers**: nginx (static files, 8080) in front of
  PHP-FPM (Nextcloud, 127.0.0.1:9000), as uid 82 (`www-data` in the Alpine
  image) with `fsGroup: 82`. No root anywhere, so PSA `restricted` holds.
- **Background jobs**: a Kubernetes CronJob runs `cron.php` every 5 minutes.
  It mounts the same ReadWriteOnce volumes, so required pod affinity puts it
  on the Nextcloud pod's node.
- **Config from git**: `values.yaml` `nextcloud.configs` becomes
  `config/homelab.config.php` (proxies, https links, maintenance window).
  The chart's `before-starting` hook (every start, idempotent) sets the
  rest: cron mode, user_oidc / files_external / twofactor_totp installed
  and enabled, and the share-link defaults. Not `post-installation`: that
  only runs if the install step finishes cleanly, and the first install
  here didn't (the data-directory check below).
- **Data directory permissions check is off**
  (`check_data_directory_permissions`): Nextcloud wants 0770, but kubelet
  creates the `data` subPath as root with the fsGroup mode 2775, which uid
  82 can't change, and the failed check makes every request return 503.
- **Real client IPs**: Nextcloud trusts the pod range and reads
  `X-Forwarded-For`; the brute-force protection depends on it. The pod
  range is Cilium's default cluster pool (`10.0.N.0/24` per node, see
  `kubectl get ciliumnodes`), **not** the `10.244.0.0/16` in the Talos
  config. Trusted: `10.0.0.0/16`, never the whole `10.0.0.0/8`, which
  contains the LAN. To check: the nginx container's access log shows the
  Envoy address first and the client's address last (in quotes).

## Network policy

Default-deny. Everything in the namespace talks freely; the Gateway reaches
only nginx on 8080; the Nextcloud pods may reach the LAN's 10.77.20.0/24
(Gateway replies, Authentik via the Gateway VIP; not the API VIP) and public
addresses on 443/80 (app store, update checks); CloudNativePG gets operator
and API access.

## Setup after the first sync

1. **Sign in as the break-glass admin** (user `admin`, password
   `nextcloud-password` in `secret-nextcloud-admin.sops.yaml`; `sops -d` it
   yourself) and turn on TOTP for it (Personal settings → Security).
2. **Authentik** (done 2026-10-24): application slug **`next-cloud`**,
   OAuth2/OpenID provider, confidential, strict redirect URI
   `https://cloud.jupitertech.net/apps/user_oidc/code`, signing key set
   (RS256), subject = username, access bound to a group. Registered in
   Nextcloud as provider `authentik`:
   `occ user_oidc:provider authentik --clientid=... --clientsecret=...
   --discoveryuri=https://auth.jupitertech.net/application/o/next-cloud/.well-known/openid-configuration
   --scope="openid email profile" --unique-uid=0 --mapping-uid=preferred_username
   --mapping-display-name=name --mapping-email=email`
   (run in the pod: `kubectl exec -n nextcloud deploy/nextcloud -c nextcloud -- php occ ...`).
   The client secret lives in Nextcloud's database, not git: on a rebuild,
   run this again with the secret from Authentik.
3. **Authentik is the only sign-in**: `allow_multiple_user_backends=0`,
   set by the `before-starting` hook whenever a provider is registered.
   The login page goes straight to Authentik; the local admin signs in at
   `/login?direct=1` (password + TOTP).

## Going public

Only while "Authentik is the only sign-in" above holds (it does since
2026-10-24):

1. Cloudflare DNS: `cloud` CNAME to the tunnel (the tunnel's wildcard rule
   already sends `*.jupitertech.net` to the Gateway).
2. Cloudflare Access: a **Bypass** application for `cloud.jupitertech.net`
   only. This is a deliberate exception to "everything behind Access": the
   desktop/phone clients sync over WebDAV and can't answer an Access login.
   The boundary is Nextcloud's own sign-in, which is Authentik password +
   2FA; clients get per-device app passwords through Login Flow v2, which
   also goes through Authentik.
3. Through the tunnel, a single request is capped at 100 MB. The clients
   upload in chunks; a large browser upload through a File drop link may hit
   the cap.

## Still to do

- **NAS "Dump" folder**: a Synology NFS share mounted into the pod and
  added with files_external ("Local" backend), soft-mounted so a NAS outage
  only breaks that folder. Waits on the DSM share; not in this folder yet
  (a missing share would stop the whole pod starting).
- Metrics (nextcloud-exporter + ServiceMonitor) and point-in-time recovery
  for `nextcloud-db` (Barman Cloud to RustFS, as `grafana-db` does).

## Gotchas

- **Upgrades go one Nextcloud major at a time.** The image tag follows the
  chart's appVersion, so check a chart bump's appVersion before merging.
- **config.php's instance secrets live on the app volume** (`instanceid`,
  `passwordsalt`, `secret`), generated at install. They can't be
  regenerated without breaking sessions and encrypted data, which is why
  that volume has two replicas too. The volumes are also `Prune=false,
  Delete=false`: Argo never deletes them.
- **Don't edit `config.php` by hand for anything in `homelab.config.php`**:
  the ConfigMap file wins on every start.
- **Recreate strategy** (RWO volumes): every rollout has a short outage.
