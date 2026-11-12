# Forgejo: self-hosted forge and source of truth

**Status:** design agreed 2026-11-12. Step 1 of the cutover plan (deploy
Forgejo, LAN-only, to play with) is in
[`kubernetes/platform/system/forgejo/`](../../kubernetes/platform/system/forgejo/README.md).
GitHub is still the source of truth. Tracked as task **#51** in the homelab
task list.

## Goal

Run Forgejo in the cluster as the source of truth for this repo and for
private repos. Use it to:

- Hold the issue and task list that people and agents work from.
- Run pull-request checks with Forgejo Actions.

Argo CD syncs from Forgejo day to day. GitHub keeps a mirror of this repo for
the public portfolio, and it is also the break-glass source when Forgejo is
down.

Related: [agent observability](agent-observability.md),
[vulnerability scanning](vulnerability-scanning.md) (Kyverno and Tetragon are
on its roadmap), [`kubernetes/platform/system/argo-workflows/`](../../kubernetes/platform/system/argo-workflows/README.md).

## Decisions

### Source of truth and the GitHub mirror

| Decision | Choice |
|---|---|
| Source of truth | Forgejo. Argo CD syncs from it day to day |
| Mirrored to GitHub | **Only `homelab`**. Private repos live on Forgejo only. An off-site backup for private repos is deferred |
| How mirroring works | A Forgejo Actions job on push to `main`, after secret-scan passes, pushes `main` to GitHub **without force**. Not Forgejo's built-in push mirror, which may push every branch and can force-push |
| GitHub `main` | Force-push protection on (set in the GitHub UI), so a diverged push fails instead of overwriting commits |
| GitHub repo | Description and README say it's a mirror; Issues off. GitHub Actions keep running on mirror pushes as a second check and a public CI badge |
| Renovate on GitHub | Turned off at the flip. Otherwise it opens PRs on the mirror |
| Secret scanning | Required check on `main` in Forgejo, same `scripts/scan-secrets.sh` as today |
| `homelab` visibility on Forgejo | Public, as on GitHub. Can change later (then Argo needs a read token) |

### Break-glass: switching Argo CD between Forgejo and GitHub

One script, `forge-switch.sh`, with `to-github`, `to-forgejo` and `status`.
Both directions must work the same way every time and be safe to re-run. It
runs from WSL with kubectl and depends on neither Forgejo nor Authentik. Both
repo connections stay registered in Argo permanently. Only `repoURL`s change.

**`to-github`** (Forgejo is down):
1. Check that GitHub `main` matches the revision Argo last synced.
2. Patch `bootstrap-apps`: `repoURL` to GitHub, automated sync off. With sync
   on, it would re-apply the child Applications from the mirror, which still
   name Forgejo.
3. Rewrite every child Application's Forgejo `repoURL` to GitHub. A `jq` pass
   covers both `source` and `sources[]`.
4. Mark the mode with an annotation on `bootstrap-apps`. Hard-refresh the apps
   and check that each resolves from GitHub.

**`to-forgejo`** (Forgejo is back):
1. Check that Forgejo is healthy.
2. Fast-forward any commits made on GitHub during the outage into Forgejo.
   Stop if the two have diverged.
3. Restore `bootstrap-apps` (Forgejo URL, automated sync on). Its selfHeal
   re-applies every child Application from git, which undoes step 3 of
   `to-github`.
4. Check that the apps resolve from Forgejo, then resume the mirror job.

**During a break-glass** only the owner makes changes, through PRs on GitHub,
where CI still runs. Agents and Renovate are paused until `to-forgejo`.

**Cluster rebuild** uses the same path: bootstrap from GitHub, restore Forgejo
from backup, run `to-forgejo`.

**Drill** once a quarter and before planned Forgejo maintenance. Alert in the
Matrix alerts room when the cluster is in GitHub mode, or when GitHub `main`
lags Forgejo `main` by more than an hour.

This is a deliberate, documented exception to "never edit live Application
specs".

### Addresses and exposure

| | |
|---|---|
| Hostname | `forge.jupitertech.net` |
| Argo CD | Uses the in-cluster Service URL, so a cold boot doesn't depend on DNS, the Gateway or certificates |
| People and agents | Use `forge.jupitertech.net` for the web UI, clones and the API |
| Web UI from outside | Cloudflare tunnel + Access, then Authentik with 2FA |
| Git over SSH | LAN only, Forgejo's built-in SSH server on its own Cilium load-balancer IP, host keys in SOPS |
| API for agents | LAN or in-cluster address (Access would block API calls through the tunnel) |

### Identity and access

- **People** log in only through Authentik OIDC. Self-registration and
  password login for Authentik users are off. Authentik groups map to
  Forgejo teams (`forgejo-admins` maps to `admins`).
- **Break-glass admin:** one local Forgejo admin for when Authentik is down,
  password in SOPS. The only account that can bypass branch protection.
- **Agents** each get a machine user (Forgejo's equivalent of a service
  principal): a normal account nobody logs into, using an access token and an
  SSH key. One account per agent type, e.g. `claude-code-desktop`, `hermes`,
  `pi`, `renovate`. Created and rotated (every 90 days) by a script, with
  tokens in SOPS.
- Token scopes are per category, not per repo, so **team membership is what
  limits an agent to particular repos**.
- **One org, `homelab`.** Teams are `admins`, `agents-write`, `agents-read`
  and `pr-approvers`.
- **Agent rights:** read repos, open PRs, comment on and update issues. No
  merging, no settings, no pushes to `main`.

### Branch protection and approvals on `main`

- Everything goes through a PR and CI. **Nobody bypasses protection,
  including the owner.** The break-glass admin is the only exception.
- Required checks are secret-scan and manifest-checks.
- Only approvals from `pr-approvers` count. To begin with that's the owner
  plus **only the Claude Code desktop instance** (`claude-code-desktop`).
- Approvals are dismissed when new commits are pushed. Merge is blocked when
  changes are requested. Authors can't approve their own PRs, so **Claude
  Code's own PRs need the owner's approval**.
- **Sensitive paths need the owner's approval.** A CI check fails until the
  owner has approved any PR touching them:
  - argocd, cilium, `talos/`, `bootstrap/`
  - `.github/workflows/`, `renovate.json`, `scripts/ci/`
  - SOPS files
  - security policies

  It's a CI check rather than CODEOWNERS because we haven't verified that
  Forgejo enforces code-owner approval.
- **Renovate major version bumps need the owner's approval.** Minor and patch
  bumps can be approved by Claude Code.
- **An approved PR with green checks merges itself** ("merge when checks
  succeed"). argocd and cilium never merge themselves: they're sensitive
  paths and manual-sync.
- **Commit signing:** the owner's commits and Forgejo's merge commits are
  signed with SSH keys. Agents don't sign, and signed commits are not
  required. Agent signatures would show as Unverified on the GitHub mirror.

### After a merge

An Argo Workflow runs on each push to `main`:
1. Works out which apps the commit changed.
2. Waits for each one to sync and become Healthy.
3. Posts the result on the PR and in the Matrix alerts room.

On failure it **opens a revert PR but never merges it**. Sometimes the right
move is to fix forward.

### Issues and tasks

- Issues are assigned to agents **manually by the owner** to begin with.
  Agents work only on issues assigned to their account. A dispatcher can come
  later. The labels below are designed so one can be added without a reorg.
- Labels: `status/*`, `area/*`, `agent-ok`, `needs-human`. Issue templates
  give agents structured input.
- The task list moves here from the Claude Code memory file.

### Data and operations

| | |
|---|---|
| Release track | Latest stable (about quarterly upgrades, raised by Renovate) |
| Database | CNPG Postgres with point-in-time recovery to RustFS |
| Repo storage | Longhorn RWO volume, one replica, `maxSurge: 0` |
| Attachments, LFS | RustFS S3 |
| Cache, sessions, queues | Forgejo's built-ins while there's one replica. Move to the shared Redis when going to two: no data migration needed |
| Search indexer | The database |
| Backups | CNPG + Longhorn backups are required. Issues and PRs (the task list) exist only in the database, which the GitHub mirror doesn't cover |
| Package registry | Off. Harbor is the registry |
| Notifications | Matrix webhooks, no email |

**HA:** one replica to start, but every choice above is what two replicas
would need, so going to two is a config change. Two replicas would need a
Longhorn RWX volume, and that is served by a single share-manager pod, so
it's still not fully HA. A Forgejo outage stops Argo syncing but doesn't
affect running workloads. Long outages are what the break-glass is for.

### CI and builds

- **Forgejo Actions** runs the fast checks: lint, render diff, kubeconform,
  the vendored-chart check, secret-scan. The workflows stay in
  `.github/workflows/`, so the same files run on Forgejo and on the GitHub
  mirror.
- **Runner:** in the cluster, rootless, no Docker-in-Docker, no cluster
  credentials, egress restricted.
- **Image builds stay in Argo Workflows** (`build-image`, rootless BuildKit).
  An Action submits it on merge. Argo Workflows also runs ops jobs and agent
  runs.

## Cutover plan

Move one app at a time, lowest risk first. Argo can sync different apps from
different repos at once, so each move is a one-line `repoURL` change in that
app's `app.yaml`, and moving back is the same change.

1. **Deploy Forgejo** (LAN-only), Authentik login, org, teams, machine users.
2. **Forgejo pull-mirrors GitHub.** GitHub stays where commits go.
3. **Move apps over, lowest risk first.** For example homepage, searxng and
   pgadmin, then media, then AI apps, then databases and platform. Last are
   `bootstrap-apps`, then argocd and cilium.
4. **The flip:**
   1. Delete the pull mirror and do a full GitHub migration (code, all ~480
      PRs, issues, labels, milestones) **at the same path**, so the URL
      doesn't change. Apps already moved just fail to fetch for a few
      minutes.
   2. Turn on the mirror job and GitHub force-push protection.
   3. Turn off Renovate on GitHub and start the self-hosted Renovate against
      Forgejo.
5. **Repoint everything else:**
   - the default `repo` in the `build-image` template
   - local remotes and deploy keys
   - the read-only wrappers and PR scripts
   - Homepage links, AdGuard rewrite, HTTPRoute, Cloudflare Access app
6. **First drill** of `forge-switch.sh` in both directions.

## Verify before writing manifests

- Current Forgejo stable version and chart (`code.forgejo.org/forgejo-helm`).
- Whether Renovate supports Forgejo directly, or only through its Gitea
  platform.
- Whether a pull-mirror repo can import issues and PRs. We assume it can't,
  which is why the flip re-migrates.
- Whether GitHub migration imports all PRs, reviews and comments, and how
  authors appear.
- Branch protection: approvals allowlist, dismissing stale approvals,
  blocking merge on requested changes, whether admins are covered, and
  whether code-owner approval can be required.
- That "merge when checks succeed" works with required approvals.
- That Argo handles the `to-github` patching and the selfHeal revert as
  expected. The first drill tests this.
- Forgejo's OIDC group-claim to team mapping with Authentik.
