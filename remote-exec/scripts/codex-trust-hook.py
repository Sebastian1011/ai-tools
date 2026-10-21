#!/usr/bin/env python3
"""Trust the remote-exec guard hook in a Codex profile, and verify it.

Codex loads a hook but skips it silently while its trust status is `untrusted`,
which is what a fresh `hooks.json` gives you. Trust is persisted in
`config.toml` as

    [hooks.state."<source path>:pre_tool_use:<group>:<index>"]
    enabled = true
    trusted_hash = "sha256:…"

where the hash is the one Codex itself computes for the handler. Rather than
guess either value, this script asks Codex through the app-server `hooks/list`
RPC, writes the entry, and asks again to confirm the hook is now `trusted`.

    codex-trust-hook.py <CODEX_HOME> [--hook-substring remote-exec-guard.py]

Exit status: 0 the hook is trusted, 1 it is not (reason on stderr).
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import tomllib

RPC_TIMEOUT = 90
MARKER = "remote-exec-guard.py"


def list_hooks(codex_home: str) -> list[dict]:
    """Every PreToolUse hook Codex loads for this profile, with trust status."""
    env = dict(os.environ, CODEX_HOME=codex_home)
    proc = subprocess.Popen(
        ["codex", "app-server"],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
        text=True, env=env, cwd="/",
    )
    try:
        for message in (
            {"jsonrpc": "2.0", "id": 1, "method": "initialize",
             "params": {"clientInfo": {"name": "remote-exec-install",
                                       "title": "remote-exec install",
                                       "version": "1"}}},
            {"jsonrpc": "2.0", "method": "initialized", "params": {}},
            {"jsonrpc": "2.0", "id": 2, "method": "hooks/list", "params": {"cwds": ["/"]}},
        ):
            proc.stdin.write(json.dumps(message) + "\n")
        proc.stdin.flush()

        deadline = RPC_TIMEOUT
        while deadline > 0:
            line = proc.stdout.readline()
            if not line:
                break
            try:
                payload = json.loads(line)
            except json.JSONDecodeError:
                continue
            if payload.get("id") == 2:
                entries = payload.get("result", {}).get("data", [])
                return [hook for entry in entries for hook in entry.get("hooks", [])]
        return []
    finally:
        proc.kill()


def find_hook(hooks: list[dict], marker: str) -> dict | None:
    for hook in hooks:
        if marker in str(hook.get("command", "")):
            return hook
    return None


def write_trust(config_path: str, key: str, hook_hash: str) -> None:
    """Add or update the trust entry, in place (the file may be a symlink)."""
    text = ""
    if os.path.exists(config_path):
        with open(config_path) as fh:
            text = fh.read()

    block = f'[hooks.state."{key}"]\nenabled = true\ntrusted_hash = "{hook_hash}"\n'
    pattern = re.compile(
        r'\n\[hooks\.state\."' + re.escape(key) + r'"\]\n(?:[^\[\n][^\n]*\n|\n)*',
        re.MULTILINE,
    )
    if pattern.search(text):
        text = pattern.sub("\n" + block, text, count=1)
    else:
        text = text.rstrip("\n") + "\n\n" + block

    tomllib.loads(text)  # refuse to write something Codex cannot read
    with open(config_path, "w") as fh:
        fh.write(text)


def main(argv: list[str]) -> int:
    if not argv:
        print(__doc__, file=sys.stderr)
        return 2
    codex_home = os.path.abspath(os.path.expanduser(argv[0]))
    marker = MARKER
    if "--hook-substring" in argv:
        marker = argv[argv.index("--hook-substring") + 1]

    config_path = os.path.join(codex_home, "config.toml")

    hook = find_hook(list_hooks(codex_home), marker)
    if hook is None:
        print(f"{codex_home}: Codex does not load a hook matching {marker!r} - "
              f"check hooks.json and [features].hooks", file=sys.stderr)
        return 1

    if hook.get("trustStatus") == "trusted":
        print(f"{codex_home}: hook already trusted")
        return 0

    key, hook_hash = hook.get("key"), hook.get("currentHash")
    if not key or not hook_hash:
        print(f"{codex_home}: Codex reported no key/hash for the hook", file=sys.stderr)
        return 1

    try:
        write_trust(config_path, key, hook_hash)
    except (OSError, tomllib.TOMLDecodeError) as exc:
        print(f"{codex_home}: could not record hook trust in {config_path}: {exc}", file=sys.stderr)
        return 1

    confirmed = find_hook(list_hooks(codex_home), marker)
    status = (confirmed or {}).get("trustStatus")
    if status == "trusted":
        print(f"{codex_home}: hook trusted and verified ({hook_hash[:14]}…)")
        return 0
    print(f"{codex_home}: trust entry written but Codex still reports {status!r}", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
