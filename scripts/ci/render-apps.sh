#!/usr/bin/env bash
#
# Render every Argo CD Application in kubernetes/**/app.yaml the way Argo CD
# would, one file per app, so CI can schema-check and diff the real output.
#
# Usage: render-apps.sh <out-dir> [repo-root]
#   Writes <out-dir>/<app-name>.yaml and <out-dir>/_errors.txt (one line per
#   source that failed to render). Exits 0; callers decide what failure means.
#
# Source types handled, mirroring this repo's Applications:
#   - Helm repo chart (https:// index or OCI like ghcr.io/...), with
#     $values/... valueFiles from this repo, inline helm.values/valuesObject
#   - this repo's path with a Chart.yaml (cilium, argocd umbrella charts)
#   - this repo's path with kustomization.yaml (sops-kustomize-v1.0 plugin:
#     kustomize build --enable-helm, as the plugin does)
#   - this repo's path without kustomization.yaml (plain directory)
#   - another git repo's path at a tag (shallow clone)
#   - ref-only sources (they only supply $values) are skipped
#
# SOPS: CI has no key, so every *.sops.yaml in a scratch copy of the repo is
# replaced by a stub: the sops: block removed and each ENC[...] value turned
# into the string "ci-placeholder". Structure survives, secrets never exist.
#
# Needs: helm, kustomize, yq (mikefarah v4), git.
#
# KUBE_VERSION (default 1.35.0, the cluster's version) is passed to helm
# template as Argo CD passes the real one; charts gate on it. The cluster's
# API-version list is not, so charts that check .Capabilities.APIVersions
# may render a little less here than in the cluster.

set -uo pipefail
KUBE_VERSION=${KUBE_VERSION:-1.35.0}

OUT=${1:?usage: render-apps.sh <out-dir> [repo-root]}
ROOT=$(cd "${2:-.}" && pwd)
mkdir -p "$OUT"
OUT=$(cd "$OUT" && pwd)
ERRORS="$OUT/_errors.txt"
: > "$ERRORS"

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

# Scratch copy of the tracked tree, with SOPS files stubbed.
REPO="$WORK/repo"
mkdir -p "$REPO"
git -C "$ROOT" ls-files -z | (cd "$ROOT" && xargs -0 cp --parents -t "$REPO" 2>/dev/null)
while IFS= read -r -d '' f; do
  yq -i 'del(.sops) | (.. | select(tag == "!!str" and test("^ENC\["))) = "ci-placeholder"' "$f" \
    || echo "sops-stub: $f could not be parsed" >> "$ERRORS"
done < <(find "$REPO" -type f -name '*.sops.yaml' -print0)

render_path() { # dir app ns release valuefiles(newline list) inline-values-file
  local dir=$1 app=$2 ns=$3 rel=$4 vfs=$5 inline=$6
  if [ -f "$dir/Chart.yaml" ]; then
    local args=()
    while IFS= read -r v; do [ -n "$v" ] && args+=(-f "$dir/$v"); done <<< "$vfs"
    [ -s "$inline" ] && args+=(-f "$inline")
    helm dependency build "$dir" >/dev/null 2>&1 || helm dependency update "$dir" >/dev/null
    helm template "$rel" "$dir" -n "$ns" --kube-version "$KUBE_VERSION" "${args[@]}"
  elif [ -f "$dir/kustomization.yaml" ] || [ -f "$dir/kustomization.yml" ]; then
    (cd "$dir" && kustomize build --enable-helm .)
  else
    local f
    for f in "$dir"/*.yaml "$dir"/*.yml "$dir"/*.json; do
      [ -f "$f" ] || continue
      case $f in */app.yaml) continue ;; esac
      echo "---"; cat "$f"
    done
  fi
}

APPS=$(cd "$ROOT" && git ls-files 'kubernetes/*app.yaml' 'kubernetes/**/app.yaml' | sort -u)
for appfile in $APPS; do
  f="$REPO/$appfile"
  [ "$(yq '.kind' "$f")" = "Application" ] || continue
  app=$(yq '.metadata.name' "$f")
  ns=$(yq '.spec.destination.namespace // "default"' "$f")
  out="$OUT/$app.yaml"
  : > "$out"
  n=$(yq '(.spec.sources // [.spec.source]) | length' "$f")
  for ((i = 0; i < n; i++)); do
    # Separator between sources: without it the next source's first document
    # merges into the previous source's last one.
    echo "---" >> "$out"
    s=".spec.sources // [.spec.source] | .[$i]"
    repo=$(yq "$s | .repoURL" "$f")
    chart=$(yq "$s | .chart // \"\"" "$f")
    rev=$(yq "$s | .targetRevision // \"HEAD\"" "$f")
    path=$(yq "$s | .path // \"\"" "$f")
    rel=$(yq "$s | .helm.releaseName // \"$app\"" "$f")
    vfs=$(yq "$s | .helm.valueFiles // [] | .[]" "$f" | sed "s|^\\\$values/|$REPO/|")
    inline="$WORK/inline-$app-$i.yaml"
    yq "$s | .helm.valuesObject // {}" "$f" > "$inline"
    [ "$(yq "$s | has(\"helm\") and (.helm | has(\"values\"))" "$f")" = "true" ] \
      && yq "$s | .helm.values" "$f" > "$inline"
    [ "$(cat "$inline")" = "{}" ] && : > "$inline"

    if [ -n "$chart" ]; then
      args=()
      while IFS= read -r v; do [ -n "$v" ] && args+=(-f "$v"); done <<< "$vfs"
      [ -s "$inline" ] && args+=(-f "$inline")
      case $repo in
        http://*|https://*) src=(--repo "$repo" "$chart") ;;
        oci://*) src=("$repo/$chart") ;;
        *) src=("oci://$repo/$chart") ;;
      esac
      if ! helm template "$rel" "${src[@]}" --version "$rev" -n "$ns" --include-crds \
          --kube-version "$KUBE_VERSION" "${args[@]}" \
          >> "$out" 2> "$WORK/err"; then
        echo "$app: chart $chart@$rev: $(tail -3 "$WORK/err" | tr '\n' ' ')" >> "$ERRORS"
      fi
    elif [ -n "$path" ]; then
      if [[ $repo == *IonBlaster77/homelab* ]]; then
        dir="$REPO/$path"
        # Plain-directory sources use only this repo's $values (helm valueFiles
        # are relative to the chart dir for path-based charts).
        vfs=$(yq "$s | .helm.valueFiles // [] | .[]" "$f")
      else
        dir="$WORK/ext-$app-$i"
        if ! git clone -q --depth 1 --branch "$rev" "$repo" "$dir" 2> "$WORK/err"; then
          echo "$app: clone $repo@$rev: $(tail -1 "$WORK/err")" >> "$ERRORS"
          continue
        fi
        dir="$dir/$path"
      fi
      if ! render_path "$dir" "$app" "$ns" "$rel" "$vfs" "$inline" >> "$out" 2> "$WORK/err"; then
        echo "$app: path $path: $(tail -3 "$WORK/err" | tr '\n' ' ')" >> "$ERRORS"
      fi
    fi
  done
  echo "rendered $app ($(grep -c '^kind:' "$out") objects)"
done

echo "render errors: $(wc -l < "$ERRORS")"
exit 0
