# AGENT.md

Behavioral guidelines to reduce common LLM coding mistakes. Merge with project-specific instructions as needed.

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

## 5. Change Artifact Chain

Non-trivial changes leave artifacts in the project repo under `docs/features/<FEATURE-ID>/`.
Two of the four are committed; two are session-local.

- `intent.md` (what and why) and `spec.md` (requirements and design) are **committed** —
  they outlive the session and are the reviewable, diffable, traceable record.
- `plan.md` (files touched, order of work, risks, how it is verified) and `evidence.md`
  (raw verification output) **exist to drive the current session's execution and
  verification, and are never committed.** They sit in the same directory, kept out of git
  by `docs/features/*/plan.md` and `docs/features/*/evidence.md` in `.gitignore`.

- Once a plan mode plan is approved, land it in `plan.md`. Don't leave it in the session.
- When the implementation departs from `plan.md`, update `plan.md` in place and say so in
  the session report — no commit carries that record, so the report is it.
- `evidence.md` holds raw command output, never a paraphrase. For bug fixes, write the
  failing test first and keep both the before and the after output. Whatever a reviewer
  needs belongs in the commit message or PR body, since the file itself is never pushed.
- Architectural decisions go in `docs/decisions/ADR-NNN-*.md`, not buried in `spec.md`.
- Keep `docs/features/` from exploding: when several directories cover one functional area,
  merge them with `/feat-compact` into a single `docs/features/<AREA>/`.
- Typos, formatting, dependency bumps and similar trivia skip the chain; a clear commit
  message is enough.

See the `feature-artifacts` skill for the rules and templates, `feat-compact` for compaction.

---

**These guidelines are working if:** fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions come before implementation rather than after mistakes.

---

## Working Style, Tool Using Guidelines

## Git history
Git history is part of the project context and can be used to understand why existing code, behavior, constraints, or workarounds were introduced.

When modifying existing code:
- Check relevant `git log` history when the design intent is unclear.
- Use `git blame` to locate the commit that introduced specific logic.
- Use `git show <commit>` to understand the original reason and trade-offs.
- Treat current code and documentation as authoritative; use Git history mainly to recover historical intent and avoid accidentally removing intentional behavior.

###  Working Style

- Make reasonable assumptions instead of asking for confirmation.
- Only ask questions when a missing detail would likely cause incorrect results.
- If there are multiple acceptable approaches, choose the most conventional one and explain your choice afterwards.
- Complete the task end-to-end whenever possible.
- Batch related actions instead of asking for permission between each step.
- If `gh auth` appears to fail, first suspect incorrect usage or sandbox/environment restrictions. The local GitHub authentication is likely still valid. Do not suggest re-authentication unless there is clear evidence that the local credentials are actually expired or invalid.

### When operating within the company network:

- Services at `192.168.100.100` and `47.100.117.89` are read-only by default. HTTP `GET` and `OPTIONS` need no approval.
- Anything that may create, modify, delete, trigger, submit, upload, restart, or otherwise change server-side state MUST have explicit user authorization first. Ask, and wait for approval.
- When uncertain whether an operation is read-only, treat it as a write.
- The `intranet-guard` hook blocks the obvious cases, but it only inspects shell commands and a subset of MCP servers. A script that POSTs, or a tool on an unmatched server, is on your judgment. Never read "the hook did not block it" as authorization.

### SSH hosts

Never read, list or grep anything under `~/.ssh`. Use the host alias the user gave you as
given, without probing it first (no `ssh -G`); if it fails to resolve or connect, report
that error verbatim.

###  Browser tool routing

Two browser backends are available: `chrome-devtools` (local debugging, authenticated
interactive browsing) and `obscura` (public extraction, crawling, batch automation).
Before the first browser tool call, classify the task as one of DEBUG,
AUTHENTICATED_INTERACTIVE, PUBLIC_EXTRACTION, or BATCH_CRAWL, and load the
`browser-routing` skill to pick the backend by its policy.
