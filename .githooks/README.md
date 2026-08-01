# Git hooks

Tracked hooks for this repo. Because Git never installs hooks automatically on
clone, each working copy must opt in **once**:

```bash
git config core.hooksPath .githooks
```

After that, `pre-commit` runs [`scripts/scan-secrets.sh`](../scripts/scan-secrets.sh)
on staged YAML and blocks commits that add unencrypted secrets.

## Enforcement model

| Layer | Scope | Bypassable |
|-------|-------|------------|
| `.githooks/pre-commit` | this clone, after the opt-in above | yes — `git commit --no-verify` |
| `.github/workflows/secret-scan.yml` | **every** push/PR on GitHub | no |

The local hook is fast feedback; the CI workflow is the real gate. Both call the
same script, so they enforce identical rules. To store a real secret, encrypt it
first: `sops --encrypt --in-place <file>`.
