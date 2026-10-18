# Moving the Rack onto the UPS (Rolling, No Full Outage)

One-off procedure for moving every rack device from mains onto the
CyberPower OLS2000ERT2UA UPS **one device at a time**, keeping etcd quorum
and most services up throughout. Written 2026-10-18; the structure also
works for any later "power-cycle every device in turn" job (PSU swaps, PDU
changes).

| | |
|---|---|
| UPS | CyberPower OLS2000ERT2UA, 2 kVA / 1800 W online double-conversion, 48 V string |
| Management | RMCARD205 at `10.77.10.30` / <http://ups.jupitertech.net> |
| Nodes | talos1-3 control plane `10.77.20.11-13`, talos4 worker `10.77.20.14` |
| Related | [NAS and switch maintenance](nas-and-switch-maintenance.md) (hard-NFS hazard), [bootstrap](bootstrap.md) |

**Never run `talosctl bootstrap`** at any point here. The cluster already
exists; bootstrapping a node that rejoins would fork etcd.

---

## 0. Before the day

- [ ] **Battery compartment inspected**: no swollen, cracked or leaking
      blocks. A swollen battery on charge is the one genuine safety risk.
- [ ] UPS on mains for 24 h; **UPS → Status** shows *Fully Charged*, 100 %.
- [ ] **Outlets: use the critical bank only.** The UPS has an **NCL
      (non-critical load) bank** that it can switch off on battery to stretch
      runtime (*UPS → Bank Control*). Nothing in the rack goes on NCL outlets.
- [ ] Fill in this table (check each device's chassis/UI for a second PSU):

| Device | Redundant PSU? | Carries node links? | Move in step |
|---|---|---|---|
| Dell N1148P-ON | ? | ? | 1 or 3 |
| MikroTik switch | ? | ? | 1 or 3 |
| MikroTik router (Juno) | no (assumed) | no | 2 |
| HP/Aruba Instant On | ? | ? | 1 or 3 |
| Synology NAS | **no** | n/a | 3 |
| talos4, talos3, talos2, talos1 | no | n/a | 4-7 |

A **single-PSU switch that carries node links** is not a rolling move:
unplugging it partitions the nodes from each other (etcd loses quorum,
Longhorn can fail volumes mid-write - the read-only-filesystem failure
from task #35). It goes in the **step 3 window** with the media stack down.

## 0b. Start of the window

**Silence alerts** (otherwise every node-down alert lands in
#alerts-critical and Hermes auto-investigates each one). Leaves `Watchdog`
firing:

```bash
kubectl -n monitoring exec alertmanager-monitoring-kube-prometheus-alertmanager-0 -c alertmanager -- \
  amtool --alertmanager.url=http://localhost:9093 silence add 'alertname!=Watchdog' \
  --duration=6h --author=krishna --comment="UPS rack migration"
```

**Baseline health** - all of these must pass now, and again before every
next step:

```bash
kubectl get nodes                                    # all Ready
talosctl -n 10.77.20.11,10.77.20.12,10.77.20.13 etcd status   # 3 members, raft index matching, no errors
# Longhorn: every ATTACHED volume healthy (detached volumes report "unknown"; ignore those)
kubectl -n longhorn-system get volumes.longhorn.io \
  -o jsonpath='{range .items[*]}{.metadata.name} {.status.state} {.status.robustness}{"\n"}{end}' \
  | awk '$2=="attached" && $3!="healthy"'           # must print nothing
kubectl get clusters.postgresql.cnpg.io -A           # every cluster "Cluster in healthy state"
```

After adding each device, check **UPS → Status → Load** (watts) stays well
under 1800 W.

---

## 1. Network gear with redundant PSUs (no downtime)

For each such device:

1. Plug **PSU 2** into the UPS (critical bank).
2. In the device's UI, confirm **both PSUs report OK**.
3. Move **PSU 1** to the UPS. Confirm both OK again.

## 2. Router (single PSU, brief cut)

Move the plug. Expect ~1-2 min without internet and inter-VLAN routing
while it boots. The cluster keeps running (nodes, Gateway VIP and AdGuard
are all on VLAN 20), but node DNS points at the router (`10.77.20.1`) so
image pulls fail briefly. Wait for `kubectl get nodes` to work from the
desktop again and DHCP leases to renew before continuing.

## 3. NAS window (media stack down) - plus any single-PSU node switch

The NAS has one PSU, and pods hard-mount it over NFS
(`media/media-nfs`). Stop every consumer first.

**Scale the media stack down via git, not `kubectl scale`.** Both the
`media` Application and its parent `bootstrap-apps` have selfHeal on, so a
`kubectl scale` (or pausing `media`'s auto-sync) is reverted within
minutes, silently re-mounting NFS mid-maintenance.

1. Open a PR setting `replicas: 0` in the `media-nfs` consumers under
   `kubernetes/apps/media/media-stack/`: bazarr, jellyfin, nzbget,
   qbittorrent, radarr, sonarr, unpackerr. Re-check the list first:

   ```bash
   kubectl describe pvc -n media media-nfs | grep -A20 '^Used By:'
   ```

2. Merge, then `argocd app sync media`.
3. Confirm nothing has it mounted (`Used By:` must be empty):

   ```bash
   kubectl describe pvc -n media media-nfs | grep -A5 '^Used By:'
   ```

4. Shut the NAS down from DSM, move its plug, power it on. Do any
   single-PSU switch that carries node links **now** as well.
5. Verify: `ping 10.77.20.20`, DSM reachable, all nodes `Ready`, etcd 3/3,
   Longhorn baseline check clean. **If a switch was moved, also prove
   volumes are writable** - a Longhorn volume can report `healthy` while the
   filesystem inside the pod has gone read-only:

   ```bash
   # any pod with a Longhorn RWO volume, e.g. Grafana's database
   kubectl -n monitoring exec grafana-db-4 -c postgres -- \
     sh -c 'touch /var/lib/postgresql/data/.rw-test && rm /var/lib/postgresql/data/.rw-test && echo writable'
   ```

6. Revert the PR (or a follow-up PR restoring `replicas: 1`), merge,
   `argocd app sync media`, check the media apps come back.

---

## 4-7. Nodes, one at a time

**Order: talos4 → talos3 → talos2 → talos1.** Worker first (it has the
most spare control-plane headroom to absorb), control plane after,
talos1 last.

### Per-node procedure

Set the node once:

```bash
NODE=talos4; IP=10.77.20.14
```

**a. Move CNPG primaries off the node.** Each cluster has a
`*-db-primary` PDB that refuses to evict a primary, so the drain blocks
until it is switched over. Find primaries on this node and promote the
other instance:

```bash
kubectl get pods -A -l cnpg.io/instanceRole=primary -o wide | grep "$NODE"
kubectl get pods -A -l cnpg.io/cluster -o wide            # pick the replica on another node
kubectl cnpg promote <cluster> <replica-instance> -n <namespace>
```

As of 2026-10-18: talos4 held **harbor-db, matrix-db, grafana-db**;
talos1 held **authentik-db, kea-db**; talos2/talos3 none - re-check, it
moves. Each switchover is a few seconds of reconnects; check Authentik
login and Grafana afterwards.

**b. Single-replica Longhorn volumes.** The node-drain policy is
`block-if-contains-last-replica`, so a node holding the only replica of a
volume won't drain. As of 2026-10-18 the only one is Harbor's registry
(`harbor/harbor-registry`, class `longhorn-nvme-single`), on **talos3**:

```bash
kubectl -n longhorn-system get volumes.longhorn.io \
  -o jsonpath='{range .items[*]}{.metadata.name} {.spec.numberOfReplicas} {.status.kubernetesStatus.namespace}/{.status.kubernetesStatus.pvcName}{"\n"}{end}' \
  | awk '$2==1'
kubectl -n longhorn-system get replicas.longhorn.io -o wide | grep <volume-name>   # which node
```

Before draining that node, raise the volume to **2 replicas** in the
Longhorn UI (Volume → Update Replicas Count) and wait until it is
`healthy` with both replicas running. Set it back to 1 after step 7. (The
Volume CR is created by the CSI driver, not git, so this does not fight
Argo.) The alternative is accepting Harbor being down while that node is
off; nodes fall back to pulling upstream.

**c. Drain.**

```bash
kubectl drain "$NODE" --ignore-daemonsets --delete-emptydir-data --timeout=15m
```

If it hangs, `kubectl get pdb -A` shows which PDB is at 0 allowed
disruptions - usually a CNPG primary (step a) or a Longhorn
instance-manager waiting on a last replica (step b).

**d. Shut down, move, power on.**

```bash
talosctl -n "$IP" shutdown
```

Wait until the node stops answering (`talosctl -n "$IP" version` times
out) and the power LED is off. Move the plug to the UPS. Power on (button,
unless the BIOS is set to power on with AC).

**e. Rejoin.**

```bash
kubectl get node "$NODE" -w                          # until Ready
kubectl uncordon "$NODE"
talosctl -n 10.77.20.11,10.77.20.12,10.77.20.13 etcd status   # control-plane nodes: 3/3, indexes converge
```

**f. Wait for Longhorn to finish rebuilding** before the next node: the
baseline Longhorn check must print nothing, and no rebuilds in progress
(Longhorn UI, or `kubectl -n longhorn-system get engines.longhorn.io` with
no `rebuildStatus`). With ~110 replicas this can take a while; do not
shortcut it - taking the next node down early can leave a volume with two
of three copies offline.

Then repeat for the next node.

### Node-specific notes

| Node | Notes |
|---|---|
| talos4 | Music Assistant is pinned here (hostNetwork) and is down until talos4 returns. Holds 3 CNPG primaries. |
| talos3 | Holds Harbor's single registry replica (step b). |
| talos2 | Nothing special. |
| talos1 | Holds 2 CNPG primaries. Last control-plane node: confirm etcd 3/3 before starting. |

---

## 8. Finish

- [ ] Every device on the UPS critical bank; **UPS → Status → Load** noted.
- [ ] Harbor registry volume back to **1** replica.
- [ ] Media stack back to `replicas: 1` and synced (step 3).
- [ ] Baseline health checks all pass.
- [ ] Expire the silence:

  ```bash
  kubectl -n monitoring exec alertmanager-monitoring-kube-prometheus-alertmanager-0 -c alertmanager -- \
    amtool --alertmanager.url=http://localhost:9093 silence query
  kubectl -n monitoring exec alertmanager-monitoring-kube-prometheus-alertmanager-0 -c alertmanager -- \
    amtool --alertmanager.url=http://localhost:9093 silence expire <id>
  ```

- [ ] Then run the real test: with the rack on the UPS, **UPS →
      Diagnostics → Battery Test** (10 s), and later a pull-the-plug test
      (unplug UPS input, watch Status for battery voltage and runtime at 1,
      5 and 10 min). If the batteries can't carry the rack, replace the
      cartridge - it is no worse than having no UPS.

## Aborting

Any step can stop part-way: a moved device simply stays on the UPS. If a
node fails to rejoin, leave the remaining nodes alone (etcd keeps quorum
with 2 of 3) and troubleshoot that node; do not start another node while
any node is NotReady or Longhorn is rebuilding.
