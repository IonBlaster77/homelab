#!/usr/bin/env bash
#
# Set a Longhorn volume's replica count and wait until it is healthy with
# that many running replicas.
#
# Usage: lh-replicas.sh <volume> <count>
#
# Single-replica volumes (alertmanager-1/2, prometheus-1 on the
# longhorn-nvme-single class) block a node drain under the
# block-if-contains-last-replica policy. Give the volume a temporary second
# replica before draining its node (a 52 GiB volume takes ~10 min), then set
# it back to 1 once every node involved is done: Longhorn decides which copy
# it drops, so reverting early can leave the only copy on the next node.
# Do NOT relax the drain policy instead (2026-11 prometheus-1 I/O errors).
set -uo pipefail

v=$1 c=$2
kubectl -n longhorn-system patch volumes.longhorn.io "$v" --type merge \
  -p "{\"spec\":{\"numberOfReplicas\":$c}}" || exit 1
for i in $(seq 1 180); do
  sleep 10
  rob=$(kubectl -n longhorn-system get volumes.longhorn.io "$v" -o jsonpath='{.status.robustness}')
  run=$(kubectl -n longhorn-system get replicas.longhorn.io -l longhornvolume="$v" \
    -o jsonpath='{range .items[*]}{.status.currentState}{"\n"}{end}' | grep -c running)
  [ $((i % 6)) -eq 0 ] && echo "  $((i * 10))s robustness=$rob running=$run"
  if [ "$rob" = healthy ] && [ "$run" -eq "$c" ]; then
    echo "OK after $((i * 10))s"
    kubectl -n longhorn-system get replicas.longhorn.io -l longhornvolume="$v" \
      -o jsonpath='{range .items[*]}{.spec.nodeID} {.status.currentState}{"\n"}{end}'
    exit 0
  fi
done
echo "TIMEOUT robustness=$rob running=$run"; exit 1
