# VolumeSnapshot CRDs

The Kubernetes-standard snapshot API (`snapshot.storage.k8s.io`):
`VolumeSnapshot`, `VolumeSnapshotContent`, `VolumeSnapshotClass`, plus the
`groupsnapshot` variants. With these and
[the snapshot controller](../volumesnapshot-controller/), any app can say
"snapshot this PVC" in a portable way, and Longhorn's CSI driver does the
actual work.

| | |
|---|---|
| **Source** | [`kubernetes-csi/external-snapshotter`](https://github.com/kubernetes-csi/external-snapshotter) `client/config/crd`, tag pinned in `app.yaml` |
| **Namespace** | None (cluster-scoped CRDs) |
| **Used by** | `longhorn-backup-vsc` (VolumeSnapshotClass, in the longhorn config), pre-upgrade snapshots, CNPG's `volumeSnapshot` backup method |

## Files

Only `app.yaml`: the manifests come straight from the upstream repo at a
pinned tag, so there's nothing to vendor.

## Why these exist

CloudNativePG can back databases up two ways: to S3-compatible object storage
(barman), or as volume snapshots. The NAS doesn't speak S3, so volume
snapshots are the option that works here, and they need this API.

## Gotchas

- **`prune: false` is deliberate.** Deleting a CRD deletes every snapshot of
  that kind; `longhorn-backup-vsc` uses `deletionPolicy: Delete`, so the
  Longhorn backups behind them would be deleted too.
- **Not the same as Longhorn snapshots.** `snapshots.longhorn.io` is
  Longhorn's internal object; this is the portable Kubernetes API on top.
- **Upgrade the CRDs and the controller together** (same `targetRevision`
  in both apps), CRDs first.
