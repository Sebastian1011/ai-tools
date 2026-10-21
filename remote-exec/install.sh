#!/usr/bin/env bash
# Install the remote-exec skill, its reviewer subagent and its PreToolUse guard
# into Claude Code and/or Codex.
#
#   ./install.sh [--claude] [--codex] [--codex-home PATH]...   (default: both)
#
# --codex-home is repeatable, for machines running several Codex profiles. With
# none given, $CODEX_HOME is used (else ~/.codex).
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLAUDE_HOME="$HOME/.claude"
RULES_DIR="$CLAUDE_HOME/remote-exec"
RULES="$RULES_DIR/rules.toml"

if [[ $EUID -eq 0 ]]; then
  echo "run install.sh as your normal user, not root" >&2
  exit 1
fi

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

command -v python3 >/dev/null || { echo "python3 not found" >&2; exit 1; }
python3 - <<'EOF' || { echo "python3 >= 3.11 required (tomllib)" >&2; exit 1; }
import sys; sys.exit(0 if sys.version_info >= (3, 11) else 1)
EOF
python3 -m py_compile "$SRC/hooks/remote-exec-guard.py"
rm -rf "$SRC/hooks/__pycache__"

# ------------------------------------------------------- shared rule file ----
mkdir -p "$RULES_DIR"
if [[ -e "$RULES" ]]; then
  echo "keeping existing $RULES"
else
  install -m 0644 "$SRC/config/rules.example.toml" "$RULES"
  echo "installed $RULES (built-in policy only; edit to extend it)"
fi

# ------------------------------------------------------------- Claude Code ---
if [[ $do_claude -eq 1 ]]; then
  mkdir -p "$CLAUDE_HOME/skills" "$CLAUDE_HOME/agents" "$CLAUDE_HOME/hooks"

  target="$CLAUDE_HOME/skills/remote-exec"
  if [[ -e "$target" && ! -L "$target" ]]; then
    echo "skipping $target: exists and is not a symlink (not overwriting)" >&2
  else
    ln -sfnT "$SRC/skills/remote-exec" "$target"
    echo "linked $target -> $SRC/skills/remote-exec"
  fi

  install -m 0644 "$SRC/agents/remote-exec-reviewer.md" "$CLAUDE_HOME/agents/remote-exec-reviewer.md"
  echo "installed $CLAUDE_HOME/agents/remote-exec-reviewer.md"

  install -m 0755 "$SRC/hooks/remote-exec-guard.py" "$CLAUDE_HOME/hooks/remote-exec-guard.py"
  echo "installed $CLAUDE_HOME/hooks/remote-exec-guard.py"

  python3 - "$CLAUDE_HOME/settings.json" <<'PY'
import json, os, shutil, sys

path = sys.argv[1]
settings = {}
if os.path.exists(path):
    shutil.copy2(path, path + ".remote-exec.bak")
    with open(path) as fh:
        settings = json.load(fh)

hook_cmd = 'python3 "$HOME/.claude/hooks/remote-exec-guard.py"'
pre = settings.setdefault("hooks", {}).setdefault("PreToolUse", [])
entry = next((m for m in pre if m.get("matcher") == "Bash"), None)
if entry is None:
    entry = {"matcher": "Bash", "hooks": []}
    pre.append(entry)
# Additive: other guards registered on the same matcher stay where they are.
if not any(h.get("command") == hook_cmd for h in entry.setdefault("hooks", [])):
    entry["hooks"].append({
        "type": "command",
        "command": hook_cmd,
        "statusMessage": "Checking remote command review...",
    })

with open(path, "w") as fh:
    json.dump(settings, fh, indent=2)
    fh.write("\n")
print(f"updated {path} (backup: {path}.remote-exec.bak)")
PY
fi

# ------------------------------------------------------------------ Codex ----
for CODEX_HOME in "${codex_homes[@]}"; do
  [[ $do_codex -eq 1 ]] || break
  CODEX_HOME="${CODEX_HOME/#\~/$HOME}"
  echo
  echo "Codex profile: $CODEX_HOME"
  if [[ ! -d "$CODEX_HOME" ]]; then
    echo "warning: $CODEX_HOME does not exist - skipping" >&2
  else
    mkdir -p "$CODEX_HOME/skills" "$CODEX_HOME/agents" "$CODEX_HOME/hooks"

    target="$CODEX_HOME/skills/remote-exec"
    if [[ -e "$target" && ! -L "$target" ]]; then
      echo "skipping $target: exists and is not a symlink (not overwriting)" >&2
    else
      ln -sfnT "$SRC/skills/remote-exec" "$target"
      echo "linked $target -> $SRC/skills/remote-exec"
    fi

    install -m 0644 "$SRC/agents/remote-exec-reviewer.md" "$CODEX_HOME/agents/remote-exec-reviewer.md"
    echo "installed $CODEX_HOME/agents/remote-exec-reviewer.md"

    install -m 0755 "$SRC/hooks/remote-exec-guard.py" "$CODEX_HOME/hooks/remote-exec-guard.py"
    echo "installed $CODEX_HOME/hooks/remote-exec-guard.py"

    python3 - "$CODEX_HOME/hooks.json" "$CODEX_HOME" <<'PY'
import json, os, shutil, sys

path, codex_home = sys.argv[1], sys.argv[2]
config = {}
if os.path.exists(path):
    shutil.copy2(path, path + ".remote-exec.bak")
    with open(path) as fh:
        config = json.load(fh)

hook_cmd = f'python3 "{os.path.join(codex_home, "hooks", "remote-exec-guard.py")}"'
# Same shape as ~/.claude/settings.json: the events live under "hooks". No
# matcher: Codex runs PreToolUse for its shell tools only, and the tool name
# differs per build, so matching on one name would silently skip the guard.
pre = config.setdefault("hooks", {}).setdefault("PreToolUse", [])
entry = next((m for m in pre if "matcher" not in m), None)
if entry is None:
    entry = {"hooks": []}
    pre.append(entry)
if not any(h.get("command") == hook_cmd for h in entry.setdefault("hooks", [])):
    entry["hooks"].append({
        "type": "command",
        "command": hook_cmd,
        "timeout": 10,
        "statusMessage": "Checking remote command review...",
    })

with open(path, "w") as fh:
    json.dump(config, fh, indent=2)
    fh.write("\n")
suffix = f" (backup: {path}.remote-exec.bak)" if os.path.exists(path + ".remote-exec.bak") else ""
print(f"updated {path}{suffix}")
PY

    # Codex only runs hooks when the feature flag is on.
    python3 - "$CODEX_HOME/config.toml" <<'PY'
import os, re, shutil, sys, tomllib

path = sys.argv[1]
text = ""
if os.path.exists(path):
    with open(path) as fh:
        text = fh.read()
    try:
        config = tomllib.loads(text)
    except tomllib.TOMLDecodeError as exc:
        print(f"warning: {path} does not parse ({exc}); set [features].hooks = true yourself", file=sys.stderr)
        raise SystemExit(0)
    if config.get("features", {}).get("hooks") is True:
        print(f"{path}: [features].hooks already true")
        raise SystemExit(0)
    shutil.copy2(path, path + ".remote-exec.bak")

if re.search(r"^\[features\]\s*$", text, re.MULTILINE):
    text = re.sub(r"^\[features\]\s*$", "[features]\nhooks = true", text, count=1, flags=re.MULTILINE)
else:
    if text and not text.endswith("\n"):
        text += "\n"
    text += "\n[features]\nhooks = true\n"

with open(path, "w") as fh:
    fh.write(text)
print(f"enabled [features].hooks in {path}")
PY

    # Codex 0.154 does not run PreToolUse hooks in `codex exec`, so the
    # execution-layer rules are the Codex-side deterministic floor.
    mkdir -p "$CODEX_HOME/rules"
    install -m 0644 "$SRC/agents/codex/remote-exec.rules" "$CODEX_HOME/rules/remote-exec.rules"
    echo "installed $CODEX_HOME/rules/remote-exec.rules"
    if command -v codex >/dev/null; then
      "$SRC/tests/test_codex_rules.sh" >/dev/null 2>&1 \
        || echo "warning: codex rule verification failed (run tests/test_codex_rules.sh)" >&2

      # Codex loads a fresh hook but skips it while it is untrusted. Record the
      # trust Codex itself computes, then verify it took.
      "$SRC/scripts/codex-trust-hook.py" "$CODEX_HOME" \
        || echo "warning: the guard hook is not active in $CODEX_HOME" >&2
    else
      echo "warning: codex not on PATH - hook trust not recorded, so the guard" >&2
      echo "         will be loaded but skipped. Re-run install.sh with codex available." >&2
    fi

    echo
    echo "Codex notes:"
    echo "  - The guard hook runs the same policy as on Claude Code. Codex skips a"
    echo "    hook until it is trusted, so the installer records the trust entry in"
    echo "    config.toml and verifies it. The hash covers the handler command line,"
    echo "    not the script body, so editing the policy does not need re-trusting."
    echo "  - rules/remote-exec.rules is a second, coarser layer: every"
    echo "    ssh/scp/sftp/rsync/ansible command also surfaces for approval."
  fi
done

echo
echo "Self-test:"
"$SRC/tests/test_hook.sh" >/dev/null 2>&1 && echo "  hook policy tests: pass" || echo "  hook policy tests: FAIL (run tests/test_hook.sh)" >&2
"$SRC/tests/test_rules.sh" >/dev/null 2>&1 && echo "  rule file tests:   pass" || echo "  rule file tests:   FAIL (run tests/test_rules.sh)" >&2

echo
echo "Restart running Claude Code / Codex sessions to pick up the skill, the"
echo "reviewer subagent and the hook."
