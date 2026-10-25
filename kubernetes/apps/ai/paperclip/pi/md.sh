#!/bin/sh
# Fetch a web page as markdown through the homelab's crawl4ai (its REST /md
# endpoint: crawl4ai's MCP is SSE-only, which Pi can't use).
#
#   md.sh URL [fit|raw]     default fit; StaticICE needs raw
#
# Output is capped so one page can't flood the context.
set -eu
url=${1:?usage: md.sh URL [fit|raw]}
f=${2:-fit}
case "$f" in
  fit|raw) ;;
  *) echo "md.sh: filter must be fit or raw (bm25 drops StaticICE's price table)" >&2; exit 2 ;;
esac
cap=${MD_MAX_CHARS:-40000}
tok=$(cat /etc/pi-tools/crawl4ai-token)
body=$(jq -n --arg u "$url" --arg f "$f" '{url: $u, f: $f}')
resp=$(curl -sS -m 120 -X POST http://crawl4ai.crawl4ai.svc.cluster.local:11235/md \
  -H "Authorization: Bearer $tok" -H 'Content-Type: application/json' -d "$body") || {
  echo "md.sh: crawl4ai request failed" >&2; exit 1; }
out=$(printf '%s' "$resp" | jq -r 'if (.markdown | type) == "string" then .markdown else "md.sh: crawl4ai error: " + ((.detail // .) | tostring) end')
len=$(printf '%s' "$out" | wc -c)
if [ "$len" -gt "$cap" ]; then
  printf '%s' "$out" | head -c "$cap"
  printf '\n\n[md.sh: truncated, %s of %s characters shown]\n' "$cap" "$len"
else
  printf '%s\n' "$out"
fi
