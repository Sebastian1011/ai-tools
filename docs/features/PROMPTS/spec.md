---
feature: PROMPTS
stage: spec
status: accepted
branch: main
---

# Spec: prompts

## Requirements

1. `prompts/AGENT.md` holds the global prompt for both agents, verbatim - no per-agent text.
2. `prompts/install.sh [--claude] [--codex] [--codex-home PATH]... [--check]` points
   `~/.claude/CLAUDE.md` and each `$CODEX_HOME/AGENTS.md` at that file. No flags means both
   agents; `--codex-home` is repeatable, matching `remote-exec/install.sh`.
3. A target that exists and is not already a symlink is backed up to `<file>.ai-tools.bak`
   before being replaced.
4. `--check` writes nothing and exits non-zero when any target is neither the symlink nor a
   byte-identical copy, so drift is detectable in one command.

## Design

- **Symlink, not copy.** The same choice the skills here make: zero drift, and an edit to
  the repo file is live without a re-install. The cost - moving or deleting the repo takes
  the prompt with it - is stated by the installer and in `README.md`.
- **One file for three Codex profiles.** `~/.codex` and `~/.codex-midas` already resolve
  `AGENTS.md` to `~/.codex-seb/AGENTS.md`, so linking that one path covers all three;
  `--codex-home` can still be given per profile.
- **No uninstaller.** Restoring means pointing the path back at the `.ai-tools.bak` copy,
  which the installer prints when it makes one.

## Verification

- `prompts/install.sh --check` reports drift before installing and none after.
- `readlink -f` on each target resolves to `prompts/AGENT.md`.
- The repo copy differs from the pre-existing `~/.claude/CLAUDE.md` only by the new
  `### SSH hosts` section (recorded in `docs/features/REMOTE-EXEC/evidence.md`).
