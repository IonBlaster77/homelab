#!/usr/bin/env bash
#
# Render every app at a base ref and at the working tree, and write a
# markdown report of what each changed app's rendered manifests look like
# before and after. This is the "what will Argo CD actually apply" view of a
# PR: a chart bump that changes nothing shows as no diff, a values change
# shows the exact objects it touches.
#
# Usage: render-diff.sh <base-ref> <report.md> [full-diff-file]
#   Needs render-apps.sh's tools plus git. Run from the repo root.
#   HEAD_RENDERED=<dir> reuses an existing render-apps.sh output for this tree.
#
# Secret and ConfigMap-style noise: Secret data/stringData values are replaced
# with "<redacted>" in both renders (charts that generate random passwords
# would otherwise diff on every run, and nothing secret-shaped should land in
# a PR comment). The comment is capped at MAX_COMMENT chars; the full diff
# goes to [full-diff-file] for the job summary / artifact.

set -uo pipefail
BASE=${1:?usage: render-diff.sh <base-ref> <report.md> [full-diff-file]}
REPORT=${2:?usage: render-diff.sh <base-ref> <report.md> [full-diff-file]}
FULL=${3:-/dev/null}
MAX_COMMENT=${MAX_COMMENT:-60000}
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(git rev-parse --show-toplevel)

WORK=$(mktemp -d)
trap 'git -C "$ROOT" worktree remove --force "$WORK/base-tree" >/dev/null 2>&1; rm -rf "$WORK"' EXIT

git -C "$ROOT" worktree add -q --detach "$WORK/base-tree" "$BASE"
bash "$HERE/render-apps.sh" "$WORK/base" "$WORK/base-tree" > "$WORK/base.log" 2>&1
if [ -n "${HEAD_RENDERED:-}" ]; then
  # Reuse a render of this tree made earlier in the same job.
  cp -r "$HEAD_RENDERED" "$WORK/head"
else
  bash "$HERE/render-apps.sh" "$WORK/head" "$ROOT" > "$WORK/head.log" 2>&1
fi
for t in base head; do
  ls "$WORK/$t"/*.yaml >/dev/null 2>&1 || { echo "render of $t produced nothing:"; tail -5 "$WORK/$t.log"; exit 1; }
done

normalize() { # file -> stdout, secrets redacted, comments dropped
  yq '(select(.kind == "Secret") | (.data, .stringData) | select(. != null) | .[]) = "<redacted>" | ... comments=""' "$1" 2>/dev/null || cat "$1"
}

changed=() ; added=() ; removed=()
for f in "$WORK"/head/*.yaml "$WORK"/base/*.yaml; do
  app=$(basename "$f" .yaml)
  case " ${changed[*]} ${added[*]} ${removed[*]} " in *" $app "*) continue ;; esac
  if [ ! -f "$WORK/base/$app.yaml" ]; then added+=("$app"); continue; fi
  if [ ! -f "$WORK/head/$app.yaml" ]; then removed+=("$app"); continue; fi
  normalize "$WORK/base/$app.yaml" > "$WORK/b.yaml"
  normalize "$WORK/head/$app.yaml" > "$WORK/h.yaml"
  if ! diff -q "$WORK/b.yaml" "$WORK/h.yaml" >/dev/null; then
    changed+=("$app")
    diff -u --label "$app (base)" --label "$app (PR)" "$WORK/b.yaml" "$WORK/h.yaml" > "$WORK/diff-$app.txt"
  fi
done

{
  echo "<!-- render-diff -->"
  echo "## Rendered manifest diff"
  echo
  echo "What Argo CD would apply, rendered at \`$(git -C "$ROOT" rev-parse --short "$BASE")\` (base) and this PR. Secret values are redacted. Advisory only."
  echo
  if [ ${#changed[@]} -eq 0 ] && [ ${#added[@]} -eq 0 ] && [ ${#removed[@]} -eq 0 ]; then
    echo "**No rendered changes.** Nothing Argo CD applies would change (a version bump that only moves labels, or a docs/CI-only PR)."
  fi
  for app in "${added[@]}"; do echo "- **$app**: new app ($(grep -c '^kind:' "$WORK/head/$app.yaml") objects)"; done
  for app in "${removed[@]}"; do echo "- **$app**: app removed"; done
  for app in "${changed[@]}"; do
    d="$WORK/diff-$app.txt"
    echo "- **$app**: +$(grep -c '^+[^+]' "$d") / -$(grep -c '^-[^-]' "$d") lines"
  done
  for log in base head; do
    if [ -s "$WORK/$log/_errors.txt" ]; then
      echo
      echo "**Render errors ($log):**"
      sed 's/^/- /' "$WORK/$log/_errors.txt"
    fi
  done
  echo
} > "$WORK/head.md"

{
  cat "$WORK/head.md"
  for app in "${changed[@]}"; do
    echo "<details><summary>$app</summary>"
    echo
    echo '```diff'
    cat "$WORK/diff-$app.txt"
    echo '```'
    echo "</details>"
  done
} > "$FULL"

cp "$WORK/head.md" "$REPORT"
for app in "${changed[@]}"; do
  block=$(printf '<details><summary>%s</summary>\n\n```diff\n%s\n```\n</details>\n' "$app" "$(cat "$WORK/diff-$app.txt")")
  if [ $(( $(wc -c < "$REPORT") + ${#block} )) -lt "$MAX_COMMENT" ]; then
    printf '%s\n' "$block" >> "$REPORT"
  else
    echo "<details><summary>$app</summary>Diff too large for a comment: see the job summary / render-diff artifact.</details>" >> "$REPORT"
  fi
done
echo "changed=${#changed[@]} added=${#added[@]} removed=${#removed[@]}"
