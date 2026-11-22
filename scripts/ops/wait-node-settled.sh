#!/usr/bin/env bash
#
# Read-only. After a node reboot, wait until every Longhorn volume is healthy
# and the node's Cilium health check reaches every node, then print apiserver
# readiness, etcd raft indexes and any pod that isn't Running/Completed.
#
# Usage: wait-node-settled.sh <node-name> [max-minutes]   (default 30)
#
# Typical times: Cilium 1-6 min, Longhorn resync 12-16 min for ~60 volumes.
# Don't start the next node until this prints SETTLED.
set -uo pipefail

n=$1 max=${2:-30}
want=$(kubectl get nodes --no-headers | wc -l)
for i in $(seq 1 $((max * 4))); do
  vols=$(kubectl -n longhorn-system get volumes.longhorn.io \
    -o jsonpath='{range .items[*]}{.status.robustness}{"\n"}{end}' | sort | uniq -c | tr -s ' ' | tr '\n' ' ')
  P=$(kubectl -n kube-system get pod -l k8s-app=cilium --field-selector spec.nodeName="$n" -o name)
  ch=$(kubectl -n kube-system exec "$P" -c cilium-agent -- cilium-dbg status 2>/dev/null \
    | grep -E '^Cluster health' | awk '{print $3}')
  [ $((i % 4)) = 1 ] && echo "$(date -u +%T) volumes:[$vols] cilium-health:$ch"
  if ! echo "$vols" | grep -q -E 'degraded|faulted|unknown' && [ "$ch" = "$want/$want" ]; then
    echo "$(date -u +%T) SETTLED volumes:[$vols] cilium-health:$ch"
    kubectl get --raw=/readyz; echo
    cps=$(kubectl get nodes -l node-role.kubernetes.io/control-plane \
      -o jsonpath='{range .items[*]}{.status.addresses[?(@.type=="InternalIP")].address}{","}{end}')
    talosctl -n "${cps%,}" etcd status 2>&1 | tail -n +2 \
      | awk '{print "etcd", $1, "leader=" $8, "index=" $9, "applied=" $11}'
    kubectl get pods -A --no-headers | grep -v -E 'Running|Completed' || echo "no non-running pods"
    exit 0
  fi
  sleep 15
done
echo "TIMEOUT volumes:[$vols] cilium-health:$ch"; exit 1
