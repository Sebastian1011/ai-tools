---
name: remote-exec
description: Run commands on remote machines over SSH with a security review in front of every execution. Use whenever a task needs something executed on another host, or files fetched from one - checking a remote service, reading remote logs, copying a file off a server, restarting something on a box reached through an ssh host alias.
---

# Remote execution over SSH

Connection settings are not your problem: hosts, users, keys and ports live in
`~/.ssh/config`, so you only ever name a host **alias**. What is your problem is
that nothing runs on a remote machine until it has been classified, and anything
risky has been confirmed by the user.

```
remote-exec request
        ↓
remote-exec-reviewer subagent   ← reads references/policy.md + ~/.claude/remote-exec/rules.toml
        ↓
     classify
  ┌─────┴─────┐
safe        risky
  │            │
execute     ask user
               │
           confirmed?
           ┌───┴───┐
          yes      no
           │        │
        execute   abort
```

A `deny` verdict is neither branch: report it and stop, without asking the user
to approve it.

## 1. Build one command

- One invocation per request: `ssh <alias> -- <command>`, `scp`, `sftp` or
  `rsync`. Do not chain separate remote operations with `&&`, `;` or pipes -
  they get reviewed and confirmed separately.
- Never run `ssh <alias>` with no command; an interactive session cannot be
  reviewed, and the guard blocks it.
- Use the alias the user gave you exactly as given. Do not probe it first
  (`ssh -G`), do not read `~/.ssh` - config, keys and known_hosts are off-limits
  and the guard hook blocks them - and do not invent connection flags (`-i`,
  `-p`, `-o …`). If the alias does not resolve or the connection fails, report
  that error verbatim and stop.
- Keep the remote command literal. If it needs a script, send it as
  `ssh <alias> bash -s <<'EOF' … EOF` and show the body in full to the reviewer -
  not a summary of it. The body is then reviewed as the remote command, so a
  read-only script needs no confirmation.
- **Quote the heredoc marker**: `<<'EOF'`, never `<<EOF`. Unquoted, the local
  shell expands `$VAR` and `$(…)` in the body before it is sent, so what was
  reviewed is not what runs - the guard treats such a body as unreadable and
  makes the whole thing risky. For the same reason, do not feed the script in
  with `< file` or `cat file | ssh …`; put it in the heredoc.

## 2. Review it

Spawn the **`remote-exec-reviewer`** subagent - one per command, before the
command runs - with exactly this payload:

```
host: <ssh alias>
tool: ssh | scp | sftp | rsync
command: <the verbatim remote command text, including any script body>
intent: <one line: what the user is trying to accomplish>
```

It returns JSON and nothing else:

```json
{"classification":"safe|risky|deny","matched_rule":"…","reason":"…","what_changes":"…"}
```

Do not review a command yourself instead of spawning the reviewer, do not batch
several commands into one review, and do not re-run a review after editing the
command text - an edited command is a new command and needs its own review.

## 3. Act on the verdict

| Verdict | What you do |
|---|---|
| `safe` | Execute immediately, no confirmation needed. |
| `risky` | Show the user the host, the **verbatim** command, `reason` and `what_changes`, then ask for explicit confirmation (AskUserQuestion). Confirmed → execute. Declined → abort and report; do not offer a reworded command in the same breath. |
| `deny` | Report the reason and stop. This is not a confirmation prompt. |

If the reviewer's JSON is missing, malformed, or has a classification you do not
recognise, treat it as `risky`.

## 4. Execute with the verdict attached

Prefix the command with the verdict. The guard hook reads this and will block a
remote command that does not carry one:

```bash
REMOTE_EXEC_REVIEW=safe     ssh web1 -- journalctl -u nginx -n 100
REMOTE_EXEC_REVIEW=safe     scp web1:/var/log/nginx/error.log /tmp/
REMOTE_EXEC_REVIEW=approved ssh web1 -- systemctl restart nginx
```

- `safe` - the reviewer classified it safe.
- `approved` - the reviewer classified it risky **and the user confirmed it**.

Setting `approved` without having asked the user breaks the whole point of this
skill. The marker is inert (ssh does not forward it), it exists only to carry
the verdict to the hook.

## 5. Report

Say what ran, on which host, and what came back. If you aborted, say what was
declined and what remains undone.

## When the guard blocks you

The hook denies with a reason. Read it and follow it - it is the deterministic
half of this policy, and it re-derives the verdict independently:

| Block | Meaning | What to do |
|---|---|---|
| no security review on this remote command | The marker is missing | Run the review flow, then re-issue with the verdict. |
| marked safe, but the policy classifies it as risky | Your `safe` marker disagrees with the policy | Show the user the command and the reason, get a confirmation, re-issue with `approved`. |
| not something to run … through an agent | A `deny`-tier command | Stop. Tell the user to run it themselves. Do not look for an equivalent. |
| the remote-exec policy file is unusable | `rules.toml` is broken | Report the parse error. Ask the user to fix it; do not work around it. |
| `ssh <host>` with no command | Interactive session | Pass the command explicitly. |

Never rewrite a command to get past a block: quoting it differently, wrapping it
in `bash -c`, splitting it into pieces, or reaching the host another way (a
`docker -H ssh://` context, `ansible`, a remote `kubectl`) is the same operation
without the review, and is exactly what this skill exists to prevent.

## Policy

The classification rules - what counts as safe, risky and never - are in
`references/policy.md`, together with the schema for the user's own
allow/deny/review rules in `~/.claude/remote-exec/rules.toml`. Read it when a
verdict surprises you, or when the user wants to extend the policy.
