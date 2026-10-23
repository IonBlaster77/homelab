#!/usr/bin/env bash
#
# Schema-check rendered manifests (from render-apps.sh) with kubeconform.
#
# Usage: validate-rendered.sh <rendered-dir>
#   Prints a per-app summary, emits a GitHub ::warning per invalid object, and
#   writes <rendered-dir>/_kubeconform.json. Exits 1 if any object is invalid
#   or failed to parse, 0 otherwise; the workflow decides whether that fails CI.
#
# Schemas: upstream Kubernetes (KUBE_VERSION, default 1.35.0) plus the
# datreeio CRDs-catalog for Cilium, CNPG, Gateway API, Longhorn, Prometheus
# Operator, cert-manager, Argo and friends. Objects with no schema anywhere are
# counted as skipped, not failed. -strict rejects unknown fields (typos) and
# duplicate keys, which also catches documents glued together without "---".
#
# Needs: kubeconform, jq.

set -uo pipefail
DIR=${1:?usage: validate-rendered.sh <rendered-dir>}
KUBE_VERSION=${KUBE_VERSION:-1.35.0}
CATALOG='https://raw.githubusercontent.com/datreeio/CRDs-catalog/main/{{.Group}}/{{.ResourceKind}}_{{.ResourceAPIVersion}}.json'
REPORT="$DIR/_kubeconform.json"

shopt -s nullglob
files=()
for f in "$DIR"/*.yaml; do files+=("$f"); done
[ ${#files[@]} -gt 0 ] || { echo "no rendered files in $DIR"; exit 1; }

kubeconform -strict -kubernetes-version "$KUBE_VERSION" \
  -schema-location default -schema-location "$CATALOG" \
  -ignore-missing-schemas -skip CustomResourceDefinition \
  -output json -summary -verbose -n 8 "${files[@]}" > "$REPORT"

jq -r '.resources[]? | select(.status == "statusInvalid" or .status == "statusError")
       | "::warning title=kubeconform \(.filename | split("/") | last)::\(.kind)/\(.name): \(.msg | gsub("\n"; " ") | .[0:400])"' "$REPORT"

echo
printf '%-28s %6s %6s %6s %6s\n' app valid invalid error skipped
jq -r '[.resources[]? | {app: (.filename | split("/") | last | rtrimstr(".yaml")), status}]
       | group_by(.app)[]
       | [ .[0].app,
           ([.[] | select(.status == "statusValid")] | length),
           ([.[] | select(.status == "statusInvalid")] | length),
           ([.[] | select(.status == "statusError")] | length),
           ([.[] | select(.status == "statusSkipped")] | length) ]
       | @tsv' "$REPORT" | while IFS=$'\t' read -r a v i e s; do
  printf '%-28s %6s %6s %6s %6s\n' "$a" "$v" "$i" "$e" "$s"
done
jq -r '.summary // empty | "total: valid=\(.valid) invalid=\(.invalid) errors=\(.errors) skipped=\(.skipped)"' "$REPORT"

bad=$(jq '[.resources[]? | select(.status == "statusInvalid" or .status == "statusError")] | length' "$REPORT")
[ "$bad" -eq 0 ]
