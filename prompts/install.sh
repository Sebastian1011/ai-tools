#!/usr/bin/env bash
# Point the global prompt of Claude Code and Codex at prompts/AGENT.md in this
# repo, so the text is versioned in one place instead of living only in $HOME.
#
#   ./install.sh [--claude] [--codex] [--codex-home PATH]... [--check]
#
# --codex-home is repeatable, for machines running several Codex profiles. With
# none given, $CODEX_HOME is used (else ~/.codex). --check only reports drift.
#
# The targets become symlinks, so editing prompts/AGENT.md is immediately live
# in both agents - and moving or deleting this repo takes the prompt with it.
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROMPT="$SRC/AGENT.md"

do_claude=0 do_codex=0 check_only=0
codex_homes=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --claude) do_claude=1 ;;
    --codex) do_codex=1 ;;
    --check) check_only=1 ;;
    --codex-home)
      [[ $# -ge 2 ]] || { echo "--codex-home needs a path" >&2; exit 2; }
      do_codex=1
      codex_homes+=("$2")
      shift
      ;;
    *) echo "usage: $0 [--claude] [--codex] [--codex-home PATH]... [--check]" >&2; exit 2 ;;
  esac
  shift
done
if [[ $do_claude -eq 0 && $do_codex -eq 0 ]]; then
  do_claude=1 do_codex=1
fi
if [[ ${#codex_homes[@]} -eq 0 ]]; then
  codex_homes=("${CODEX_HOME:-$HOME/.codex}")
fi

[[ -f "$PROMPT" ]] || { echo "missing $PROMPT" >&2; exit 1; }

drift=0

# link <target>
link() {
  local target="$1"
  if [[ $check_only -eq 1 ]]; then
    if [[ -L "$target" && "$(readlink -f "$target")" == "$(readlink -f "$PROMPT")" ]]; then
      echo "ok      $target"
    elif [[ -e "$target" ]] && diff -q "$target" "$PROMPT" >/dev/null 2>&1; then
      echo "ok      $target (copy, same content)"
    else
      echo "DRIFT   $target"
      drift=1
    fi
    return
  fi
  mkdir -p "$(dirname "$target")"
  if [[ -e "$target" && ! -L "$target" ]]; then
    cp -p "$target" "$target.ai-tools.bak"
    echo "backed up $target -> $target.ai-tools.bak"
  fi
  ln -sfnT "$PROMPT" "$target"
  echo "linked $target -> $PROMPT"
}

[[ $do_claude -eq 1 ]] && link "$HOME/.claude/CLAUDE.md"

if [[ $do_codex -eq 1 ]]; then
  for CODEX_HOME in "${codex_homes[@]}"; do
    CODEX_HOME="${CODEX_HOME/#\~/$HOME}"
    if [[ ! -d "$CODEX_HOME" ]]; then
      echo "warning: $CODEX_HOME does not exist - skipping" >&2
      continue
    fi
    link "$CODEX_HOME/AGENTS.md"
  done
fi

if [[ $check_only -eq 1 ]]; then
  exit $drift
fi

echo
echo "The prompt now lives in the repo; moving or deleting it breaks these links."
echo "Restart running Claude Code / Codex sessions to pick up the change."
