#!/usr/bin/env bash
#
# Scan YAML for unencrypted secrets.
#
# Single source of truth shared by:
#   - the local pre-commit hook  (.githooks/pre-commit)
#   - CI                         (.github/workflows/secret-scan.yml)
# so a commit is rejected the same way locally and on the server.
#
# Usage:
#   scan-secrets.sh [file ...]   scan the given files (used by the hook)
#   scan-secrets.sh              scan every tracked *.yaml / *.yml (used by CI)
#
# A file FAILS if it contains a secret-like field with a real inline value and
# is not SOPS-encrypted. Ignored as non-secrets:
#   - SOPS-encrypted files (contain ENC[AES256_GCM...] / a sops: block)
#   - empty values            e.g.  password: ""
#   - template / env refs     e.g.  {{HOMEPAGE_VAR_X}}, ${VAR}, $VAR, $__env{X}
#   - vendored CRDs under clusters/homelab/gateway-api-crds/
#
set -euo pipefail

# Field names whose inline value would be an actual secret.
SECRET_FIELD='^[[:space:]]*(token|crt|password|secret|apiKey|api\.key|privateKey):[[:space:]]+\S'

# Returns 1 (and prints offending lines) if $1 holds an unencrypted secret.
check_file() {
  local file="$1"
  [ -f "$file" ] || return 0
  case "$file" in
    clusters/homelab/gateway-api-crds/*) return 0 ;;
  esac

  # SOPS-encrypted files are allowed to carry secret fields.
  if grep -q 'ENC\[AES256_GCM' "$file" 2>/dev/null || grep -q '^sops:' "$file" 2>/dev/null; then
    return 0
  fi

  local bad=0 entry lineno content value
  while IFS= read -r entry; do
    lineno=${entry%%:*}          # grep -n prefix
    content=${entry#*:}          # the source line
    value=${content#*:}          # text after the field's colon
    value=$(printf '%s' "$value" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')
    value=$(printf '%s' "$value" | tr -d "\"'")   # drop quotes so "" -> empty, "{{x}}" -> {{x}}
    [ -z "$value" ] && continue                   # empty value, not a secret
    case "$value" in
      '{{'*) continue ;;                          # {{ template }}
      '$'*)  continue ;;                          # $VAR / ${VAR} / $__env{...}
    esac
    printf '  %s:%s  %s\n' "$file" "$lineno" "$(printf '%s' "$content" | sed 's/^[[:space:]]*//')"
    bad=1
  done < <(grep -nE "$SECRET_FIELD" "$file" 2>/dev/null || true)

  return "$bad"
}

if [ "$#" -gt 0 ]; then
  files=("$@")
else
  mapfile -t files < <(git ls-files '*.yaml' '*.yml')
fi

FAILED=0
for f in "${files[@]}"; do
  case "$f" in
    *.yaml|*.yml) ;;
    *) continue ;;
  esac
  if ! check_file "$f"; then
    [ "$FAILED" -eq 0 ] && echo "Unencrypted secrets detected:"
    FAILED=1
  fi
done

if [ "$FAILED" -ne 0 ]; then
  echo ""
  echo "Commit blocked. Encrypt sensitive files with SOPS before committing:"
  echo "  sops --encrypt --in-place <file>"
  exit 1
fi

exit 0
