# remote-exec security policy

One source of truth for three readers: the `remote-exec-reviewer` subagent, the
`remote-exec-guard` PreToolUse hook, and you.

## Evaluation order

1. **Built-in destructive forms** → `deny`. User rules cannot override this tier.
2. User rule with `action = "deny"` → `deny`.
3. User rule with `action = "review"` → `risky`.
4. User rule with `action = "allow"` → `safe`.
5. **Built-in defaults** (the three tables below).
6. Anything left → `[defaults].ambiguous` from the rule file, `review` unless set
   to `deny`.

Within one tier the first matching rule wins, so order in the rule file is
priority. A command is judged on the text that will actually run on the remote
host - if part of it is unreadable (a fetched script, a base64 payload, a
variable expanded remotely), that part counts as unknown, and unknown is risky.

## Script bodies

`ssh host bash -s <<'EOF' … EOF` is the normal way to send more than a one-liner,
and it is **not** risky by virtue of its shape. The heredoc body is the remote
command: classify it line by line against the tables below, and the most
dangerous line sets the verdict, exactly as with a one-liner. A body of nothing
but reads is `safe`.

This holds only while the body is readable and is what will actually run:

- The marker has to be quoted - `<<'EOF'`, not `<<EOF`. An unquoted marker lets
  the *local* shell expand `$VAR` and `$(…)` in the body before it is sent, so
  the text being reviewed is not the text that runs. Always write `<<'EOF'`.
- A body arriving any other way cannot be read at all, and unknown is risky:
  `bash -s < deploy.sh`, `cat x | ssh host bash -s`, `ssh host bash -c "$SCRIPT"`.
- Comment lines and shell builtins that only touch the remote shell (`set`, `cd`,
  `export`, `exit`) carry no effect and do not raise the tier on their own.

## Loops and conditionals

A construct that runs its body a **bounded** number of times is judged on the
body, exactly like a chain: `for f in /var/log/*.log; do wc -l "$f"; done` is a
read. The keywords `do done if then elif else fi case esac { } !` run nothing, so
they are transparent, and a `for VAR in <list>` header is not a command either.

The iteration list is still part of the command text for everything else, which
is what keeps this honest: `for d in /tmp/a /tmp/b; do rm -rf "$d"; done` is a
temp write (safe), while `for d in /tmp/a /etc/nginx; …` is a write to
`/etc/nginx` (risky) and `for d in $DIRS; …` is a write with no absolute path
(risky). One risky line in the body still sets the verdict for the whole loop.

Two forms stay risky no matter how read-only the body looks, because the tables
count *what* runs and have no concept of *how often*:

- **`while` and `until`** - they repeat without a bound, and a read repeated
  forever is not a read. Use a bounded `for`, or expect to confirm.
- **A `for` loop that backgrounds its body** (`for i in …; do curl … & done`) -
  what it spawns is unbounded. `2>&1` is not backgrounding; `&&` is not either.

Not recognised, therefore risky - conservative, not a judgement that they are
dangerous: a C-style `for ((i=0;i<3;i++))`, and `case`, whose selector and `)`
pattern labels do not read as commands (its keywords are transparent, but that is
not enough on its own).

## Safe - runs without asking

- Read-only remote commands: `ls`, `cat`, `head`, `tail`, `stat`, `file`, `wc`,
  `df`, `du`, `free`, `uptime`, `uname`, `id`, `date`, `ps`, `top`, `lsof`,
  `ss`, `netstat`, `dmesg`, `journalctl`, `lsblk`, `lscpu`, `systemctl status`
  (and `show`, `list-*`, `is-*`, `cat`), `docker ps`, `kubectl get`,
  `git status`/`log`/`diff`/`show`, `grep`, `awk`, `sed` without `-i`, `sort`,
  `diff`, `sha256sum`, `find` without `-delete` or `-exec`.
- Read-only **forms** of commands that can also write. The verdict follows what
  the command does, not which binary it names - `ip addr show` reads, `ip addr
  add` writes, and only the arguments tell them apart. Recognised query forms:
  - network: `ip <object> [show|list|get …]`, `ifconfig [iface]`, `route -n`,
    `iptables`/`ip6tables -L|-S|--list|--list-rules` (with `-t`), `nft list …`,
    `ufw status`, `firewall-cmd --state|--list-*|--get-*|--query-*`.
  - machine configuration: `systemctl status|show|cat|is-*|list-*|get-default`
    and flag-only forms like `systemctl --failed`, `hostnamectl [status]`,
    `timedatectl [status|show|list-timezones]`, `localectl [status|list-*]`,
    `update-alternatives --list|--display|--get-selections`, `ldconfig -p`,
    `modprobe -n|-c|--show-depends|--resolve-alias`, `crontab -l`.
  - storage: `mount` (bare or `-l`), `swapon --show`, `fdisk -l`, `parted -l`,
    `lvm pvs|vgs|lvs|*display|*scan`, and the report-only `pvs`/`vgs`/`lvs`.
  - package managers: `apt list|show|search|policy|depends`, `apt-cache …`,
    `dpkg -l|-L|-s|-S|--verify`, `dpkg-query …`, `rpm -q*|-V`,
    `yum`/`dnf list|info|search|provides|repolist|history|check-update`,
    `zypper se|if|lr|pa`, `pacman -Q*|-Ss|-Si`, `apk info|list|search`,
    `snap list|info|find`, `brew list|info|search|deps|outdated`.
  - containers and clusters: `docker`/`podman system df|info|events`,
    `docker compose ps|config|logs|top|ls|images|version`,
    `kubectl rollout status|history`.

  This list is exactly what the guard hook accepts, and it is a whitelist: an
  unrecognised subcommand, an unknown flag or one extra argument is **not** a
  read-only form, and falls back to the risky tiers below. Dry-run flags
  (`kubectl --dry-run`, `apt-get -s`, `helm --dry-run`) are not on the list.
  A redirection into a file (`ip addr show > /etc/net.txt`) is a write, whatever
  produced the output - `2>&1` is not, it only duplicates a descriptor - and in
  a chain the other segments are judged on their own
  (`ip a; rm -rf /srv` is a delete).
- Copying **down**: `scp host:path .`, `rsync -a host:path ./local/`,
  `ssh host cat file > local`.
- Writes confined to a temp root - every absolute path in the command sits under
  `/tmp` or `/var/tmp`. `ssh host 'tar -xzf /tmp/a.tgz -C /tmp/out'` is safe;
  `ssh host 'rm -rf /tmp/build'` is safe.

## Risky - needs an explicit user confirmation

- Any write outside `/tmp` and `/var/tmp`: redirection, `tee`, `sed -i`,
  `install`, `truncate`, `cp`, `mv`, `rm`, `mkdir`, `touch`, `ln`, `chmod`,
  `chown`, `setfacl`, archive extraction, `git clone|checkout|pull|reset|clean`.
- A write with **no absolute path at all** - the target depends on the remote
  working directory and cannot be verified from here.
- Copying **up**: `scp local host:path`, `rsync ./local/ host:path`, and any
  transfer carrying `--rsync-path` / `--remote-option` / `-M` (those run a
  command on the remote side).
- Service and unit changes: `systemctl start|stop|restart|reload|enable|disable|
  daemon-reload|mask|kill`, `service X restart`.
- Package managers in any form other than the queries listed above: `apt`,
  `apt-get`, `dpkg`, `yum`, `dnf`, `rpm`, `zypper`, `pacman`, `apk`, `snap`,
  `brew`, and `pip|npm|gem|cargo|go install|add|remove`.
- Kernel, network and machine configuration in their mutating forms: `sysctl -w`,
  `ip … add|del|set|change|flush`, `ifconfig eth0 down`, `route add`,
  `iptables -A|-D|-I|-F|-Z`, `nft add|delete|flush`, `ufw allow|deny`,
  `firewall-cmd --add-*|--remove-*`, `hostnamectl set-*`, `timedatectl set-*`,
  `localectl set-*`, `modprobe` without a dry-run flag, bare `ldconfig`,
  `update-alternatives --install|--set|--remove`.
- Users, credentials and scheduling: `useradd`, `usermod`, `passwd`, `visudo`,
  `crontab` other than `-l`, `at`, `systemd-run`.
- Runtime changes: `docker run|rm|stop|restart|exec|build|pull`, `docker system
  prune`, `docker compose up|down|restart`, `kubectl apply|delete|patch|scale|
  drain|exec`, `kubectl rollout restart|undo|pause`, `helm install|upgrade`.
- Storage: `mount <device> <dir>`, `umount`, `swapon` other than `--show`,
  `parted`/`fdisk` other than listing, `lvcreate`.
- Fetch-and-run: `curl … | sh`, `wget … | python3`.
- Anything ambiguous. **When in doubt, risky.** Being asked once is cheap;
  a silent production change is not.

## Deny - not unlockable by confirmation

The user has to run these themselves, from their own shell:

- `rm -rf /` and recursive deletes of `/bin`, `/boot`, `/etc`, `/lib`, `/proc`,
  `/root`, `/sbin`, `/sys`, `/usr`, `/var`.
- `mkfs*`, `dd of=/dev/…`, redirection into `/dev/sd*`, `/dev/nvme*`.
- `shutdown`, `reboot`, `halt`, `poweroff`.
- `chmod -R 777 /`, fork bombs, `sysctl -w kernel.panic|kernel.sysrq`.

## User rules

`~/.claude/remote-exec/rules.toml` (override with `REMOTE_EXEC_RULES`). Both
Claude Code and Codex read the same file. Missing file = built-in policy only.
An unreadable or invalid file denies every remote command - it never fails open.

```toml
version = 1

[defaults]
ambiguous = "review"      # "review" (default) | "deny"

[[rules]]
name   = "allow-log-reads"
action = "allow"              # allow | review | deny
match  = '^journalctl( |$)'   # extended regex over the remote command text
hosts  = ["prod-*"]           # optional; globs over the ssh alias, omit = all
reason = "log reads are read-only"
```

`config/rules.example.toml` in this repo is the annotated template that the
installer copies into place.

## What the hook adds

The guard hook re-derives the verdict from this policy on every remote
invocation. It blocks:

- a remote command with no `REMOTE_EXEC_REVIEW=` verdict attached,
- `REMOTE_EXEC_REVIEW=safe` on a command this policy calls risky,
- any `deny`-tier command, marker or no marker,
- `ssh host` with no command (an interactive session cannot be reviewed).

Heredoc bodies are treated as data, not as commands: text that merely mentions a
remote command (a script you are writing, documentation) does not read as an
invocation. The one exception is the shape above - a quoted heredoc feeding
`ssh host bash -s`, where the body *is* the remote command. There the hook reads
the body and classifies it, so a read-only script runs on a `safe` verdict
without a confirmation prompt. With an unquoted marker, or a body piped or
redirected in, the remote text stays a bare `bash -s`, which no table can read:
that is risky, and the hook will reject a `safe` marker on it.

It cannot tell whether a reviewer actually ran. That is the skill's job, and
"the hook did not block it" is never approval.
