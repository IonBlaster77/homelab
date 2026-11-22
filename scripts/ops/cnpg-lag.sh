#!/usr/bin/env bash
#
# Read-only. For each CNPG cluster: current primary, replication state and
# replay lag (bytes behind the primary), and which node each instance is on.
#
# Usage: cnpg-lag.sh [<namespace>/<cluster> ...]   (default: every cluster)
#
# Output per cluster:
#   == <ns>/<cluster> primary=<pod>
#   <replica>|<state>|<sync_state>|<lag bytes>|<replay_lag>
#      pod <name>:<node>
set -uo pipefail

if [ $# -eq 0 ]; then
  set -- $(kubectl get clusters.postgresql.cnpg.io -A --no-headers \
    -o custom-columns=NS:.metadata.namespace,NAME:.metadata.name | awk '{print $1"/"$2}')
fi

for c in "$@"; do
  ns=${c%/*}; n=${c#*/}
  prim=$(kubectl get clusters.postgresql.cnpg.io -n "$ns" "$n" -o jsonpath='{.status.currentPrimary}')
  echo "== $ns/$n primary=$prim"
  kubectl exec -n "$ns" "$prim" -c postgres -- psql -XAtq -U postgres -c \
    "select application_name, state, sync_state, pg_current_wal_lsn() - replay_lsn, replay_lag from pg_stat_replication" 2>&1
  kubectl get pods -n "$ns" -l cnpg.io/cluster="$n",cnpg.io/podRole=instance \
    -o jsonpath='{range .items[*]}   pod {.metadata.name}:{.spec.nodeName}{"\n"}{end}'
done
