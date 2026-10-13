# NAS & Switch Maintenance Runbook

Procedure for anything that makes the Synology NAS (`10.77.20.20`)
unreachable from the Talos nodes on purpose: rebooting/power-cycling/
firmware-updating any switch in the path (Dell N1148P-ON core switch,
MikroTik aggregation switch, HP Instant On access switch), **or**
rebooting/updating the NAS itself (DSM updates, etc.).

The trigger condition is "the NFS server media-nfs points at becomes
unreachable" — it doesn't matter whether that's because a switch between
the nodes and the NAS went down, or because the NAS itself went down.
Same mechanism, same risk, same procedure. All four Talos nodes also
share the same switch path to reach each other, so a *switch* reboot is
additionally a full-cluster network partition — a NAS-only reboot doesn't
partition the cluster itself, just cuts off `media-nfs` specifically.

Written after the 2026-08-04 incident: a Dell switch reboot (done because
the switch's console was unresponsive) partitioned the network, and talos4
got permanently wedged mid-shutdown — none of `talosctl reboot`, `--mode
force`, or `--mode powercycle` could recover it, only a physical power-off
did. Root cause: `media-nfs` (external NFS mount to the Synology, `hard`
mount option) was actively held open by pods on talos4 when the partition
hit. `hard` NFS mounts retry indefinitely rather than erroring when the
server is unreachable, and Talos's shutdown sequence does a plain
`syncfs()`/`umount()` with no force/lazy fallback — so the unmount blocked
forever. Talos has no shell, so there's no way to run `umount -f`/`umount
-l` by hand to break it once stuck, and no machine-config option exists to
change this behavior (Talos has no `machine.mounts` field and no NFS
userspace tooling of its own — NFS only exists on Talos via whatever a pod
mounts).

Passive I/O to `media-nfs` self-heals fine on its own once the NAS or
switch comes back — `hard` mounts are designed to retry indefinitely and
just resume. The danger is specifically a node needing to unmount (i.e.
reboot) while the NAS is unreachable, or apparently for some period after
— talos1 hit the identical hang hours after the original switch outage
had already resolved, on an unrelated reboot attempt.

**Long-term fix, if you ever want to stop needing this procedure at all:**
give the Talos nodes a second NIC bonded across a genuinely independent
second switch path to the NAS. That removes the single point of failure
instead of scheduling around it. Real hardware work, not done as of
2026-08-04 — this runbook is the interim answer.

---

## Before rebooting a switch OR the NAS

**1. Check what currently has `media-nfs` mounted** (the one remaining
hard-NFS dependency in the cluster — `adguard`'s equivalent risk was
eliminated 2026-08-04 by moving to per-instance RWO volumes):

```bash
kubectl describe pvc -n media media-nfs | grep -A20 '^Used By:'
```

**2. Scale those Deployments to 0** — not cordon/drain. Draining just
reschedules the pod (and its NFS mount) onto a different node, which is
still exposed; only actually stopping the pod removes the mount.

```bash
kubectl scale deploy -n media bazarr jellyfin nzbget qbittorrent radarr sonarr unpackerr --replicas=0
```

(Cross-check this list against step 1's `Used By:` output — new *arr
apps or renamed deployments can add or drop consumers of `media-nfs`
over time.)

**3. Confirm nothing's still attached:**

```bash
kubectl describe pvc -n media media-nfs | grep -A5 '^Used By:'
# should be empty
```

**4. Now it's safe to reboot/power-cycle/update the switch or the NAS.**

**5. Once it's back up, verify basic reachability before touching
anything else:**

```bash
kubectl get nodes -o wide
talosctl -n 10.77.20.11,10.77.20.12,10.77.20.13 etcd status
ping -c3 10.77.20.20   # the NAS itself — for a NAS-only reboot the nodes
                       # never go NotReady, so this is the actual signal
```

Wait for all 4 nodes `Ready`, etcd raft indexes matching across all
three control-plane members, and the NAS responding to ping, before
proceeding.

**6. Scale the media Deployments back up:**

```bash
kubectl scale deploy -n media bazarr jellyfin nzbget qbittorrent radarr sonarr unpackerr --replicas=1
```

---

## If a node gets wedged anyway

Confirm it's this specific failure before escalating — check for the
signature pattern:

```bash
talosctl -n <node-ip> dmesg | tail -30
```

Look for `nfs: server ... not responding, timed out` interleaved with
`task unmountPodMounts` log lines and the phase stuck at `phase umount
(4/10)`. If kubelet/talosctl API still respond (ping works, `talosctl
version` works) but `kubectl get nodes` shows `NotReady` and it's been
stuck at the same dmesg line for several minutes with no new log
activity — this is the hang.

Escalation path, in order (each one only worth trying because the
previous one still attempts a graceful unmount phase first and can hang
identically):

```bash
talosctl -n <node-ip> reboot                    # try first, ~2-5 min
talosctl -n <node-ip> reboot --mode force        # skips graceful teardown in theory; in practice still hit the same hang 2026-08-04
talosctl -n <node-ip> reboot --mode powercycle   # skips kexec only, NOT the unmount phase — also hung
```

If all three hang identically (same dmesg signature each time): **stop
trying software reboots.** Physically power off the node (hold the power
button until it turns off) and power back on. This was the only thing
that worked on 2026-08-04.

Monitor recovery:

```bash
kubectl get nodes -w
talosctl -n 10.77.20.11,10.77.20.12,10.77.20.13 etcd status   # if a control-plane node
```

Control-plane note: talos1/2/3 hold etcd. Losing any *one* of them still
leaves quorum intact (2-of-3) — safe to power-cycle one at a time. Never
take down two control-plane nodes simultaneously.

---

## Known-safe vs known-risk

| Storage | Risk |
|---|---|
| Longhorn RWO (iSCSI-backed, most workloads) | Not confirmed to have this specific hang — different attach mechanism than NFS `hard` mounts. Not verified safe under partition either; just untested. |
| `adguard-primary-config` / `adguard-replica-config` (Longhorn RWO, since 2026-08-04) | Fixed — no NFS involved. |
| `media-nfs` (external NFS, Synology, `hard`) | **Confirmed risk.** Follow the scale-down procedure above before switch *or* NAS work. |

Don't change `media-nfs`'s mount options to `soft` as a shortcut around
this procedure — `soft` returns I/O errors on timeout instead of
blocking, which risks corrupting in-flight writes from qbittorrent/nzbget.
`hard` is the correct choice for this workload; the maintenance window is
the only time it's a liability, and scaling down for that window is the
right fix, not changing the mount semantics permanently. Switching the
share type to SMB was also considered and rejected: CIFS defaults to
`soft`-like behavior which would reduce this specific risk, but SMB
doesn't support Unix hardlinks the way NFS does, and Sonarr/Radarr/
qBittorrent rely on hardlinking to import completed downloads without
duplicating multi-GB files — switching would trade a rare maintenance-
window risk for permanently worse everyday behavior.
