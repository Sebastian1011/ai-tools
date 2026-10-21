#!/usr/bin/env python3
"""PreToolUse hook: two guardrails around ssh.

1. No remote command runs without a review verdict.
2. `~/.ssh` is not read: not the config, not the keys, not a directory listing.
   The user names a host alias; the agent uses it as given and reports the ssh
   error if it does not work.

Shared by Claude Code and Codex - both send `{"tool_name":...,"tool_input":{...}}`
on stdin and read back `hookSpecificOutput.permissionDecision`.

The skill contract is that every `ssh`/`scp`/`sftp`/`rsync` invocation carries the
reviewer's verdict as an inert environment prefix:

    REMOTE_EXEC_REVIEW=safe     ssh host 'journalctl -n 50'
    REMOTE_EXEC_REVIEW=approved ssh host 'systemctl restart nginx'

This hook is the deterministic half of that contract. It denies unmarked remote
commands, re-classifies `safe` claims itself, and blocks the destructive forms
outright even when the user approved them. It cannot prove that a reviewer ran -
that part rests on the skill. "The hook did not block it" is never approval.

Install as ~/.claude/hooks/remote-exec-guard.py (mode 0755) and register it for
the Bash tool under PreToolUse in both agents.
"""

from __future__ import annotations

import fnmatch
import json
import os
import re
import shlex
import sys
import tomllib

REMOTE_TOOLS = {"ssh", "scp", "sftp", "rsync"}

# Prefixes that merely wrap another command.
WRAPPERS = {
    "command", "builtin", "exec", "nohup", "setsid", "time", "timeout",
    "stdbuf", "nice", "ionice", "env",
}

# Keywords of a construct that runs its body a bounded number of times. They run
# nothing themselves, so a segment is judged on the command that follows them.
# `while` and `until` are not here on purpose - see `effective_command`.
BOUNDED_KEYWORDS = {
    "do", "done", "if", "then", "elif", "else", "fi", "case", "esac", "{", "}",
    "!",  # negation runs nothing; `if ! systemctl is-active x` is the common form
}

# `for VAR in <words>` - a header, not a command.
FOR_HEADER = re.compile(r"^\s*for\s+[A-Za-z_][A-Za-z0-9_]*\s+in\b", re.DOTALL)
FOR_LOOP = re.compile(r"(?:^|[;&|\s])for\s+[A-Za-z_][A-Za-z0-9_]*\s+in\b")

# `&` as the background operator. Not `&&`, and not a descriptor dup (`2>&1`).
BACKGROUND = re.compile(r"(?<![&>\d])&(?![&>])")

# Interpreters whose arguments can carry a whole command line.
RECURSE_INTO = {
    "bash", "sh", "dash", "zsh", "ksh", "fish", "csh",
    "python", "python3", "perl", "ruby", "node", "xargs", "watch", "flock",
}

SEGMENT_DELIM = r"\|\||&&|[;\n|&()`]|\$\("
SEGMENT_SPLIT = re.compile(rf"(?:{SEGMENT_DELIM})")
# Same split, keeping the delimiters, so a segment can be removed from the text
# without changing how the rest of it is wired together.
SEGMENT_SPLIT_KEEP = re.compile(rf"({SEGMENT_DELIM})")

# ssh/scp options that consume the following argument.
SSH_VALUE_OPTS = {
    "-b", "-c", "-D", "-E", "-e", "-F", "-I", "-i", "-J", "-L", "-l", "-m",
    "-O", "-o", "-p", "-P", "-Q", "-R", "-S", "-W", "-w", "-B",
}

TMP_ROOTS = ("/tmp", "/var/tmp")

# Destructive forms. Blocked even with an explicit user approval: the user has
# to run these themselves.
HARD_DENY = [
    (r"\brm\s+(-[a-zA-Z]*\s+)*-[a-zA-Z]*[rR][a-zA-Z]*f?[a-zA-Z]*\s+/(\s|$|\*)", "recursive delete of /"),
    (r"\brm\s+-[a-zA-Z]*[rR]\S*\s+(-\S+\s+)*/(bin|boot|etc|lib|lib64|proc|root|sbin|sys|usr|var)(/\s*$|\s|$)", "recursive delete of a system directory"),
    (r"\bmkfs(\.\w+)?\b", "filesystem creation"),
    (r"\bdd\b[^|;]*\bof=/dev/", "raw write to a block device"),
    (r">\s*/dev/(sd|nvme|vd|hd)", "raw write to a block device"),
    (r"\b(shutdown|reboot|halt|poweroff)\b", "host shutdown or reboot"),
    (r"\bchmod\s+(-[a-zA-Z]*[rR]\S*\s+)+0*777\s+/(\s|$)", "world-writable chmod on /"),
    (r":\(\)\s*\{.*\}\s*;?\s*:", "fork bomb"),
    (r"\bsysctl\s+(-w\s+)?kernel\.(panic|sysrq)", "kernel panic/sysrq change"),
]

# Redirection into a file. `2>&1` is not one: it duplicates a descriptor.
REDIRECTION = r"(^|[^0-9<>])>>?\s*\S"

# Writes. Risky unless every absolute path involved sits under a temp root.
WRITE_PATTERNS = [
    (REDIRECTION, "output redirection"),
    (r"\btee\b", "tee"),
    (r"\bsed\s+(-\S+\s+)*-i", "in-place sed"),
    (r"\bperl\s+(-\S+\s+)*-i", "in-place perl"),
    (r"\b(cp|mv|rm|mkdir|rmdir|touch|ln|install|truncate|dd|chmod|chown|chgrp|setfacl)\b", "filesystem write"),
    (r"\b(tar|unzip|gunzip)\b.*(^|\s)(-[a-zA-Z]*x|--extract)", "archive extraction"),
    (r"\bgit\s+(clone|checkout|pull|reset|clean|apply)\b", "git working-tree write"),
    (r"\bfind\b[^|;]*\s-(delete|exec|execdir|ok|okdir|fls|fprint)\b", "find with a mutating action"),
]

# Machine configuration and runtime changes. Always risky, paths do not matter.
CONFIG_PATTERNS = [
    (r"\bsystemctl\s+(?!status\b|show\b|list-|is-|cat\b|--version)", "service or unit change"),
    (r"\bservice\s+\S+\s+(start|stop|restart|reload)\b", "service change"),
    (r"\b(apt|apt-get|aptitude|dpkg|yum|dnf|rpm|zypper|pacman|apk|snap|brew)\b", "package manager"),
    (r"\b(pip|pip3|npm|yarn|pnpm|gem|cargo|go)\s+(install|add|uninstall|remove)\b", "package manager"),
    (r"\bsysctl\s+(-w|\S+=)", "kernel parameter change"),
    (r"\b(ip|ifconfig|route|iptables|ip6tables|nft|nftables|ufw|firewall-cmd)\b\s+\S", "network configuration"),
    (r"\b(hostnamectl|timedatectl|localectl|update-alternatives|ldconfig|modprobe|insmod|rmmod)\b", "machine configuration change"),
    (r"\b(useradd|userdel|usermod|groupadd|groupdel|passwd|chpasswd|visudo)\b", "user or credential change"),
    (r"\bcrontab\b", "cron change"),
    (r"\b(docker|podman)\s+(run|rm|stop|restart|kill|exec|compose|build|pull|load|system)\b", "container runtime change"),
    (r"\bkubectl\s+(apply|delete|create|patch|scale|drain|cordon|rollout|edit)\b", "kubernetes change"),
    (r"\bhelm\s+(install|upgrade|uninstall|rollback)\b", "helm release change"),
    (r"\b(mount|umount|swapon|swapoff|parted|fdisk|lvm|lvcreate|vgcreate)\b", "storage configuration change"),
    (r"\b(systemd-run|at|batch)\b", "scheduled or transient unit"),
]

# Fetch-and-run. Always risky: the payload is not visible to the reviewer.
FETCH_EXEC_PATTERNS = [
    (r"\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?(ba)?sh\b", "remote fetch piped into a shell"),
    (r"\b(curl|wget)\b[^|]*\|\s*(python|python3|perl|ruby|node)\b", "remote fetch piped into an interpreter"),
]

# Query forms of the commands the tables above gate by name. `ip addr show` and
# `timedatectl status` read; `ip addr add` and `timedatectl set-time` write, and
# the binary name cannot tell them apart. The pattern is matched against the
# whole argument string, so an unrecognised subcommand, a mutating verb or one
# extra argument means this is not a known query form - and the tables above
# then judge the command exactly as they do today.
READ_ONLY_FORMS = {
    # network
    "ip": r"(?:-\S+\s+)*(?:a|addr|address|l|link|r|route|n|neigh|neighbour|rule"
          r"|netns|maddr|mroute|tunnel)(?:\s+(?:show|list|get)(?:\s+\S+)*)?",
    "ifconfig": r"(?:(?:-a|-s|-v)\s+)*[\w.:@-]*",
    "route": r"(?:(?:-n|-e|-ee|-v|--numeric|-A\s+\S+)\s*)*",
    "iptables": r"(?:(?:-t\s+\S+|-n|-v|-x|--line-numbers|--numeric)\s+)*"
                r"(?:-L|-S|--list|--list-rules)(?:\s+(?:-t\s+\S+|-\S+|[\w.:/-]+))*",
    "nft": r"(?:-\S+\s+)*list(?:\s+\S+)*",
    "ufw": r"status(?:\s+(?:verbose|numbered))?|show(?:\s+\S+)*|--version",
    "firewall-cmd": r"(?:--(?:permanent|zone=\S+)\s+)*"
                    r"--(?:state|list-\S+|get-\S+|query-\S+|info-\S+)(?:\s+--\S+)*",
    # machine configuration
    "hostnamectl": r"(?:-\S+\s+)*(?:status)?",
    "timedatectl": r"(?:-\S+\s+)*(?:status|show|show-timezones|list-timezones)?",
    "localectl": r"(?:-\S+\s+)*(?:status|list-locales|list-keymaps|list-x11-keymap-\S+)?",
    "systemctl": r"(?:--?\S+\s*)*"
                 r"(?:status|show|show-environment|cat|help|get-default|is-\S+|list-\S+)?"
                 r"(?:\s+\S+)*",
    "update-alternatives": r"--(?:list|display|get-selections|query)(?:\s+\S+)*",
    "ldconfig": r"-p|--print-cache",
    "modprobe": r"(?:-n|--dry-run|-c|--showconfig|-D|--show-depends|-R|--resolve-alias"
                r"|--show-modversion|-V|--version)(?:\s+\S+)*",
    "crontab": r"(?:-u\s+\S+\s+)?-l",
    # storage
    "mount": r"(?:(?:-l|--show-labels|-v|--verbose)\s*)*",
    "swapon": r"--show(?:=\S+)?|-s|--summary",
    "fdisk": r"(?:-l|--list)(?:\s+\S+)*",
    "parted": r"(?:-l|--list)(?:\s+\S+)*",
    "lvm": r"(?:pvs|vgs|lvs|pvdisplay|vgdisplay|lvdisplay|pvscan|vgscan|lvscan)(?:\s+\S+)*",
    # package managers - the query subcommands
    "apt": r"(?:-\S+\s+)*(?:list|show|search|policy|depends|rdepends|showsrc|madison)"
           r"(?:\s+\S+)*",
    "apt-cache": r"(?:show|showpkg|showsrc|search|depends|rdepends|policy|stats|dump"
                 r"|dumpavail|unmet|pkgnames|madison)(?:\s+\S+)*",
    "dpkg": r"(?:-l|-L|-s|-S|-p|--list|--status|--listfiles|--search|--print-architecture"
            r"|--print-foreign-architectures|--get-selections|--verify|--audit)(?:\s+\S+)*",
    "rpm": r"(?:-q\S*|--query\S*|-V\S*|--verify)(?:\s+\S+)*",
    "yum": r"(?:-\S+\s+)*(?:list|info|search|provides|whatprovides|repolist|repoquery"
           r"|history|check-update|deplist)(?:\s+\S+)*",
    "zypper": r"(?:-\S+\s+)*(?:se|search|if|info|lr|repos|pa|packages|pd|patches|lp"
              r"|list-patches|what-provides|wp)(?:\s+\S+)*",
    "pacman": r"(?:-Q\S*|-S[si]\S*|-F\S*|-T\S*)(?:\s+\S+)*",
    "apk": r"(?:info|list|search|policy|version|dot|stats)(?:\s+\S+)*",
    "snap": r"(?:list|info|find|version|changes|connections|services|known|whoami)"
            r"(?:\s+\S+)*",
    "brew": r"(?:list|ls|info|search|deps|outdated|config|home|--version)(?:\s+\S+)*",
    # container and cluster reads
    "docker": r"(?:(?:-\S+|--\S+)\s+)*(?:system\s+(?:df|info|events)"
              r"|compose\s+(?:ps|config|logs|top|ls|images|version))(?:\s+\S+)*",
    "kubectl": r"(?:(?:-\S+|--\S+)\s+)*rollout\s+(?:status|history)(?:\s+\S+)*",
}
READ_ONLY_FORMS["ip6tables"] = READ_ONLY_FORMS["iptables"]
READ_ONLY_FORMS["dnf"] = READ_ONLY_FORMS["yum"]
READ_ONLY_FORMS["podman"] = READ_ONLY_FORMS["docker"]
# Report-only binaries: whatever the arguments, they do not write.
for _reporter in ("pvs", "vgs", "lvs", "pvdisplay", "vgdisplay", "lvdisplay", "dpkg-query"):
    READ_ONLY_FORMS[_reporter] = r".*"

# Leading command names that only read.
READ_ONLY_COMMANDS = {
    "ls", "cat", "bat", "head", "tail", "less", "more", "stat", "file", "wc",
    "df", "du", "free", "uptime", "uname", "hostname", "whoami", "id", "date",
    "ps", "top", "pgrep", "pidof", "lsof", "netstat", "ss", "vmstat", "iostat",
    "mpstat", "sar", "dmesg", "journalctl", "lscpu", "lsblk", "lsusb", "lspci",
    "sensors", "nproc", "arch", "env", "printenv", "which", "type", "whereis",
    "echo", "printf", "true", "pwd", "readlink", "realpath", "basename",
    "dirname", "grep", "egrep", "fgrep", "rg", "awk", "sed", "cut", "sort",
    "uniq", "tr", "diff", "cmp", "md5sum", "sha256sum", "getent", "dig",
    "nslookup", "ping", "traceroute", "curl", "wget", "nc", "python3", "python",
    "systemctl", "docker", "podman", "kubectl", "git", "find", "tree", "zcat",
    "zgrep", "jq", "yq", "test", "sleep", "column", "tac", "nl",
    # Shell builtins that only touch the remote shell itself. They carry no
    # effect of their own, and a script body routinely opens with one.
    "set", "cd", "export", "exit", "[", "[[",
}

# The user's ssh directory: config, keys, known_hosts. Off-limits to read, list
# or copy - the host alias the user gives is enough to run a command with.
SSH_DIR = re.compile(r"(?:~|\$HOME|\$\{HOME\}|/home/[\w.-]+|/root)/\.ssh\b")

RULES_ENV = "REMOTE_EXEC_RULES"
DEFAULT_RULES = os.path.expanduser("~/.claude/remote-exec/rules.toml")
MARKER = "REMOTE_EXEC_REVIEW"

FLOW = (
    "Run the remote-exec review flow: hand the host alias and the verbatim remote\n"
    "command to the remote-exec-reviewer subagent, then re-issue the command with\n"
    "the verdict attached - REMOTE_EXEC_REVIEW=safe for a safe verdict, or\n"
    "REMOTE_EXEC_REVIEW=approved once the user has explicitly confirmed a risky one.\n"
    "Do not reword the command to look safer, and do not set the marker yourself."
)


class PolicyError(Exception):
    """The rules file cannot be trusted; deny rather than fail open."""


# --------------------------------------------------------------- user rules --

def load_rules() -> dict:
    path = os.environ.get(RULES_ENV) or DEFAULT_RULES
    if not os.path.exists(path):
        return {"ambiguous": "review", "rules": []}
    try:
        with open(path, "rb") as fh:
            data = tomllib.load(fh)
    except (OSError, tomllib.TOMLDecodeError) as exc:
        raise PolicyError(f"{path} could not be read: {exc}") from exc

    ambiguous = data.get("defaults", {}).get("ambiguous", "review")
    if ambiguous not in ("review", "deny"):
        raise PolicyError(f"{path}: defaults.ambiguous must be \"review\" or \"deny\"")

    rules = []
    for index, raw in enumerate(data.get("rules", [])):
        name = raw.get("name", f"rule #{index + 1}")
        action = raw.get("action")
        if action not in ("allow", "review", "deny"):
            raise PolicyError(f"{path}: rule '{name}' has action {action!r}, expected allow|review|deny")
        if not raw.get("match"):
            raise PolicyError(f"{path}: rule '{name}' has no match pattern")
        try:
            pattern = re.compile(raw["match"])
        except re.error as exc:
            raise PolicyError(f"{path}: rule '{name}' has an invalid match regex: {exc}") from exc
        rules.append({
            "name": name,
            "action": action,
            "pattern": pattern,
            "hosts": raw.get("hosts"),
            "reason": raw.get("reason", ""),
        })
    return {"ambiguous": ambiguous, "rules": rules}


def rule_matches(rule: dict, host: str, text: str) -> bool:
    if rule["hosts"] is not None:
        if not any(fnmatch.fnmatch(host, glob) for glob in rule["hosts"]):
            return False
    return bool(rule["pattern"].search(text))


# ------------------------------------------------------------ classification --

def absolute_paths(text: str) -> list[str]:
    return re.findall(r"(?<![\w=:])/[\w.~@+-]*(?:/[\w.~@+-]*)*", text)


def under_tmp(path: str) -> bool:
    return any(path == root or path.startswith(root + "/") for root in TMP_ROOTS)


def first_match(patterns: list[tuple[str, str]], text: str) -> str | None:
    for pattern, description in patterns:
        if re.search(pattern, text):
            return description
    return None


def effective_command(text: str) -> str | None:
    """The command a shell segment really runs: `""` if unreadable, `None` if it
    runs nothing at all (a bare keyword, an assignment, a loop header).

    Keywords of a *bounded* construct are transparent, so the body decides the
    verdict - `do cat /etc/hosts` is a read. `while` and `until` are deliberately
    absent from BOUNDED_KEYWORDS: they repeat without a bound, and a read
    repeated forever is not a read.
    """
    if FOR_HEADER.match(text):
        # The iteration list is data, not a command. It is dropped only here -
        # it stays in the text the write and path tables scan, so
        # `for d in /tmp/a /etc/nginx` is still a write to /etc/nginx.
        return None
    try:
        tokens = shlex.split(text, comments=False)
    except ValueError:
        return ""
    for token in tokens:
        if re.match(r"^[A-Za-z_][A-Za-z0-9_]*=", token):
            continue
        name = os.path.basename(token)
        if name in WRAPPERS or name in BOUNDED_KEYWORDS:
            continue
        return name
    return None


def read_only_form(part: str) -> bool:
    """True when this shell segment is a known query form of a gated command."""
    if re.search(REDIRECTION, part) or re.search(r"[<`]", part):
        return False  # a redirection is a write; leave it to the tables
    try:
        tokens = shlex.split(part, comments=False)
    except ValueError:
        return False
    while tokens:
        head = os.path.basename(tokens[0])
        if re.match(r"^[A-Za-z_][A-Za-z0-9_]*=", tokens[0]) or head in WRAPPERS or head in BOUNDED_KEYWORDS:
            tokens = tokens[1:]
            continue
        break
    if not tokens:
        return False
    pattern = READ_ONLY_FORMS.get(os.path.basename(tokens[0]))
    if pattern is None:
        return False
    return re.fullmatch(pattern, " ".join(tokens[1:])) is not None


def strip_read_only(text: str) -> tuple[str, list[str]]:
    """(text with the verified read-only segments blanked out, segments left).

    Only segments `read_only_form` vouches for are dropped, never ones whose
    leading name merely appears in READ_ONLY_COMMANDS - that set holds `sed`,
    `docker` and `git`, and dropping those would hide `sed -i` or `docker run`
    from the tables below. Delimiters survive, so `curl … | sh` is still one
    pipeline to the tables after a neighbouring segment is removed.
    """
    # `2>&1` duplicates a descriptor - it writes nothing, and its `&` is not a
    # segment boundary. Drop it before splitting.
    pieces = SEGMENT_SPLIT_KEEP.split(re.sub(r"\d?>&\d", " ", text))
    kept: list[str] = []
    out: list[str] = []
    for index, piece in enumerate(pieces):
        if index % 2:  # a delimiter
            out.append(piece)
        elif piece.strip() and read_only_form(piece):
            out.append(" ")
        else:
            out.append(piece)
            if piece.strip():
                kept.append(piece)
    return "".join(out), kept


def classify(host: str, text: str, rules: dict, download: bool = False) -> tuple[str, str]:
    """Return (verdict, reason) with verdict in {safe, risky, deny}."""
    text = text.strip()

    hard = first_match(HARD_DENY, text)
    if hard:
        return "deny", f"destructive operation ({hard})"

    for action in ("deny", "review", "allow"):
        for rule in rules["rules"]:
            if rule["action"] == action and rule_matches(rule, host, text):
                verdict = {"deny": "deny", "review": "risky", "allow": "safe"}[action]
                detail = f": {rule['reason']}" if rule["reason"] else ""
                return verdict, f"user rule '{rule['name']}' says {action}{detail}"
        # fall through to the next tier

    if download:
        if re.search(r"--(rsync-path|remote-option)\b|(^|\s)-M\s", text):
            return "risky", "the transfer carries a command to run on the remote side"
        return "safe", "copying data from the remote machine to this one"

    # A `for` loop is bounded, but not if it backgrounds its body: the work it
    # spawns is unbounded, and the tables have no concept of how often a segment
    # runs. (`while` and `until` need no rule here - they are risky already.)
    if FOR_LOOP.search(text) and BACKGROUND.search(text):
        return "risky", "a loop that backgrounds its body - the work it spawns is unbounded"

    # Segments that are verified read-only forms are set aside, so that the
    # tables judge only what is left. The verdict follows what the command does,
    # not which binary it names.
    scan, remaining = strip_read_only(text)
    if not remaining:
        return "safe", "read-only command"

    fetch = first_match(FETCH_EXEC_PATTERNS, scan)
    if fetch:
        return "risky", fetch

    config = first_match(CONFIG_PATTERNS, scan)
    if config:
        return "risky", config

    write = first_match(WRITE_PATTERNS, scan)
    if write:
        paths = absolute_paths(scan)
        if paths and all(under_tmp(path) for path in paths):
            return "safe", f"{write} confined to {', '.join(TMP_ROOTS)}"
        if not paths:
            return "risky", f"{write} with no absolute path - the target cannot be verified"
        outside = [path for path in paths if not under_tmp(path)]
        return "risky", f"{write} outside a temp directory ({outside[0]})"

    running = [name for name in map(effective_command, remaining) if name is not None]
    if all(name in READ_ONLY_COMMANDS for name in running):
        return "safe", "read-only command"

    unread = next(name for name in running if name not in READ_ONLY_COMMANDS)
    ambiguous = "deny" if rules["ambiguous"] == "deny" else "risky"
    return ambiguous, f"cannot be read as a read-only command ({unread or 'unparsable'})"


# -------------------------------------------------------------- extraction ---

def tokenize(segment: str) -> list[str]:
    try:
        return shlex.split(segment, comments=True)
    except ValueError:
        return segment.split()


OPERATORS = {"&&", "||", "|", "&", ";", "|&"}

HEREDOC_RE = re.compile(r"<<-?\s*(?P<q>[\"']?)(?P<marker>[A-Za-z_][A-Za-z0-9_]*)(?P=q)")
HEREDOC_SLOT = "__REMOTE_EXEC_HEREDOC_{}__"


def extract_heredocs(command: str) -> tuple[str, dict[str, str]]:
    """(command with every heredoc body lifted out, slot token -> body).

    A heredoc is data handed to a program, not a command line for the shell, and
    text that merely mentions ssh (documentation, a Python string) must not read
    as a remote invocation. The `ssh …` that opens a heredoc still survives this,
    because it sits before the marker.

    The body of a **quoted** heredoc is kept under a slot token, because
    `ssh host bash -s <<'EOF'` sends it to the remote shell verbatim - see
    `stdin_script`. An unquoted marker gets no slot: the local shell expands the
    body before it is sent, so this text is not the text that runs.
    """
    bodies: dict[str, str] = {}
    out: list[str] = []
    while True:
        match = HEREDOC_RE.search(command)
        if match is None:
            return "".join(out) + command, bodies
        marker = match.group("marker")
        rest = command[match.end():]
        end = re.search(r"^\s*" + re.escape(marker) + r"\s*$", rest, re.MULTILINE)
        slot = ""
        if match.group("q"):
            slot = HEREDOC_SLOT.format(len(bodies))
            bodies[slot] = rest[:end.start()] if end else rest
        out.append(command[:match.start()] + " " + slot + " ")
        command = rest[end.end():] if end else ""


def strip_heredocs(command: str) -> str:
    return extract_heredocs(command)[0]


# Shells that run a script handed to them on stdin.
STDIN_SHELLS = {"bash", "sh", "dash", "ksh", "zsh"}

COMMENT_LINE = re.compile(r"^[ \t]*#.*$", re.MULTILINE)


def stdin_script(text: str, bodies: dict[str, str]) -> str | None:
    """The script body, when the remote command is a shell reading it from stdin.

    `ssh host bash -s <<'EOF' … EOF` runs the heredoc body on the remote host, so
    the body *is* the remote command and gets classified as one. Without this the
    remote text is a bare `bash -s`, which no table can read, and every scripted
    remote command would land in the review tier no matter what it does.

    Only a quoted heredoc qualifies. A pipe or a `<` redirect into `bash -s`
    carries text this hook cannot see, and stays unreadable - therefore risky.
    """
    try:
        tokens = shlex.split(text, comments=False)
    except ValueError:
        return None
    if len(tokens) < 2 or os.path.basename(tokens[0]) not in STDIN_SHELLS:
        return None
    if tokens[-1] not in bodies:
        return None
    for flag in tokens[1:-1]:
        # `-c` takes its script from an argument, so the heredoc is data there.
        if flag != "--" and (not re.fullmatch(r"-[a-z]+", flag) or "c" in flag):
            return None
    body = bodies[tokens[-1]]
    if SSH_DIR.search(body):
        return None  # ~/.ssh keeps the verdict it had before the body was read
    # Comment lines run nothing, and an unreadable one would sink the whole body.
    return COMMENT_LINE.sub("", body)


def segments(command: str) -> list[list[str]]:
    """Shell segments as token lists, with quoted payloads left intact."""
    command = strip_heredocs(command)
    try:
        tokens = shlex.split(command, comments=True)
    except ValueError:
        # Unbalanced quoting: fall back to splitting the raw text.
        return [tokenize(part) for part in SEGMENT_SPLIT.split(command)]

    result: list[list[str]] = []
    current: list[str] = []
    for token in tokens:
        if token in OPERATORS:
            result.append(current)
            current = []
            continue
        if token.endswith(";") and len(token) > 1:
            current.append(token[:-1])
            result.append(current)
            current = []
            continue
        current.append(token)
    result.append(current)
    return result


def split_host(spec: str) -> str:
    return spec.split("@", 1)[-1]


def parse_ssh(tokens: list[str]) -> tuple[str, str] | None:
    """(host, remote command text) for an ssh argv, or None if unrecognised."""
    index = 1
    host = None
    while index < len(tokens):
        token = tokens[index]
        if token == "--":
            index += 1
            if host is None and index < len(tokens):
                host = split_host(tokens[index])
                index += 1
            break
        if token in SSH_VALUE_OPTS:
            index += 2
            continue
        if token.startswith("-"):
            index += 1
            continue
        host = split_host(token)
        index += 1
        break
    if host is None:
        return None
    while index < len(tokens) and tokens[index] == "--":
        index += 1
    return host, " ".join(tokens[index:])


def parse_transfer(tokens: list[str]) -> tuple[str, str, bool] | None:
    """(host, text, download) for scp/sftp/rsync, or None if no remote spec."""
    operands = []
    index = 1
    while index < len(tokens):
        token = tokens[index]
        if token in SSH_VALUE_OPTS:
            index += 2
            continue
        if token.startswith("-"):
            index += 1
            continue
        operands.append(token)
        index += 1
    remote = [op for op in operands if re.match(r"^[^/:\s]+:", op)]
    if not remote:
        return None
    host = split_host(remote[0].split(":", 1)[0])
    text = " ".join(tokens[1:])
    # Upload when the destination (last operand) is the remote side.
    download = len(operands) > 1 and not re.match(r"^[^/:\s]+:", operands[-1])
    return host, text, download


def find_invocations(command: str, depth: int = 0) -> list[dict]:
    """Every remote invocation in a Bash command, with its review marker."""
    if depth > 3:
        return []

    command, bodies = extract_heredocs(command)
    found: list[dict] = []
    for tokens in segments(command):
        marker = None
        index = 0
        wrapped = False
        while index < len(tokens):
            token = tokens[index]
            assignment = re.match(r"^([A-Za-z_][A-Za-z0-9_]*)=(.*)$", token)
            if assignment:
                if assignment.group(1) == MARKER:
                    marker = assignment.group(2)
                index += 1
                continue
            if os.path.basename(token) in WRAPPERS:
                wrapped = True
                index += 1
                continue
            # A wrapper's own arguments, e.g. `timeout 30 ssh …`, `nice -n 5 ssh …`.
            if wrapped and (token.startswith("-") or re.match(r"^[0-9]+[smhd]?$", token)):
                index += 1
                continue
            break

        if index >= len(tokens):
            continue

        rest = tokens[index:]
        name = os.path.basename(rest[0])

        if name == "ssh":
            parsed = parse_ssh(rest)
            if parsed is None:
                found.append({"tool": "ssh", "marker": marker, "host": "?", "text": "", "download": False})
            else:
                host, text = parsed
                script = stdin_script(text, bodies)
                found.append({
                    "tool": "ssh", "marker": marker, "host": host,
                    "text": script if script is not None else text, "download": False,
                })
            continue

        if name in ("scp", "sftp", "rsync"):
            parsed = parse_transfer(rest)
            if parsed is None:
                continue  # purely local rsync/scp
            host, text, download = parsed
            found.append({"tool": name, "marker": marker, "host": host, "text": text, "download": download})
            continue

        if name in RECURSE_INTO:
            for arg in rest[1:]:
                if " " in arg and re.search(r"\b(ssh|scp|sftp|rsync)\b", arg):
                    for nested in find_invocations(arg, depth + 1):
                        nested.setdefault("marker", None)
                        if nested["marker"] is None:
                            nested["marker"] = marker
                        found.append(nested)
    return found


# -------------------------------------------------------------- decision -----

def review_target(invocation: dict) -> str:
    if invocation["tool"] == "ssh":
        return invocation["text"] or "<interactive login, no command given>"
    return f"{invocation['tool']} {invocation['text']}"


def decide(invocation: dict, rules: dict) -> str | None:
    """Reason to deny, or None to allow."""
    target = review_target(invocation)
    host = invocation["host"]

    if invocation["tool"] == "ssh" and not invocation["text"]:
        return (
            f"Blocked: `ssh {host}` with no command opens an interactive session, which cannot\n"
            f"be reviewed or driven from a tool call.\n\n"
            f"Pass the remote command explicitly: ssh {host} -- <command>."
        )

    verdict, reason = classify(host, invocation["text"], rules, invocation["download"])
    marker = invocation["marker"]

    if verdict == "deny":
        return (
            f"Blocked: this is not something to run on {host} through an agent.\n\n"
            f"  command: {target}\n"
            f"  reason:  {reason}\n\n"
            f"No confirmation can unlock it - if this really has to happen, the user runs it\n"
            f"themselves. Do not look for an equivalent command that slips past this check."
        )

    if marker is None:
        return (
            f"Blocked: no security review on this remote command.\n\n"
            f"  host:    {host}\n"
            f"  command: {target}\n"
            f"  policy:  {verdict} - {reason}\n\n"
            f"{FLOW}"
        )

    if marker == "approved":
        return None

    if marker != "safe":
        return (
            f"Blocked: REMOTE_EXEC_REVIEW={marker!r} is not a verdict.\n\n"
            f"Use REMOTE_EXEC_REVIEW=safe or REMOTE_EXEC_REVIEW=approved.\n\n{FLOW}"
        )

    if verdict == "safe":
        return None

    return (
        f"Blocked: the command was marked safe, but the policy classifies it as risky.\n\n"
        f"  host:    {host}\n"
        f"  command: {target}\n"
        f"  reason:  {reason}\n\n"
        f"Show the user this command and this reason, get an explicit confirmation, and only\n"
        f"then re-issue it with REMOTE_EXEC_REVIEW=approved. If the user declines, stop."
    )


def deny(reason: str) -> int:
    print(json.dumps({
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": reason,
        }
    }))
    return 0


def main() -> int:
    try:
        payload = json.load(sys.stdin)
    except (json.JSONDecodeError, ValueError):
        return 0  # malformed hook input is not this hook's business

    # Any shell-flavoured tool call carries a `command`. Claude Code names the
    # tool `Bash`; Codex runs PreToolUse for its shell tools only, under names
    # that differ per build - so key off the payload, not off the tool name.
    tool_input = payload.get("tool_input") or payload.get("toolInput") or {}
    command = tool_input.get("command", "")
    if isinstance(command, list):
        # An argv form, e.g. ["zsh", "-lc", "ssh host uptime"]. Re-quote it so the
        # payload of the inner shell stays one token.
        command = shlex.join(str(part) for part in command)
    if not isinstance(command, str) or not command.strip():
        return 0
    # Heredoc bodies are data here too: documentation that mentions the path is
    # not an attempt to read it.
    if SSH_DIR.search(strip_heredocs(command)):
        return deny(
            "Blocked: `~/.ssh` is off-limits - its config and keys are not something an\n"
            "agent reads.\n\n"
            "Use the host alias the user gave you exactly as given, and run the command. If\n"
            "the alias does not resolve or the connection fails, report that error verbatim\n"
            "and let the user fix their SSH config. Do not probe the alias first, and do not\n"
            "look up a key, port or user to pass on the command line."
        )

    if not re.search(r"\b(ssh|scp|sftp|rsync)\b", command):
        return 0

    invocations = find_invocations(command)
    if not invocations:
        return 0

    try:
        rules = load_rules()
    except PolicyError as exc:
        return deny(
            f"Blocked: the remote-exec policy file is unusable, so no remote command can be\n"
            f"classified.\n\n  {exc}\n\nAsk the user to fix the file. Do not work around it."
        )

    for invocation in invocations:
        reason = decide(invocation, rules)
        if reason is not None:
            return deny(reason)
    return 0


if __name__ == "__main__":
    sys.exit(main())
