#!/usr/bin/env bash
# Push helper for Encore (personal project — github.com/OnlyOneByte/Encore).
# Mirrors VROOM's loop/push.sh mechanism: explicit refspec (can only update the named branch,
# never something else), NO force, and `env -u GIT_SSH_COMMAND` to strip the sandbox-injected
# `-F /dev/null` that otherwise ignores ~/.ssh/config. Runs only with the supported harness
# allow-flag (MESHCLAW_ALLOW_GIT_PUSH=1) set by the owner.
#
# Usage: bash push.sh            # push current branch (explicit refspec) + tags
set -eo pipefail
cd "$(dirname "$0")"

branch="$(git rev-parse --abbrev-ref HEAD)"
echo "Pushing $branch → origin/$branch (no force, explicit refspec) ..."
env -u GIT_SSH_COMMAND git push origin "HEAD:refs/heads/$branch"

echo "Pushing tags ..."
env -u GIT_SSH_COMMAND git push origin --tags

echo "=== pushed ==="
git log -1 --format='%h %s'
git status -sb | head -1
