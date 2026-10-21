---
feature: PROMPTS
stage: intent
status: accepted
branch: main
---

# Intent: the global agent prompt lives in the repo

## Problem

The global prompt was only in `$HOME`: `~/.claude/CLAUDE.md` and `~/.codex-seb/AGENTS.md`,
two byte-identical copies kept in sync by hand. It has no history, no diff, no review, and
a change to one copy silently diverges from the other. The `~/.ssh` rule added in
2026-09-18 was the trigger: a behavioural rule that matters is not something to leave
untracked in a home directory.

## Proposed outcome

`prompts/AGENT.md` in this repo is the single source. Both agents read it through a
symlink, so editing the repo file is immediately live in Claude Code and every Codex
profile, and the text is versioned like the rest of the tooling here.

## Affected users and systems

- Claude Code (`~/.claude/CLAUDE.md`) and every Codex profile (`$CODEX_HOME/AGENTS.md`);
  on this machine `~/.codex` and `~/.codex-midas` already symlink to `~/.codex-seb`.

## Non-goals

- Per-project `CLAUDE.md` / `AGENTS.md` files; this is only the global one.
- Templating, includes or per-agent variants - one file, both agents.

## Constraints

- The installed copies must stay identical for the two agents; drift is the failure mode
  being removed.
- Existing files must not be lost when they are replaced by the link.
