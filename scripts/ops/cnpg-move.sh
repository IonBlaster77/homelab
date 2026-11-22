#!/usr/bin/env bash
#
# Controlled switchover of one CNPG cluster to a chosen replica, then wait
# until the cluster is healthy again. Use it to move primaries off a node
# BEFORE draining it: a drain-triggered switchover is not under our control.
#
# Usage: cnpg-move.sh <namespace> <cluster> <target-pod>
#
# Refuses if the target replica is not streaming or is more than 1 MiB behind.
# A switchover takes ~20-35 s; the old primary comes back as a replica.
set -uo pipefail
here=$(cd "$(dirname "$0")" && pwd)

ns=$1 n=$2 tgt=$3
lag=$("$here/cnpg-lag.sh" "$ns/$n" | awk -F'|' -v t="$tgt" '$1==t && $2=="streaming" {print $4}')
echo "pre-switch lag bytes ($tgt): ${lag:-<not streaming>}"
[ -n "$lag" ] || { echo "ABORT: $tgt is not a streaming replica"; exit 1; }
[ "$lag" -lt 1048576 ] || { echo "ABORT: $tgt is more than 1 MiB behind"; exit 1; }

start=$(date +%s)
kubectl cnpg promote -n "$ns" "$n" "$tgt" || exit 1
for _ in $(seq 1 60); do
  sleep 5
  read -r prim phase ready < <(kubectl get clusters.postgresql.cnpg.io -n "$ns" "$n" \
    -o jsonpath='{.status.currentPrimary} {.status.readyInstances} {.status.phase}' \
    | awk '{p=$1; r=$2; $1=$2=""; sub(/^ +/,""); gsub(/ /,"_"); print p, $0, r}')
  if [ "$prim" = "$tgt" ] && [ "$phase" = "Cluster_in_healthy_state" ] \
     && [ "$ready" = "$(kubectl get clusters.postgresql.cnpg.io -n "$ns" "$n" -o jsonpath='{.spec.instances}')" ]; then
    echo "switched in $(( $(date +%s) - start ))s"
    "$here/cnpg-lag.sh" "$ns/$n" | tail -n +2
    kubectl get pods -n "$ns" --no-headers | grep -v -E 'Running|Completed' || echo "all $ns pods Running"
    exit 0
  fi
done
echo "TIMEOUT: primary=$prim phase=$phase ready=$ready"; exit 1
