#!/usr/bin/env bash
# Remove what install.sh added. Keeps ~/.claude/remote-exec/rules.toml - that
# file is the user's own policy, not ours.
#
#   ./uninstall.sh [--claude] [--codex] [--codex-home PATH]...   (default: both)
#
# --codex-home is repeatable, for machines running several Codex profiles. With
# none given, $CODEX_HOME is used (else ~/.codex).
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLAUDE_HOME="$HOME/.claude"

do_claude=0 do_codex=0
codex_homes=()
if [[ $# -eq 0 ]]; then
  do_claude=1 do_codex=1
else
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --claude) do_claude=1 ;;
      --codex) do_codex=1 ;;
      --codex-home)
        [[ $# -ge 2 ]] || { echo "--codex-home needs a path" >&2; exit 2; }
        do_codex=1
        codex_homes+=("$2")
        shift
        ;;
      *) echo "usage: $0 [--claude] [--codex] [--codex-home PATH]..." >&2; exit 2 ;;
    esac
    shift
  done
fi
if [[ ${#codex_homes[@]} -eq 0 ]]; then
  codex_homes=("${CODEX_HOME:-$HOME/.codex}")
fi

unlink_skill() {
  local target="$1"
  if [[ -L "$target" ]] && [[ "$(readlink -f "$target")" == "$SRC/skills/remote-exec" ]]; then
    rm "$target"
    echo "removed $target"
  elif [[ -e "$target" ]]; then
    echo "skipping $target: not a symlink to this repo (leaving it alone)" >&2
  fi
}

remove_file() {
  local target="$1"
  if [[ -e "$target" ]]; then
    rm "$target"
    echo "removed $target"
  fi
}

# Drop our hook entry from a hook config, leaving every other hook on the same
# matcher untouched. ~/.claude/settings.json and a Codex profile's hooks.json
# share the shape: the events sit under a top-level "hooks" key.
deregister() {
  local path="$1"
  [[ -e "$path" ]] || return 0
  python3 - "$path" <<'PY'
import json, sys

path = sys.argv[1]
with open(path) as fh:
    config = json.load(fh)

root = config.get("hooks", {})
pre = root.get("PreToolUse", [])
removed = False
for entry in list(pre):
    hooks = entry.get("hooks", [])
    keep = [h for h in hooks if "remote-exec-guard.py" not in str(h.get("command", ""))]
    if len(keep) != len(hooks):
        removed = True
        entry["hooks"] = keep
    if not entry.get("hooks"):
        pre.remove(entry)
if not pre:
    root.pop("PreToolUse", None)
if not config.get("hooks"):
    config.pop("hooks", None)

if removed:
    with open(path, "w") as fh:
        json.dump(config, fh, indent=2)
        fh.write("\n")
    print(f"deregistered the guard in {path}")
else:
    print(f"no guard entry in {path}")
PY
}

# Drop the hook trust entry this Codex profile recorded in config.toml. The
# file may be shared between profiles, so only this profile's key is removed.
untrust() {
  local home="$1"
  [[ -e "$home/config.toml" ]] || return 0
  python3 - "$home/config.toml" "$home" <<'PY'
import re, sys, tomllib

config_path, home = sys.argv[1], sys.argv[2]
with open(config_path) as fh:
    text = fh.read()

pattern = re.compile(
    r'\n\[hooks\.state\."' + re.escape(home) + r'/hooks\.json:[^"]*"\]\n(?:[^\[\n][^\n]*\n|\n)*',
    re.MULTILINE,
)
if not pattern.search(text):
    raise SystemExit(0)

text = pattern.sub("\n", text)
tomllib.loads(text)
with open(config_path, "w") as fh:
    fh.write(text)
print(f"removed the hook trust entry for {home} from {config_path}")
PY
}

if [[ $do_claude -eq 1 ]]; then
  unlink_skill "$CLAUDE_HOME/skills/remote-exec"
  remove_file "$CLAUDE_HOME/agents/remote-exec-reviewer.md"
  remove_file "$CLAUDE_HOME/hooks/remote-exec-guard.py"
  deregister "$CLAUDE_HOME/settings.json"
fi

for CODEX_HOME in "${codex_homes[@]}"; do
  [[ $do_codex -eq 1 ]] || break
  CODEX_HOME="${CODEX_HOME/#\~/$HOME}"
  echo
  echo "Codex profile: $CODEX_HOME"
  unlink_skill "$CODEX_HOME/skills/remote-exec"
  remove_file "$CODEX_HOME/agents/remote-exec-reviewer.md"
  remove_file "$CODEX_HOME/hooks/remote-exec-guard.py"
  remove_file "$CODEX_HOME/rules/remote-exec.rules"
  deregister "$CODEX_HOME/hooks.json"
  untrust "$CODEX_HOME"
done

echo
echo "Kept $CLAUDE_HOME/remote-exec/rules.toml - delete it yourself if you want it gone."
echo "Left [features].hooks in the Codex config.toml alone; it is not ours to turn off."
