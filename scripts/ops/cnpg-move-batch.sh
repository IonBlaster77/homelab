#!/usr/bin/env bash
#
# Run cnpg-move.sh for several clusters in order, stopping at the first
# failure, with a 20 s pause between switchovers.
#
# Usage: cnpg-move-batch.sh <ns>:<cluster>:<target-pod> [...]
#   e.g. cnpg-move-batch.sh atlas:atlas-db:atlas-db-1 kea:kea-db:kea-db-1
# Put matrix last: Synapse is the app most sensitive to a switchover.
set -uo pipefail
here=$(cd "$(dirname "$0")" && pwd)

for x in "$@"; do
  IFS=: read -r ns n t <<< "$x"
  echo "##### $ns/$n -> $t"
  "$here/cnpg-move.sh" "$ns" "$n" "$t" || { echo STOPPED; exit 1; }
  sleep 20
done
