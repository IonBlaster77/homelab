#!/usr/bin/env bash
#
# Upgrade one Talos node with a firmware power cycle, then print a health
# summary and point the node's live install image at the new version.
#
# Usage: [EP=<other-cp-ip>] [IMG=<installer>] talos-upgrade-node.sh <node-name> <ip>
#   IMG  defaults to the installer line in talos/worker.yaml (all nodes share
#        one schematic), so commit the new version there first or pass IMG.
#   EP   talosctl endpoint; set it to ANOTHER control-plane node when
#        upgrading a control-plane node.
#
# Before running (see README.md): move the node's CNPG primaries off with
# cnpg-move.sh and give single-replica Longhorn volumes on it a temporary
# second replica with lh-replicas.sh. Afterwards: wait-node-settled.sh.
#
# --reboot-mode powercycle: sd-boot nodes can hang on a warm reboot
# (siderolabs/talos#14146). talosctl >= 1.14 waits for Ready and uncordons.
set -uo pipefail
here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../.." && pwd)

n=$1 ip=$2
IMG=${IMG:-$(grep -m1 -oE 'factory\.talos\.dev/(metal-)?installer/[0-9a-f]{64}:v[0-9]+\.[0-9]+\.[0-9]+' "$repo/talos/worker.yaml")}
[ -n "$IMG" ] || { echo "no installer image found; pass IMG="; exit 1; }
tag=${IMG##*:}
T="talosctl ${EP:+-e $EP}"
log=${TMPDIR:-/tmp}/talos-upgrade-$n.log

echo "== $(date -u +%T) $n ($ip) $($T -n "$ip" version 2>/dev/null | grep Tag | tail -1 | tr -d '\t ') -> $tag"
echo "CNPG primaries on $n (a drain would switch these over uncontrolled):"
for c in $(kubectl get clusters.postgresql.cnpg.io -A -o jsonpath='{range .items[*]}{.metadata.namespace}/{.status.currentPrimary} {end}'); do
  ns=${c%%/*}; p=${c#*/}
  [ "$(kubectl -n "$ns" get pod "$p" -o jsonpath='{.spec.nodeName}')" = "$n" ] && echo "  $ns/$p"
done
$T -n "$ip" image list --namespace system 2>/dev/null | grep -q "installer.*$tag" \
  || { echo "pre-pulling installer"; $T -n "$ip" image pull --namespace system "$IMG" 2>&1 | tail -1; }

$T -n "$ip" upgrade --image "$IMG" --reboot-mode powercycle --wait --timeout 40m > "$log" 2>&1
rc=$?
echo "== $(date -u +%T) upgrade exit=$rc (full log: $log); last lines:"; tail -4 "$log"
[ $rc = 0 ] || { echo "!! upgrade failed - STOP"; exit 1; }

echo "version: $($T -n "$ip" version 2>/dev/null | grep Tag | tail -1 | tr -d '\t ')"
echo "kernel:  $($T -n "$ip" read /proc/version | cut -d' ' -f3)  uptime: $($T -n "$ip" read /proc/uptime | cut -d. -f1)s  uki: $($T -n "$ip" get securitystate -o yaml 2>/dev/null | grep -o -E 'bootedWithUKI: [a-z]+')"
echo "cmdline: $($T -n "$ip" read /proc/cmdline)"
echo "ext:     $($T -n "$ip" get extensions -o yaml 2>/dev/null | grep -E '^\s+name:' | awk '{print $2}' | tr '\n' ' ')"
kubectl get node "$n" -o jsonpath='node:    {.status.nodeInfo.osImage} kubelet={.status.nodeInfo.kubeletVersion} kernel={.status.nodeInfo.kernelVersion} ready={.status.conditions[?(@.type=="Ready")].status} unschedulable={.spec.unschedulable}{"\n"}'
echo "services not Running/OK (? = no health check):"
$T -n "$ip" services 2>&1 | awk 'NR>1 && ($3!="Running" || ($4!="OK" && $4!="?")) {print "  ", $0}'
echo "dmesg kernel errors (filtered):"
$T -n "$ip" dmesg 2>&1 | grep -E 'kern: +(err|crit|alert|emerg)' \
  | grep -v -E 'kvm_amd|ACPI|EDD|ERST|microcode|audit: rate limit|VMX .*BIOS' | cut -c1-180 | tail -8
# A few boot-time AVC denials (kernel_t executing init) are normal in permissive mode.
echo "nvme timeouts/resets: $($T -n "$ip" dmesg 2>&1 | grep -c -i -E 'nvme.*(timeout|reset|abort)')   avc denials: $($T -n "$ip" dmesg 2>&1 | grep -c 'avc:  denied')"

# Point the live config's install image at the new version (no reboot), so
# a later reinstall or `talosctl upgrade` without --image uses it.
patch=$(mktemp)
printf 'machine:\n  install:\n    image: %s\n' "$IMG" > "$patch"
$T -n "$ip" patch mc --patch @"$patch" --mode=no-reboot 2>&1 | tail -1
rm -f "$patch"

P=$(kubectl -n kube-system get pod -l k8s-app=cilium --field-selector spec.nodeName="$n" -o name)
echo "bgp:     $(kubectl -n kube-system exec "$P" -c cilium-agent -- cilium-dbg shell bgp/peers 2>/dev/null | awk 'NR>1{print $3, $4}' | tr '\n' ' ')"
