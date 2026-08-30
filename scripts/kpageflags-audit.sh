#!/usr/bin/env bash
#
# Classify every physical page on each Talos node via /proc/kpageflags.
#
# Written 2026-08-29 while chasing a talos2 memory leak of ~0.46 GiB/day that no
# ordinary counter could see: not slab, vmalloc, BPF maps, GUP pins, netns/veth,
# page tables, nor any cgroup. Summing every process's RSS came to 6.16 GiB
# against 13.96 GiB used, so ~7.8 GiB had no owning process at all.
#
# The usual answer is page_owner, but that is a boot-time kernel arg and these
# nodes take their cmdline from a signed UKI (grubUseUKICmdline), so enabling it
# means a new factory schematic and a full `talosctl upgrade`. This script gets
# most of the way there for free: kpageflags is readable on a running node and
# says what KIND every page is.
#
# Watch the "flags=0 UNCLASSIFIED" line. Those are pages that exist but carry no
# LRU/slab/anon/buddy flag - the signature of a raw alloc_pages() by kernel code
# that never freed them. Baseline measured across all four nodes right after
# talos2's reboot, then again 22h later:
#
#     talos2 0.84 -> 0.83 | talos1 0.95 -> 1.15 | talos3 1.00 -> 0.98 | talos4 0.98 -> 0.99
#
# CALIBRATION (corrected 2026-08-30): this number is NOISIER than it first
# looked. talos1 moved +0.20 GiB in a day while completely healthy - its
# meminfo residual and MemAvailable were both flat across the same window. So
# treat roughly 0.8-1.3 GiB as normal and do NOT read a few hundred MiB of
# drift as a leak. The reliable signal is node:memory_unaccounted_bytes (the
# recording rule in clusters/homelab/monitoring/infra-alerts.yaml), which held
# to within 0.02 GiB on every node over the same 22h. Use this script to
# confirm the memory TYPE once that rule fires, not as the tripwire itself.
#
# A real recurrence looks like the pre-reboot state: multiple GiB, climbing
# monotonically day over day. That identifies which node and confirms the
# memory type, but not the call site;
# for that, attach eBPF to the kmem:mm_page_alloc / kmem:mm_page_free
# tracepoints (both present, and /sys/kernel/btf/vmlinux is available) and
# aggregate outstanding allocations by kernel stack.
#
# Usage:  ./kpageflags-audit.sh                 # all four nodes
#         ./kpageflags-audit.sh 10.77.20.12     # one node
#
# Note: mawk lacks and()/lshift(), so bits are tested arithmetically to keep
# this portable between the WSL shell and anywhere else it might get run.

set -uo pipefail

NODES=("10.77.20.11 talos1" "10.77.20.12 talos2" "10.77.20.13 talos3" "10.77.20.14 talos4")
if [ $# -gt 0 ]; then NODES=("$1 ${2:-$1}"); fi

for entry in "${NODES[@]}"; do
  set -- $entry
  IP=$1; NAME=$2

  talosctl -n "$IP" read /proc/kpageflags 2>/dev/null \
  | od -An -tu8 -v -w8 \
  | awk -v node="$NAME" '
      function bit(f, n) { return int(f / (2 ^ n)) % 2 }
      {
        f=$1+0; total++
        if      (bit(f,20)) c["nopage (no struct page)"]++
        else if (bit(f,10)) c["buddy (free)"]++
        else if (bit(f,7))  c["slab"]++
        else if (bit(f,12)) c["anon"]++
        else if (bit(f,5))  c["lru/file"]++
        else if (bit(f,26)) c["pagetable"]++
        else if (bit(f,11)) c["mmap (non-lru)"]++
        else if (f==0)      c["** flags=0 UNCLASSIFIED **"]++
        else                c["other/kernel"]++
      }
      END {
        printf "\n===== %s : %d pages (%.2f GiB physical) =====\n",
               node, total, total*4096/1073741824
        for (k in c) printf "  %-30s %10d  %8.2f GiB\n", k, c[k], c[k]*4096/1073741824
      }'
done
