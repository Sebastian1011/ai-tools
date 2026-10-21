#!/usr/bin/env bash
# Tests for the user-extensible rule file: it is evaluated together with the
# built-in principles, and it cannot unlock the destructive forms.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOOK="$ROOT/hooks/remote-exec-guard.py"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

pass=0 fail=0

# check <rules file> allow|deny "command"
check() {
  local rules="$1" want="$2" cmd="$3" out got
  out="$(REMOTE_EXEC_RULES="$rules" python3 -c 'import json,sys; print(json.dumps({"tool_name":"Bash","tool_input":{"command":sys.argv[1]}}))' "$cmd" \
        | REMOTE_EXEC_RULES="$rules" python3 "$HOOK")"
  if [[ -z "$out" ]]; then
    got=allow
  elif grep -q '"permissionDecision": *"deny"' <<<"$out"; then
    got=deny
  else
    got="unexpected: $out"
  fi
  if [[ "$got" == "$want" ]]; then
    pass=$((pass + 1))
    printf '  ok   %-6s %s\n' "$got" "$cmd"
  else
    fail=$((fail + 1))
    printf '  FAIL want %-5s got %-5s %s\n' "$want" "$got" "$cmd"
    printf '       %s\n' "$out"
  fi
}

cat >"$WORK/rules.toml" <<'EOF'
version = 1

[[rules]]
name   = "deny-prod-shell-writes"
action = "deny"
hosts  = ["prod-*"]
match  = '^cat /etc/'
reason = "production config is read through the config repo, not over ssh"

[[rules]]
name   = "review-tmp-on-prod"
action = "review"
hosts  = ["prod-*"]
match  = '/tmp/'
reason = "even scratch files on production get a human look"

[[rules]]
name   = "allow-nginx-reload"
action = "allow"
match  = '^systemctl reload nginx$'
reason = "reload is non-disruptive and pre-approved"
EOF

echo "user deny beats a built-in safe verdict"
check "$WORK/rules.toml" deny  "REMOTE_EXEC_REVIEW=safe ssh prod-web1 'cat /etc/hosts'"
check "$WORK/rules.toml" allow "REMOTE_EXEC_REVIEW=safe ssh staging 'cat /etc/hosts'"

echo
echo "a user deny is not unlockable by confirmation"
check "$WORK/rules.toml" deny "REMOTE_EXEC_REVIEW=approved ssh prod-web1 'cat /etc/hosts'"

echo
echo "user review downgrades a built-in safe verdict"
check "$WORK/rules.toml" deny  "REMOTE_EXEC_REVIEW=safe ssh prod-web1 'echo x > /tmp/probe'"
check "$WORK/rules.toml" allow "REMOTE_EXEC_REVIEW=approved ssh prod-web1 'echo x > /tmp/probe'"
check "$WORK/rules.toml" allow "REMOTE_EXEC_REVIEW=safe ssh staging 'echo x > /tmp/probe'"

echo
echo "user allow upgrades a built-in risky verdict"
check "$WORK/rules.toml" allow "REMOTE_EXEC_REVIEW=safe ssh prod-web1 'systemctl reload nginx'"
check "$WORK/rules.toml" deny  "REMOTE_EXEC_REVIEW=safe ssh prod-web1 'systemctl reload apache2'"

echo
echo "user allow cannot unlock the destructive forms"
cat >"$WORK/reckless.toml" <<'EOF'
version = 1

[[rules]]
name   = "allow-everything"
action = "allow"
match  = '.*'
EOF
check "$WORK/reckless.toml" deny  "REMOTE_EXEC_REVIEW=safe ssh web1 'rm -rf /'"
check "$WORK/reckless.toml" deny  "REMOTE_EXEC_REVIEW=approved ssh web1 reboot"
check "$WORK/reckless.toml" allow "REMOTE_EXEC_REVIEW=safe ssh web1 'systemctl restart nginx'"
check "$WORK/reckless.toml" deny  "ssh web1 uptime"

echo
echo "ambiguous = deny refuses instead of asking"
cat >"$WORK/strict.toml" <<'EOF'
version = 1

[defaults]
ambiguous = "deny"
EOF
check "$WORK/strict.toml" deny  "REMOTE_EXEC_REVIEW=approved ssh web1 '/opt/vendor/bin/whatever'"
check "$WORK/strict.toml" allow "REMOTE_EXEC_REVIEW=safe ssh web1 uptime"

echo
echo "an unusable rule file denies everything remote, and never fails open"
printf 'version = 1\n[[rules]\n' >"$WORK/broken.toml"
check "$WORK/broken.toml" deny  "REMOTE_EXEC_REVIEW=safe ssh web1 uptime"
check "$WORK/broken.toml" allow "git status"

cat >"$WORK/badaction.toml" <<'EOF'
version = 1

[[rules]]
name   = "typo"
action = "alow"
match  = 'uptime'
EOF
check "$WORK/badaction.toml" deny "REMOTE_EXEC_REVIEW=safe ssh web1 uptime"

cat >"$WORK/badregex.toml" <<'EOF'
version = 1

[[rules]]
name   = "unbalanced"
action = "allow"
match  = '([a-z'
EOF
check "$WORK/badregex.toml" deny "REMOTE_EXEC_REVIEW=safe ssh web1 uptime"

echo
echo "a missing rule file just means built-in defaults"
check "$WORK/absent.toml" allow "REMOTE_EXEC_REVIEW=safe ssh web1 uptime"
check "$WORK/absent.toml" deny  "REMOTE_EXEC_REVIEW=safe ssh web1 'systemctl restart nginx'"

echo
echo "the shipped example file parses and keeps the defaults intact"
check "$ROOT/config/rules.example.toml" allow "REMOTE_EXEC_REVIEW=safe ssh web1 uptime"
check "$ROOT/config/rules.example.toml" deny  "REMOTE_EXEC_REVIEW=safe ssh web1 'systemctl restart nginx'"

printf '\n%d passed, %d failed\n' "$pass" "$fail"
[[ $fail -eq 0 ]]
