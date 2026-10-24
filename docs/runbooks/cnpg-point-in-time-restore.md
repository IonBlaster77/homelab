# CNPG Point-in-Time Restore

Restore a CNPG database to any moment inside its recovery window, from the
WAL archive and base backups the Barman Cloud plugin keeps in RustFS
(`s3://cnpg/<cluster>/`). **Tested end to end on grafana-db, 2026-10-24**
(results at the bottom).

Related: [`cnpg-barman-cloud`](../../kubernetes/platform/databases/cnpg-barman-cloud/README.md),
[`rustfs`](../../kubernetes/platform/storage/rustfs/README.md),
[agent-observability plan](../projects/agent-observability.md) (task #50).

| | |
|---|---|
| Recovery window | Last 14 days (`retentionPolicy: 14d`), from the first base backup |
| Granularity | Any committed transaction. WAL leaves the pod at least every 5 min (`archive_timeout`), so the newest few minutes may not be restorable yet |
| Time taken | ~1 min for a small database (grafana-db: 9 s base backup, ~1 min restore) |

**Always restore into a new cluster first**, in a scratch namespace, and
check the data. Only then decide whether to swap the app over. Never point a
restored cluster's WAL archiver at the original prefix: two clusters writing
one `serverName` corrupts the archive.

---

## 1. Check there is something to restore to

```bash
C=grafana-db NS=monitoring
kubectl get objectstores.barmancloud.cnpg.io $C-backup -n $NS -o jsonpath='{.status}{"\n"}'
# {"serverRecoveryWindow":{"grafana-db":{"firstRecoverabilityPoint":"...","lastSuccessfulBackupTime":"..."}}}
kubectl get backups.postgresql.cnpg.io -n $NS   # full name: "backups" alone hits Longhorn's
```

The target time must be after `firstRecoverabilityPoint`. **WAL past the
target must already be archived**, or recovery runs out of WAL before
reaching it and fails. Check on the primary that `last_archived_time` in
`pg_stat_archiver` is later than the target, or wait 5 minutes.

## 2. Scratch namespace, credentials, network

```bash
kubectl create namespace pitr-test
kubectl label namespace pitr-test pod-security.kubernetes.io/enforce=restricted
# copy the cluster's backup key (read access to its prefix is all it needs)
kubectl get secret $C-backup-s3 -n $NS -o json \
  | sed -e "s/\"namespace\": \"$NS\"/\"namespace\": \"pitr-test\"/" \
        -e '/"resourceVersion"/d' -e '/"uid"/d' -e '/"creationTimestamp"/d' -e '/argocd.argoproj.io/d' \
  | kubectl create -f -
```

RustFS is default-deny, so admit the scratch namespace **temporarily** (not in
git, delete in step 5):

```yaml
apiVersion: cilium.io/v2
kind: CiliumNetworkPolicy
metadata:
  name: rustfs-allow-ingress-from-pitr-test
  namespace: rustfs
spec:
  endpointSelector:
    matchLabels:
      app: rustfs
  ingress:
    - fromEndpoints:
        - matchLabels:
            io.kubernetes.pod.namespace: pitr-test
      toPorts:
        - ports:
            - port: "9000"
              protocol: TCP
```

## 3. ObjectStore and recovery cluster

Copy the source's `ObjectStore` into `pitr-test` with the same name and spec
(drop `retentionPolicy`). Then:

```yaml
apiVersion: postgresql.cnpg.io/v1
kind: Cluster
metadata:
  name: grafana-db-pitr
  namespace: pitr-test
spec:
  instances: 1
  # Same major version as the source (kubectl get cluster ... -o jsonpath='{.status.image}')
  imageName: ghcr.io/cloudnative-pg/postgresql:18.3-system-trixie
  storage:
    storageClass: longhorn-ssd
    size: 5Gi
  bootstrap:
    recovery:
      source: origin
      recoveryTarget:
        targetTime: "2026-10-24 10:06:47.93319+00"   # leave out for "as late as possible"
  # Read-only source. NO `plugins:` WAL archiver on this cluster.
  externalClusters:
    - name: origin
      plugin:
        name: barman-cloud.cloudnative-pg.io
        parameters:
          barmanObjectName: grafana-db-backup
          serverName: grafana-db
```

Wait for `kubectl get cluster.postgresql.cnpg.io -n pitr-test` to show
`Cluster in healthy state`. The restored primary is on a **new timeline**
(source +1). That's how Postgres marks the branch.

## 4. Check the data

Compare something that changes over time against what you expect at the
target. Read-only, e.g.:

```bash
kubectl exec -n pitr-test grafana-db-pitr-1 -c postgres -- psql -d grafana -AtXc \
  "select operation_uid, last_execution from server_lock order by 1"
kubectl exec -n pitr-test grafana-db-pitr-1 -c postgres -- psql -AtXc \
  "select pg_is_in_recovery(), timeline_id from pg_control_checkpoint()"
```

To actually use the data, `pg_dump` the needed tables from the restored
cluster into the live one. To replace the live database entirely, plan it as
its own change: point the app at a new cluster bootstrapped like this, wired
into git, with its own `serverName` for archiving.

## 5. Clean up

```bash
kubectl delete cluster.postgresql.cnpg.io grafana-db-pitr -n pitr-test
kubectl delete namespace pitr-test
kubectl delete ciliumnetworkpolicy rustfs-allow-ingress-from-pitr-test -n rustfs
```

---

## After losing the whole cluster

The WAL archive lives in RustFS, inside the cluster, so first bring RustFS back:

1. Rebuild the cluster ([bootstrap](bootstrap.md)) and let Argo CD deploy
   Longhorn and the `rustfs` app.
2. **Before RustFS starts writing**, restore its `rustfs-data` volume from the
   NAS backup in the Longhorn UI (Backups → the RustFS volume → restore), and
   bind the PVC to it. The latest hourly backup is at most an hour old.
3. Start RustFS, then restore each database as above. Recovery reaches the end
   of the WAL in that backup, so expect to lose up to an hour.

This path is documented but **not yet rehearsed**.

## Test record

**2026-10-24, grafana-db**, first run, while setting this up:

- On-demand base backup: completed in 9 s (WAL `…D30000004C`); recovery window opened 10:06:15Z.
- Target T1 = 10:06:47.93Z, when Grafana's `server_lock.dashboard-cleanup` = `1792836379` (10:06:19). It runs every minute, so the live value had moved on to 10:20:49 by restore time.
- Restored value: **`1792836379`**. All 5 lock rows were identical to T1, 86/86 tables, users matched, timeline 8 (source 7). Restore took ~1 min.
- Gotcha hit: the first restore attempt had to wait for the WAL segment containing T1 to be archived (up to 5 min).
