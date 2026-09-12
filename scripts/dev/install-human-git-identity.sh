#!/bin/bash
# Install iliya git identity and strip Cursor/cloud attribution trailers.
# Cloud Agents inject Co-authored-by via commit-msg.cursor.co-author and commit
# as Cursor Agent. This script rewires that machine's hook path so later
# commits are iliya-only. Idempotent.
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
hook_src="$repo_root/scripts/dev/git-hooks"
name="iliya"
email="iliyazelenkog@gmail.com"

git -C "$repo_root" config --local user.name "$name"
git -C "$repo_root" config --local user.email "$email"
git -C "$repo_root" config --local commit.gpgsign false

hooks_path="$(git -C "$repo_root" config --get core.hooksPath || true)"
if [ -z "$hooks_path" ]; then
  hooks_path="$repo_root/.git/hooks"
fi
mkdir -p "$hooks_path"

install -m 0755 "$hook_src/commit-msg.cursor.zzz-strip-attribution" \
  "$hooks_path/commit-msg.cursor.zzz-strip-attribution"
install -m 0755 "$hook_src/post-commit.cursor.zzz-human-author" \
  "$hooks_path/post-commit.cursor.zzz-human-author"

if [ -f "$hooks_path/.dispatcher" ] && [ ! -e "$hooks_path/post-commit" ]; then
  ln -s .dispatcher "$hooks_path/post-commit"
elif [ ! -e "$hooks_path/post-commit" ]; then
  install -m 0755 "$hook_src/post-commit.cursor.zzz-human-author" "$hooks_path/post-commit"
fi

if [ -f "$hooks_path/commit-msg.cursor.co-author" ]; then
  printf '%s\n' '#!/bin/bash' 'exit 0' > "$hooks_path/commit-msg.cursor.co-author"
  chmod +x "$hooks_path/commit-msg.cursor.co-author"
fi

echo "git identity: $name <$email>"
echo "hooks: $hooks_path"
