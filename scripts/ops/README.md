# Operational scripts

Helpers for node-by-node maintenance (Talos upgrades, drains, reboots). They
run from a workstation with `kubectl`, `talosctl` and the `kubectl cnpg`
plugin configured for the cluster. Each script calls its siblings from its own
directory, so run them from anywhere.

| Script | Changes the cluster? | What it does |
|---|---|---|
| `cnpg-lag.sh [ns/cluster ...]` | no | Primary, replication state, lag and node for each CNPG cluster |
| `cnpg-move.sh <ns> <cluster> <target-pod>` | **yes** | Controlled switchover to a replica (refuses if it is >1 MiB behind), waits until healthy |
| `cnpg-move-batch.sh <ns>:<cluster>:<pod> ...` | **yes** | `cnpg-move.sh` for several clusters, stops at the first failure |
| `lh-replicas.sh <volume> <count>` | **yes** | Set a Longhorn volume's replica count, wait until healthy |
| `talos-upgrade-node.sh <node> <ip>` | **yes** | Upgrade one node with a power cycle, print a health summary |
| `wait-node-settled.sh <node> [minutes]` | no | Wait for Longhorn volumes and Cilium health, then check etcd and pods |

## Upgrading Talos, one node at a time

Proven on the 1.13.12 -> 1.14.6 rollout (2026-11-22). Workers first, with one
canary worker proven before the rest; control-plane nodes last, the etcd
leader last of all.

1. **Commit the new installer** to `talos/*.yaml` (with `sops edit`, never a
   plain editor: it breaks the SOPS MAC). `talos-upgrade-node.sh` reads the
   image from `talos/worker.yaml`; or pass `IMG=`.
2. **Before each node:**
   - Move its CNPG primaries to replicas on other nodes (`cnpg-lag.sh` shows
     where they are, `cnpg-move-batch.sh` moves them, matrix last). A drain
     also switches them over, but on its own schedule.
   - If it holds the only replica of a volume (`kubectl get
     volumes.longhorn.io -n longhorn-system` with `numberOfReplicas` 1), add a
     temporary second one: `lh-replicas.sh <volume> 2`.
3. **Upgrade:** `talos-upgrade-node.sh <node> <ip>`; for a control-plane node,
   `EP=<another control-plane IP> talos-upgrade-node.sh ...`.
4. **Wait:** `wait-node-settled.sh <node>` until it prints SETTLED (about
   15 min). Don't start the next node before that.
5. **After the last node:** set temporary replicas back to 1
   (`lh-replicas.sh <volume> 1`), and spread the CNPG primaries out again:
   moving them node by node tends to pile them all on the last node upgraded.

Known noise: longhorn-manager may crash-loop for about a minute after boot
(Longhorn bug, recovers on its own); a few boot-time SELinux AVC denials are
normal in permissive mode.
