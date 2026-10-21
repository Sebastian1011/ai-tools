#!/usr/bin/env bash
# Verify the Codex execpolicy rules resolve as intended. This is the Codex-side
# deterministic floor: no route to a remote machine runs without surfacing.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RULES="$ROOT/agents/codex/remote-exec.rules"

command -v codex >/dev/null || { echo "codex not installed - skipping"; exit 0; }

pass=0 fail=0

# check EXPECTED_DECISION -- <command tokens...>
check() {
  local want="$1"; shift 2
  local out got
  out="$(codex execpolicy check --rules "$RULES" -- "$@" 2>&1)"
  # codex may print warnings before the JSON result, so take the last JSON line.
  got="$(printf '%s' "$out" | python3 -c 'import json,sys
for line in reversed(sys.stdin.read().splitlines()):
    line = line.strip()
    if line.startswith("{"):
        try:
            print(json.loads(line).get("decision", "none")); raise SystemExit(0)
        except json.JSONDecodeError:
            continue
print("unparsable")')"
  if [[ "$got" == "$want" ]]; then
    pass=$((pass + 1))
    printf '  ok   %-10s %s\n' "$got" "$*"
  else
    fail=$((fail + 1))
    printf '  FAIL want %-10s got %-10s %s\n       %s\n' "$want" "$got" "$*" "$out"
  fi
}

echo "every route to a remote machine surfaces"
check prompt -- ssh web1 uptime
check prompt -- /usr/bin/ssh web1 uptime
check prompt -- ssh web1 'systemctl restart nginx'
check prompt -- scp web1:/var/log/syslog .
check prompt -- scp ./nginx.conf web1:/etc/nginx/nginx.conf
check prompt -- sftp web1
check prompt -- rsync -az ./site/ web1:/srv/www/
check prompt -- ansible-playbook deploy.yml

echo
echo "the review marker does not make it slip through"
check prompt -- ssh web1 -- journalctl -n 50

echo
echo "unaffected everyday commands"
check none -- ls -la /etc
check none -- git status
check none -- pytest -q

printf '\n%d passed, %d failed\n' "$pass" "$fail"
[[ $fail -eq 0 ]]
