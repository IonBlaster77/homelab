# Longhorn

The cluster's storage. Every PersistentVolume is a Longhorn volume: a block
device kept as **3 replicas on 3 different nodes**, so a node can die
without losing data. Longhorn also backs every volume up to the NAS on a
schedule, and serves the Kubernetes snapshot API.

| | |
|---|---|
| **URL** | Longhorn UI on **10.77.20.51** (LAN LoadBalancer) and https://longhorn.jupitertech.net (via the Gateway) |
| **Chart** | [`longhorn`](https://github.com/longhorn/charts) from `charts.longhorn.io`, version pinned in `app.yaml` |
| **Namespace** | `longhorn-system` (PSA `privileged`, set by `managedNamespaceMetadata`) |
| **Storage** | It *is* the storage: two disk pools per node, `ssd` (`/var/lib/longhorn`, ~200 GB) and `nvme` (`/var/lib/longhorn-nvme`, ~246 GB) |
| **Backups** | NAS `nfs://10.77.20.20:/volume1/longhorn-backups`: hourly (keep 24) and daily at 02:00 Adelaide (keep 30) |
| **Depends on** | Talos node disk annotations, the NAS (backups) |

## Files

| File | What it is |
|---|---|
| `app.yaml` | Argo CD Application with two sources: the chart, and this folder. Not Server-Side Apply; has `ignoreDifferences` |
| `values.yaml` | 3 replicas, control-plane tolerations, node-down pod deletion, disk pools from node labels, UI LoadBalancer IP, metrics |
| `kustomization.yaml` | Lists this folder's own manifests |
| `setting-backup-target.yaml` | Longhorn `Setting`s: the NAS backup target (no credentials for NFS) |
| `recurringjob.yaml` | `hourly-backup` and `daily-backup`, both for the `default` group |
| `storageclass-ssd.yaml` | `longhorn-ssd`, the **cluster default** class (SSD pool) |
| `storageclass-nvme.yaml` | `longhorn-nvme`, opt-in fast class (NVMe pool) for databases |
| `volumesnapshotclass.yaml` | `longhorn-backup-vsc`: CSI snapshots that become NAS backups (`type: bak`) |
| `*-volume-labeler.yaml`, `job-enable-recurring-jobs.yaml` | PostSync hook that labels **every** volume into the `default` backup group |
| `httproute.yaml`, `referencegrant.yaml` | `longhorn.jupitertech.net` → the UI (route lives in the `networking` namespace) |

## How a volume gets backed up

1. An app's PVC creates a Longhorn volume.
2. On the next Argo sync of this app, the hook labels it
   `recurring-job-group.longhorn.io/default=enabled`.
3. The two RecurringJobs back up every volume in that group to the NAS.

So a brand-new volume isn't backed up until this app syncs once. Check
nothing is missing:
`kubectl get volumes.longhorn.io -n longhorn-system -L recurring-job-group.longhorn.io/default`.

## Gotchas

- **The chart ships Longhorn's CRDs** (volumes, backups, settings…) and the
  app has `prune: true`. Losing those CRDs would remove every volume and
  backup record. Check the rendered CRD list on any chart upgrade.
- **Deleting this Application runs Longhorn's uninstaller first.** The chart's
  `pre-delete` hook (`longhorn-uninstall`) becomes an Argo CD PreDelete hook,
  so the Application carries `pre-delete-finalizer.argocd.argoproj.io`: if the
  Application is ever deleted, or pruned by the root app because this folder
  disappeared, Argo CD runs the uninstall Job before removing it.
- **`deleting-confirmation-flag` must stay `false`.** While it is, that
  uninstall Job refuses to remove Longhorn. It is the only thing standing
  between an accidental Application deletion and every volume in the
  cluster. Never set it to `true` unless you really mean to uninstall.
- **Backup crons are UTC.** The daily job's comment explains why 02:00
  Adelaide is `30 16 * * *`, and why it must never share a minute with the
  hourly job (a per-volume lock makes the second one fail).
- **`reclaimPolicy: Delete` on all classes.** Deleting a PVC deletes its
  volume. The NAS backups are the safety net.
- **The SSD pool shares `sda4` with Talos** (40 GB reserved for container
  images and logs); keep an eye on it.
- **`ignoreDifferences`** hides fields that Longhorn and Kubernetes fill in
  (CRD webhook caBundles, Service nodePorts), which would otherwise show as
  permanently OutOfSync.
- **Upgrades:** one minor version at a time, and read the upgrade notes;
  engine upgrades for existing volumes are a separate step.
