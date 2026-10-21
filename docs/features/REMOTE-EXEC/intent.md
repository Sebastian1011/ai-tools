---
feature: REMOTE-EXEC
stage: intent
status: accepted
branch: main
---

# Intent: Reviewed SSH execution for AI coding agents

## Problem

Remote work over SSH is ad-hoc. An agent issues `ssh somehost '...'` as a plain Bash call, so a read-only `journalctl` and a `systemctl restart` on a production box look identical to the permission layer. The user either approves every remote command by hand, or approves a broad `ssh` pattern once and loses sight of what runs on which machine.

## Proposed outcome

A `remote-exec` skill where no remote command runs without a security classification in front of it:

- Read-only operations, and copying data from the remote machine to this one, execute immediately.
- Writes confined to a remote temp directory execute immediately.
- Writes outside temp directories, and any change to machine, service, network, kernel, runtime or application configuration, require an explicit user confirmation.
- Destructive operations are refused outright; no confirmation unlocks them.
- Ambiguous commands are treated as risky, not as safe.
- The agent never reads `~/.ssh`: the user names a host alias, the agent uses it as given and reports the ssh error when it does not work.

The classification is done by an independent reviewer subagent that inspects the actual command text, and the security policy is extensible by the user through a rule file evaluated together with the built-in principles.

## Affected users and systems

- Claude Code and Codex sessions that reach other machines through `~/.ssh/config` host aliases.
- No change to SSH connection configuration: hosts, users, keys and ports stay in the SSH config, and the skill only names aliases. That directory is also off-limits to read: the agent does not open, list or grep it.

## Non-goals

- SSH connection management (multiplexing, agent forwarding, key handling).
- An audit log or a wrapper CLI around ssh.
- Channels other than `ssh`/`scp`/`sftp`/`rsync` (`ansible`, `docker -H ssh://`, remote `kubectl` contexts).

## Constraints

- The reviewer must be an independent subagent, and it must see the command that will actually run - not a summary of it.
- The gate must not rely on prose alone: a deterministic layer has to catch an unreviewed remote command.
- One policy source, shared by the reviewer and the deterministic layer, so the two cannot drift.
- Both Claude Code and Codex are first-class targets, with the same behaviour on each.
