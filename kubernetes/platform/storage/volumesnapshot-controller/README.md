# Snapshot controller

The cluster-wide half of Kubernetes volume snapshots. When something creates
a `VolumeSnapshot`, this controller creates the matching
`VolumeSnapshotContent`; Longhorn's `csi-snapshotter` sidecar (already
running as part of Longhorn) sees that and takes the snapshot or backup. Without
this controller, that sidecar has nothing to do.

| | |
|---|---|
| **Source** | [`kubernetes-csi/external-snapshotter`](https://github.com/kubernetes-csi/external-snapshotter) `deploy/kubernetes/snapshot-controller`, tag pinned in `app.yaml` |
| **Namespace** | `kube-system` |
| **Runs** | `snapshot-controller` Deployment, 2 replicas with leader election |
| **Depends on** | [The VolumeSnapshot CRDs](../volumesnapshot-crds/) (same version) |

## Files

Only `app.yaml`: the manifests come straight from the upstream repo at a
pinned tag.

## Gotchas

- **Keep the version in step with the CRDs** and upgrade the CRDs first.
- **Taking a snapshot by hand:** create a `VolumeSnapshot` with
  `volumeSnapshotClassName: longhorn-backup-vsc` pointing at the PVC; check
  `readyToUse: true` on it before relying on it.
