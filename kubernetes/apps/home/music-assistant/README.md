# Music Assistant

Music server and multi-room audio engine for the whole-home zoned audio
project ([docs/projects/zoned-audio.md](../../../../docs/projects/zoned-audio.md)).
It streams to AirPlay speakers and other players, and Home Assistant controls
it by service name.

| | |
|---|---|
| **URL** | https://music.jupitertech.net (Gateway, behind Cloudflare Access), plus the node's LAN address on port 8095 |
| **Image** | `ghcr.io/music-assistant/server` |
| **Namespace** | `music-assistant` |
| **Storage** | `music-assistant-data`, 10Gi Longhorn RWO, covered by the hourly/daily NAS backups |
| **Depends on** | Gateway (`homelab-gateway`), Longhorn, CoreDNS (reaches Home Assistant by service name) |

## Files

| File | What it is |
|---|---|
| `app.yaml` | Argo CD Application for this folder |
| `kustomization.yaml` | Lists the manifests below |
| `namespace.yaml` | Namespace with PSA `privileged`, required for `hostNetwork` |
| `deployment.yaml` | The server: `hostNetwork`, pinned to `talos4`, `Recreate` strategy |
| `service.yaml` | ClusterIP backend for the HTTPRoute (deliberately no LoadBalancer) |
| `pvc.yaml` | Library, provider credentials, player and zone/group definitions |
| `httproute.yaml` | `music.jupitertech.net` → the Service (lives in the `networking` namespace) |
| `referencegrant.yaml` | Lets that cross-namespace route reach the Service |

## Gotchas

- **`hostNetwork` is required, not a shortcut.** AirPlay needs LAN multicast in
  both directions: Music Assistant has to receive mDNS announcements from
  speakers, and advertise itself so phones see the zones. A pod on the cluster
  network has no leg on the LAN, and no mDNS reflector arrangement fixes that.
  The namespace is therefore PSA `privileged`, but the pod takes `hostNetwork`
  and nothing else: no privileged flag, no host PID/IPC, no hostPath, all
  capabilities dropped.
- **Pinned to `talos4`.** With `hostNetwork` the pod's address is the node's,
  and speaker pairings, ESP32 firmware and advertised stream URLs all reference
  it. If it moved, every zone would silently break.
- **`dnsPolicy: ClusterFirstWithHostNet`.** With `hostNetwork` the default DNS
  policy falls back to the node's resolver and in-cluster names stop resolving.
- **`Recreate`, never `RollingUpdate`.** A single RWO volume and fixed host
  ports mean two pods can't coexist, so a rolling update would deadlock.
- **No CPU limit.** Real-time audio mixing under CPU throttling produces
  dropouts and sync drift, so only memory is capped.
- **Intentionally no CiliumNetworkPolicy.** A host-networked pod has Cilium's
  `reserved:host` identity, not a per-pod one, so a policy selecting
  `app: music-assistant` would select nothing and enforce nothing while looking
  like protection. Host-level policy would need Cilium's host firewall
  (`enable-host-firewall`), which is off cluster-wide (verified 2026-08-16) and
  is too broad a change to enable for a music player. The pod's network access
  is therefore bounded by the node's posture, the same as the cluster's other
  `hostNetwork` pods. The clean fix is to drop `hostNetwork` by giving the pod
  its own LAN interface with macvlan/Multus; that's tracked as a separate
  hardening task.
