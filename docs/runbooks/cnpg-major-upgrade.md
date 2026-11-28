# CNPG Postgres major upgrade (e.g. 18 → 19)

Upgrade a CloudNativePG cluster to a new PostgreSQL major version in place.
CNPG (1.26+) does it when `imageName` asks for a higher major: it stops the
cluster, runs `pg_upgrade` in a Job against the primary's volume, starts the
primary on the new major, and builds the replicas again from scratch.
**Piloted on kea-db, 18.7 → 19.0, 2026-11-21**; also used for prowlarr-db,
radarr-db and sonarr-db, 17.12 → 18.7, 2026-11-28 (both at the bottom).

Related: [`cnpg-point-in-time-restore.md`](cnpg-point-in-time-restore.md),
[`cnpg-barman-cloud`](../../kubernetes/platform/databases/cnpg-barman-cloud/README.md),
CNPG docs: [PostgreSQL upgrades](https://cloudnative-pg.io/docs/1.30/postgres_upgrades).

| | |
|---|---|
| Downtime | ~3.5 min on kea-db (11 MB): 3 min shutdown wait + ~40 s `pg_upgrade`. With the app stopped first (step 3) the primary is back in ~1.5 min (Servarr clusters, 2026-11-28) |
| Total until 2/2 ready | 2.5–5 min (replica rebuilt from scratch afterwards; it grows with database size) |
| Rollback | Before the new major starts: revert `imageName`. After: restore the pre-upgrade backup into a new cluster on the old major |
| Point-in-time recovery | **Never across the upgrade.** Backups from before can only restore to before |

## Why the backup path must change

`pg_upgrade` gives the database a **new system identifier**. The Barman
Cloud plugin refuses to archive a different system into a path that already
holds one, so WAL archiving (and with it the replica rebuild and every
backup) would stop. Move the archive to a new, empty path **in the same
commit** as `imageName`.

Keep it under the cluster's existing prefix, `s3://cnpg/<cluster>/`: the
cluster's RustFS key (made by `restructure-tools/rustfs-cnpg-provision.sh`)
can only write there, so a new top-level name would need a new policy. The
layout used here:

| | ObjectStore | destinationPath | serverName | Holds |
|---|---|---|---|---|
| Before | `<cluster>-backup` | `s3://cnpg/` | `<cluster>` | old-major history (`s3://cnpg/<cluster>/base`, `wals`) |
| After | `<cluster>-backup-pg<N>` (new file) | `s3://cnpg/<cluster>/` | `pg<N>` | new major (`s3://cnpg/<cluster>/pg<N>/`) |

The old store stays (comment it as history). Its `retentionPolicy` no longer
prunes anything once no cluster archives to it; delete old backups by hand
when they're no longer wanted.

## 1. Before: check the app and the database

- **The app supports the new major.** Check its docs or release notes.
  Extensions must exist for the new major in the image (VectorChord, for
  example, ships per-major images). Kea only uses `plpgsql`.
- **Prefer x.1 or later** for databases that matter. The pilot used 19.0
  because Kea isn't in use yet.
- **CNPG image exists:** `ghcr.io/cloudnative-pg/postgresql:<N>.<m>-system-trixie`.
- Cluster healthy, archiving working:

  ```bash
  kubectl -n <ns> get cluster <cluster> -o jsonpath='{.status.phase}{"\n"}{range .status.conditions[*]}{.type}={.status}{"\n"}{end}'
  kubectl -n <ns> exec <primary> -c postgres -- psql -U postgres -Atc 'select version()'
  kubectl -n <ns> exec <primary> -c postgres -- psql -U postgres -d <db> -Atc 'select extname, extversion from pg_extension'
  ```

- If the cluster runs 17.0–17.5: upgrade to 17.6+ first (CNPG docs: slot
  bug), or set `max_slot_wal_keep_size: -1` for the upgrade.

## 2. Take a pre-upgrade base backup

The rollback point. Recovery from it lands on the **old** major.

```yaml
apiVersion: postgresql.cnpg.io/v1
kind: Backup
metadata:
  name: <cluster>-pre-pg<N>
  namespace: <ns>
spec:
  cluster:
    name: <cluster>
  method: plugin
  pluginConfiguration:
    name: barman-cloud.cloudnative-pg.io
```

`kubectl create -f` it and wait for `phase: completed` (`kubectl -n <ns> get
backups.postgresql.cnpg.io`; always the full name, it collides with
Longhorn's `backups`).

## 3. Optional: shorten the downtime

- **Stop the app first** (scale it to 0 through Git). CNPG's shutdown tries a
  smart shutdown and waits up to `smartShutdownTimeout` (180 s) for clients
  to disconnect; on kea-db that was the whole first 3 minutes.
- **Pre-pull the new image** on the primary's node (`talosctl -n <node> image
  pull ghcr.io/cloudnative-pg/postgresql:<tag>`): the pull was 20 s of the
  pilot's downtime, more for bigger images.

## 4. Commit the upgrade (one commit)

In the cluster's folder:

1. `database.yaml` / `cluster-*.yaml`: `imageName` → the new major's image.
2. Same file, `plugins[0].parameters`: `barmanObjectName: <cluster>-backup-pg<N>`,
   `serverName: pg<N>`.
3. New `objectstore-<cluster>-pg<N>.yaml`: a copy of the old ObjectStore with
   the new name and `destinationPath: s3://cnpg/<cluster>/`. Add it to
   `kustomization.yaml`.
4. Old ObjectStore: header comment saying it's the old-major history.

Renovate never offers Postgres majors (the CNPG rule in `renovate.json`), so
this is always a manual change. Minor updates of both majors keep coming in
the grouped PR afterwards.

Push, then sync the app and watch:

```bash
kubectl -n <ns> get cluster <cluster> -w     # phase: Upgrading Postgres major version -> healthy
kubectl -n <ns> get pods -l cnpg.io/cluster=<cluster> -w
```

Expect, in order: both instances stop → a `<primary>-major-upgrade` Job pod
(an early `Multi-Attach error` event for a few seconds is normal while the
volume moves) → primary starts on the new major → `<cluster>-<n>-join` Job →
a new replica with a **new PVC** (the old replica's volume is deleted, not
upgraded) → `Cluster in healthy state`.

**If the upgrade Job fails:** revert `imageName` (and the plugin parameters)
in Git and sync. CNPG deletes the failed Job and starts the old major again.

## 5. After

1. **Base backup on the new major**, at once (same YAML as step 2, named
   `<cluster>-post-pg<N>`). Then check the new store has a recovery window:
   `kubectl -n <ns> get objectstores.barmancloud.cnpg.io <cluster>-backup-pg<N> -o jsonpath='{.status.serverRecoveryWindow}'`.
2. **Statistics:** `pg_upgrade` doesn't carry planner statistics over.
   `kubectl -n <ns> exec <primary> -c postgres -- vacuumdb -U postgres --all --analyze-only`
3. **Checks:** `select version()`; conditions all True (`ContinuousArchiving`
   especially); `pg_stat_replication` shows the replica streaming; managed
   roles and grants still work; the app reconnected and its logs are clean.
4. Scale the app back up if you stopped it.
5. The daily `ScheduledBackup` needs no change: it follows the cluster's
   plugin configuration.

## Pilot: kea-db, 18.7 → 19.0 (2026-11-21)

11 MB, 2 instances, only `plpgsql`, Kea 3.2.1 connected. Commit `882d6393`.

| UTC | |
|---|---|
| 08:29:05–08:29:13 | Pre-upgrade backup `kea-db-pre-pg19` (8 s) |
| 08:30:31 | Sync; both instances told to stop |
| 08:33:33 | Shutdown done (180 s smart-shutdown wait: Kea held its connection); upgrade Job created; Multi-Attach for 13 s |
| 08:33:55–08:34:15 | Pulling the 19.0 image (20 s) |
| 08:34:15–08:34:57 | `pg_upgrade` (42 s) |
| 08:35:05 | Primary up on 19.0 |
| 08:35:09–08:36:40 | New replica: new PVC, join Job, streaming |
| 08:36:40 | `Cluster in healthy state`, 2/2 |
| 08:37:08–08:37:16 | Post-upgrade backup `kea-db-post-pg19`, in `s3://cnpg/kea-db/pg19/` |

Results: `PostgreSQL 19.0`; Kea schema 34.0 untouched; `grafana_ro` grants
intact (the PostSync grants Job re-ran fine); Kea restarted once while the
database was down and reconnected on its own, no errors since; archiving
`True` into the new store.

## Servarr clusters: prowlarr-db, radarr-db, sonarr-db, 17.12 → 18.7 (2026-11-28)

They went onto Postgres 17 for the SQLite → Postgres migration (the Servarr
wiki documents that only for Postgres < 18) and were moved to 18 the same
day. Each holds two databases (`<app>-main`, `<app>-log`); `pg_upgrade`
moves both at once. Only `plpgsql` installed. Done one at a time, each with
the app stopped through Git first (step 3) and the 18.7 image pre-pulled.

| Cluster | Size | Sync → `pg_upgrade` done | Primary up | 2/2 healthy |
|---|---|---|---|---|
| prowlarr-db | 44 MB | 79 s | 118 s | 197 s |
| radarr-db | 26 MB | 79 s | 96 s | 174 s |
| sonarr-db | 63 MB | 69 s | 81 s | 142 s |

No smart-shutdown wait this time (the app was already stopped), so the
first ~12 s is just CNPG stopping the instances; `pg_upgrade` itself took
~40 s each. Pre and post backups (`<app>-db-pre-pg18`, `-post-pg18`) took
seconds; the new store is `s3://cnpg/<app>-db/pg18/`. After: `vacuumdb
--all --analyze-only`, both databases still owned by the app user, replica
streaming as the quorum member, each app reported `Postgres 18.7` and wrote
new rows within minutes.

Events seen and harmless: a `FailedAttachVolume ... waiting for the volume
to fully detach` retry while the primary's volume moved to the upgrade Job,
and Kyverno audit `PolicyViolation` events for the Barman sidecar.
