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
# WHAT COUNTS AS A SECRET
#   A line FAILS if its key *name* looks credential-bearing and it carries a
#   real inline value. The key match is case-insensitive and substring-based, so
#   POSTGRES_PASSWORD, SESSION_SECRET, NEXT_SERVER_ACTIONS_ENCRYPTION_KEY and
#   admin-token all match — not just a bare `password:`.
#   Connection strings that embed credentials (scheme://user:pass@host) also fail.
#
# WHAT IS IGNORED (not secrets)
#   - SOPS-encrypted files (ENC[AES256_GCM...] / a sops: block)
#   - empty values                e.g.  password: ""
#   - template / env references   e.g.  {{VAR}}, ${VAR}, $VAR, $__env{VAR}
#   - reference-style keys that name a secret rather than contain one:
#     secretName, secretKeyRef, existingSecret, privateKeySecretRef, ...
#   - vendored CRDs under clusters/homelab/gateway-api-crds/
#
set -euo pipefail

# Key names that indicate an actual credential value.
SECRET_KEY='(password|passwd|secret|token|apikey|api_key|privatekey|private_key|credential|passphrase|encryption_key|signing_key|[_.-]key|^key|crt)'

# Keys that merely *reference* a secret (or describe one) — never the value itself.
# A describing suffix (secretName, secretKeyRef, keySize), a referencing prefix
# (existingSecret, externalSecret), or a "which key inside the secret" pointer
# (passwordKey, tokenKey) — the latter names a lookup key, not a credential,
# unlike privateKey/apiKey which do hold values.
SAFE_KEY_SUFFIX='((name|ref|path|file|mount|type|id|enabled|engine|provider|namespace|generator|class|selector|policy|version|format|algorithm|length|rotation|expiry|expiration|ttl|size|count|usages)$|^(existing|external|use|has|is|enable)|(password|token|secret|username|user|admin)key$)'

# Credentials embedded in a URL: scheme://user:pass@host
CONN_STRING='[a-zA-Z][a-zA-Z0-9+.-]*://[^:/@[:space:]]+:[^@/[:space:]]+@'

# True if the value cannot be a real credential: empty, a template/env
# reference, a boolean/number, an empty structure, or an obvious fill-me-in
# placeholder (__DB_PASSWORD__, CHANGEME, YOUR_TOKEN_HERE, ...).
is_placeholder() {
  local v="$1"
  # Strip trailing YAML comment, surrounding whitespace, then quotes.
  v=$(printf '%s' "$v" | sed 's/[[:space:]]#.*$//; s/^[[:space:]]*//; s/[[:space:]]*$//')
  v=$(printf '%s' "$v" | tr -d "\"'")
  [ -z "$v" ] && return 0
  case "$v" in
    '{{'*|'${'*|'$'[A-Za-z_]*|'$__env'*) return 0 ;;   # {{VAR}} ${VAR} $VAR $__env{}
    '__'*'__') return 0 ;;                              # __DB_PASSWORD__ substitution marker
    '[]'|'{}'|null|Null|NULL|'~') return 0 ;;           # empty structure / explicit null
    true|false|True|False|TRUE|FALSE|yes|no|Yes|No) return 0 ;;  # boolean flags
  esac
  # Pure numbers (ports, sizes, TTLs) are never credentials.
  printf '%s' "$v" | grep -qE '^[0-9]+$' && return 0
  # Documented fill-me-in placeholders.
  printf '%s' "$v" | grep -qiE '^(changeme|change_me|replaceme|replace_me|todo|tbd|xxx+|your[_-])' && return 0
  return 1
}

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

  local bad=0 entry lineno content key value trimmed

  # 1) Credential-bearing key names with an inline value.
  while IFS= read -r entry; do
    lineno=${entry%%:*}
    content=${entry#*:}
    trimmed=$(printf '%s' "$content" | sed 's/^[[:space:]]*-\{0,1\}[[:space:]]*//')
    key=${trimmed%%:*}
    key=$(printf '%s' "$key" | tr -d "\"'")
    value=${trimmed#*:}

    # Skip keys that only point at a secret stored elsewhere.
    printf '%s' "$key" | grep -qiE "$SAFE_KEY_SUFFIX" && continue
    is_placeholder "$value" && continue

    printf '  %s:%s  %s\n' "$file" "$lineno" "$trimmed"
    bad=1
  done < <(grep -nEi "^[[:space:]]*-?[[:space:]]*\"?[A-Za-z0-9_.-]*${SECRET_KEY}[A-Za-z0-9_.-]*\"?[[:space:]]*:[[:space:]]+\S" "$file" 2>/dev/null || true)

  # 2) Connection strings with embedded credentials.
  while IFS= read -r entry; do
    lineno=${entry%%:*}
    content=${entry#*:}
    trimmed=$(printf '%s' "$content" | sed 's/^[[:space:]]*//')
    # Ignore when the credential portion is templated.
    printf '%s' "$trimmed" | grep -qE '://[^[:space:]]*(\{\{|\$\{|\$[A-Za-z_])' && continue
    printf '  %s:%s  %s\n' "$file" "$lineno" "$trimmed"
    bad=1
  done < <(grep -nE "$CONN_STRING" "$file" 2>/dev/null || true)

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
