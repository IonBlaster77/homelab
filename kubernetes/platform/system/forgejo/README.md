# Forgejo

The self-hosted git forge: repos, issues (the task list agents work from),
pull requests and Forgejo Actions. Design and every decision behind it:
[`docs/projects/forgejo.md`](../../../../docs/projects/forgejo.md) (task #51).

**Stage: deployed to play with.** GitHub is still the source of truth and
Argo CD still syncs from GitHub. Nothing points at Forgejo until the
per-app cutover in the design doc.

| | |
|---|---|
| **URL** | https://forge.jupitertech.net. **LAN-only for now**: AdGuard rewrite, no Cloudflare record |
| **Git over SSH** | `ssh://git@forge-ssh.jupitertech.net/<owner>/<repo>.git`, LAN only, LoadBalancer `10.77.20.66` |
| **Chart** | [`forgejo`](https://code.forgejo.org/forgejo-helm/forgejo-helm) from `oci://code.forgejo.org/forgejo-helm`, version in `kustomization.yaml` |
| **Image** | `code.forgejo.org/forgejo/forgejo:<tag>-rootless`, latest stable line (tag in `values.yaml`) |
| **Namespace** | `forgejo` (PSA `restricted`) |
| **Storage** | `forgejo-data` 20Gi `longhorn-nvme` (3 replicas): git repositories and Forgejo's own files. Everything else goes to S3 |
| **Depends on** | CloudNativePG, Longhorn, RustFS (bucket `forgejo` and `s3://cnpg/forgejo-db/`), Gateway, AdGuard (DNS), the sops-kustomize plugin with `--enable-helm`; Authentik for sign-in |

## Files

| File | What it is |
|---|---|
| `app.yaml` | Argo CD Application: this folder through the sops-kustomize plugin. Server-Side Apply |
| `kustomization.yaml` | Renders the chart (helmCharts) plus this folder's manifests |
| `values.yaml` | Chart values: image, security contexts, resources, the SSH LoadBalancer, the volume, `app.ini` |
| `secret-forgejo-admin.sops.yaml` | `forgejo-admin`: the break-glass local admin (`forge-admin` + password) |
| `secret-forgejo-s3.sops.yaml` | `forgejo-s3`: RustFS key for the `forgejo` bucket only. Made by `restructure-tools/rustfs-app-provision.sh` |
| `cluster-forgejo-db.yaml` | CNPG Postgres, 2 instances. CNPG generates `forgejo-db-app` |
| `objectstore-forgejo-db.yaml`, `scheduledbackup-forgejo-db.yaml`, `secret-forgejo-db-backup.sops.yaml` | Point-in-time recovery to `s3://cnpg/forgejo-db/`, daily base backup 16:20 UTC. Key made by `restructure-tools/rustfs-cnpg-provision.sh` |
| `podmonitor-forgejo-db.yaml` | CNPG metrics, so the CNPG alerts cover it |
| `httproute.yaml`, `referencegrant.yaml` | `forge.jupitertech.net` via the Gateway |
| `networkpolicy.yaml` | Default deny, plus DNS, Gateway in (3000), LAN SSH in (2222), RustFS, Authentik, HTTPS out to the internet, and the database's CNPG rules |

Also changed for Forgejo, outside this folder:

- AdGuard rewrites for `forge` (Gateway) and `forge-ssh` (`10.77.20.66`).
- Two RustFS ingress rules in `kubernetes/platform/storage/rustfs/networkpolicy.yaml`.

## How it runs

- **One replica**, `Recreate`, on an RWO volume. The other storage choices
  are what two replicas would need:
  - Postgres for the database.
  - S3 for every non-git storage type: attachments, LFS, avatars, Actions
    logs and artifacts.
  - The database as the issue indexer.

  Session, cache and queue use Forgejo's built-ins for now. Moving them to
  the shared Redis needs no data migration.
- **`app.ini` comes from `gitea.config`** in `values.yaml`. Secrets come
  from `FORGEJO__…` env vars, which win over it.
- **Sign-up:** only an external login source (Authentik) or the admin can
  create accounts. Until Authentik is configured, nobody can register.
- **Locked down:**
  - Migrations may only reach GitHub, never the LAN or the cluster.
  - The package registry is off (Harbor is the registry), mail is off and
    the update checker is off.

## Setup after the first sync

1. **Sign in as the break-glass admin** at
   `https://forge.jupitertech.net/user/login` (user `forge-admin`, password
   in `secret-forgejo-admin.sops.yaml`; `sops -d` it yourself). Turn on TOTP
   (Settings → Security). The password in git is re-applied on every
   restart, so rotating it is a commit.
2. **Take the first database base backup by hand** (see the
   cnpg-barman-cloud README).
3. **Authentik** (next PR):
   1. Create an OAuth2/OpenID provider and application, slug `forgejo`.
      Confidential client, strict redirect URI
      `https://forge.jupitertech.net/user/oauth2/authentik/callback`.
      Access bound to a group.
   2. Save its client ID and secret to `~/homelab/forgejo-oidc.env`.
   3. A follow-up PR encrypts them into `secret-forgejo-oidc.sops.yaml` and
      adds a `gitea.oauth` entry named `authentik`.

## Still to do

- Authentik sign-in, then go public behind Cloudflare Access.
- Prometheus metrics (a ServiceMonitor plus a scrape token).
- Org, teams and machine users; the mirror job; Forgejo Actions runner.
  These follow the design doc.

## Gotchas

- **The admin can't be called `admin`**: the chart refuses it.
- **Changing `image.tag`** moves Forgejo between release lines. Read that
  version's release notes first: downgrades are not supported.
- **The volume has `Prune=false`**, so removing it from the chart won't
  delete the repositories. Delete it by hand if you ever mean to.
