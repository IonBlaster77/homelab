#!/usr/bin/env bash
#
# Repo-specific checks, each one from a real incident here. Advisory: every
# finding is a GitHub ::warning (or ::notice for reminders) plus a line in a
# markdown report; the exit code is the number of warnings capped at 1, so
# the workflow can choose to enforce later.
#
# Usage: repo-lint.sh <rendered-dir> <report.md> [base-ref]
#   <rendered-dir> comes from render-apps.sh (checks see chart output too).
#   [base-ref] enables the PR-only checks (what this change touches).
#
# Checks:
#   images      :latest or untagged images (decided: immutable tags only)
#   rwo         Deployment mounting a ReadWriteOnce PVC with a RollingUpdate
#               that surges (default 25%): the new pod can't attach the volume
#               while the old one holds it, so the rollout hangs. Recreate, or
#               RollingUpdate with maxSurge 0, is fine. (Switching an existing
#               Deployment from RollingUpdate to Recreate under Argo SSA keeps
#               the live rollingUpdate block and is rejected; prefer maxSurge 0
#               there.)
#   sops-name   SOPS-encrypted file under kubernetes/ not named *.sops.yaml
#               (the sops-kustomize plugin refuses to render the app;
#               bootstrap/ and talos/ are applied by hand, not by the plugin)
#   hermes-rev  Hermes skill / MCP config ConfigMap changed without bumping
#               its pod annotation (subPath mounts and the initContainer merge
#               never reach a running pod) [PR only]
#   vendored    umbrella chart (a Chart.yaml with charts/*.tgz committed, e.g.
#               cilium, argocd) whose archives don't match its dependencies:
#               Argo CD renders the committed .tgz as is, so a Chart.yaml /
#               Chart.lock bump without the new archive deploys nothing and
#               still shows Synced (#441, 2026-11-11). Fix: helm dependency
#               update, commit the new .tgz, delete the old one.
#   reminders   manual-sync apps (cilium, argocd) and Application YAML edits
#               (sync bootstrap-apps first) [PR only, notices]
#
# Needs: yq, git.

set -uo pipefail
DIR=${1:?usage: repo-lint.sh <rendered-dir> <report.md> [base-ref]}
REPORT=${2:?usage: repo-lint.sh <rendered-dir> <report.md> [base-ref]}
BASE=${3:-}
warnings=0
: > "$REPORT.items"

warn() { # check file line message
  local loc=""
  [ -n "$2" ] && loc=",file=$2${3:+,line=$3}"
  echo "::warning title=$1${loc}::$4"
  echo "- ⚠️ **$1**: $4${2:+ (\`$2${3:+:$3}\`)}" >> "$REPORT.items"
  warnings=$((warnings + 1))
}
notice() { # check message
  echo "::notice title=$1::$2"
  echo "- ℹ️ **$1**: $2" >> "$REPORT.items"
}
src_line() { # literal -> "file line" of its first occurrence in tracked YAML
  git grep -n -F -e "$1" -- 'kubernetes/*.yaml' ':!*.sops.yaml' 2>/dev/null | head -1 | awk -F: '{print $1, $2}'
}

WORKLOADS='select(.kind == "Deployment" or .kind == "StatefulSet" or .kind == "DaemonSet" or .kind == "Job" or .kind == "CronJob" or .kind == "Pod")'
PODSPEC='(.spec.jobTemplate.spec.template.spec // .spec.template.spec // .spec)'

# --- images ---------------------------------------------------------------
for f in "$DIR"/*.yaml; do
  app=$(basename "$f" .yaml)
  yq -N "$WORKLOADS | $PODSPEC | ((.initContainers // []) + (.containers // []))[] | .image" "$f" 2>/dev/null
done | sort -u | while IFS= read -r img; do
  [ -z "$img" ] || [ "$img" = "null" ] && continue
  ref=${img%@*}; tag=""
  [[ ${ref##*/} == *:* ]] && tag=${ref##*:}
  if [ -z "$tag" ] && [[ $img != *@sha256:* ]]; then
    read -r file line <<< "$(src_line "$img")"
    warn images "$file" "$line" "untagged image \`$img\` (pin a version)"
  elif [ "$tag" = "latest" ]; then
    read -r file line <<< "$(src_line "$img")"
    warn images "$file" "$line" "\`$img\` uses :latest (pin a version)"
  fi
done > "$DIR/_images.out"
cat "$DIR/_images.out"
warnings=$((warnings + $(grep -c '^::warning' "$DIR/_images.out")))
grep -h '^- ' "$DIR/_images.out" >/dev/null 2>&1 || true

# --- rwo ------------------------------------------------------------------
for f in "$DIR"/*.yaml; do
  # PVC names whose access modes are only ReadWriteOnce/ReadWriteOncePod.
  rwo=$(yq -N 'select(.kind == "PersistentVolumeClaim") | select([.spec.accessModes[] | select(. == "ReadWriteMany" or . == "ReadOnlyMany")] | length == 0) | .metadata.name' "$f" 2>/dev/null)
  yq -N -o=json -I=0 'select(.kind == "Deployment") | {"name": .metadata.name, "replicas": (.spec.replicas // 1), "strategy": (.spec.strategy // {}), "claims": [.spec.template.spec.volumes[]? | .persistentVolumeClaim.claimName | select(. != null)]}' "$f" 2>/dev/null |
  while IFS= read -r d; do
    name=$(yq -p=json '.name' <<< "$d")
    hit=""
    for c in $(yq -p=json '.claims[]' <<< "$d"); do
      grep -qx "$c" <<< "$rwo" && hit=$c
    done
    [ -n "$hit" ] || continue
    type=$(yq -p=json '.strategy.type // "RollingUpdate"' <<< "$d")
    surge=$(yq -p=json '.strategy.rollingUpdate.maxSurge // "25%"' <<< "$d")
    read -r file line <<< "$(git grep -n -E "^  name: $name\$" -- 'kubernetes/*.yaml' | head -1 | awk -F: '{print $1, $2}')"
    if [ "$type" != "Recreate" ] && [ "$surge" != "0" ] && [ "$surge" != "0%" ]; then
      warn rwo "$file" "$line" "Deployment \`$name\` mounts RWO PVC \`$hit\` with maxSurge $surge: the new pod can't attach the volume while the old one holds it. Use maxSurge: 0, maxUnavailable: 1"
    fi
  done
done > "$DIR/_rwo.out"
cat "$DIR/_rwo.out"
warnings=$((warnings + $(grep -c '^::warning' "$DIR/_rwo.out")))

# Subshell loops above can't append to the report; rebuild items from output.
for o in "$DIR/_images.out" "$DIR/_rwo.out"; do
  sed -n 's/^::warning title=\([^,:]*\)\(,file=\([^,:]*\)\(,line=\([0-9]*\)\)\{0,1\}\)\{0,1\}::\(.*\)$/- ⚠️ **\1**: \6 (`\3:\5`)/p' "$o" | sed 's/ (`:`)$//' >> "$REPORT.items"
done

# --- sops-name ------------------------------------------------------------
while IFS= read -r f; do
  case $f in *.sops.yaml) continue ;; esac
  warn sops-name "$f" "" "SOPS-encrypted but not named *.sops.yaml; the sops-kustomize plugin refuses to render it"
done < <(git grep -l -E '^sops:' -- 'kubernetes/*.yaml' 'kubernetes/*.yml' 2>/dev/null)

# --- vendored -------------------------------------------------------------
while IFS= read -r chartfile; do
  cdir=$(dirname "$chartfile")
  # Only charts that vendor their dependencies (archives committed in charts/).
  git ls-files -- "$cdir/charts/*.tgz" | grep -q . || continue
  while IFS=$'\t' read -r name want; do
    [ -z "$name" ] && continue
    lock=""
    [ -f "$cdir/Chart.lock" ] &&
      lock=$(yq -N ".dependencies[] | select(.name == \"$name\") | .version" "$cdir/Chart.lock" 2>/dev/null)
    if [ -n "$lock" ] && [ "$lock" != "$want" ]; then
      warn vendored "$cdir/Chart.lock" "" "\`$name\` is $want in Chart.yaml but $lock in Chart.lock; run \`helm dependency update $cdir\`"
    fi
    have=$(git ls-files -- "$cdir/charts/$name-*.tgz" | sed "s|^$cdir/charts/$name-||; s|\.tgz\$||" | grep -E '^[0-9]' | sort -V)
    if ! grep -qxF "$want" <<< "$have"; then
      warn vendored "$cdir/Chart.yaml" "" "\`$name\` $want is not vendored (charts/ has: ${have:-nothing}); Argo CD will render the old archive and show Synced. Run \`helm dependency update $cdir\`, commit the new .tgz and delete the old one"
    fi
    for v in $have; do
      [ "$v" = "$want" ] && continue
      warn vendored "$cdir/charts/$name-$v.tgz" "" "stale archive: Chart.yaml wants \`$name\` $want; delete \`$name-$v.tgz\`"
    done
  done < <(yq -N '.dependencies[] | [.name, .version] | @tsv' "$chartfile" 2>/dev/null)
done < <(git ls-files -- 'kubernetes/*Chart.yaml')

# --- PR-only checks -------------------------------------------------------
if [ -n "$BASE" ]; then
  changed=$(git diff --name-only "$BASE"...HEAD)
  dep=kubernetes/apps/ai/hermes/deployment.yaml
  if grep -q '^kubernetes/apps/ai/hermes/configmap-skill-' <<< "$changed" &&
     ! git diff "$BASE"...HEAD -- "$dep" | grep -q '^+.*hermes/skills-rev:'; then
    warn hermes-rev "$dep" "" "a Hermes skill ConfigMap changed but \`hermes/skills-rev\` was not bumped, so the running pod keeps the old skill"
  fi
  if grep -q '^kubernetes/apps/ai/hermes/configmap-mcp-servers.yaml' <<< "$changed" &&
     ! git diff "$BASE"...HEAD -- "$dep" | grep -q '^+.*hermes/config-fragment-rev:'; then
    warn hermes-rev "$dep" "" "configmap-mcp-servers.yaml changed but \`hermes/config-fragment-rev\` was not bumped, so the merged config.yaml keeps the old fragment"
  fi
  for app in cilium argocd; do
    if grep -qE "^kubernetes/platform/(networking|system)/$app/" <<< "$changed"; then
      notice manual-sync "$app is manual-sync: merging deploys nothing. Review \`argocd app diff $app\` and sync deliberately (never a blind full sync)"
    fi
  done
  for a in $(grep -E '(^|/)app\.yaml$' <<< "$changed"); do
    notice app-of-apps "\`$a\` is an Application's own YAML: sync \`bootstrap-apps\` first, then the app (its own Synced status is misleading until then)"
  done
fi

{
  echo "### Repo checks"
  echo
  if [ -s "$REPORT.items" ]; then sort -u "$REPORT.items"; else echo "No findings."; fi
  echo
} > "$REPORT"
rm -f "$REPORT.items"
echo "repo-lint warnings: $warnings"
[ "$warnings" -eq 0 ]
