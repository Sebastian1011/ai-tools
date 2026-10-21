#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
token_dir="${XDG_RUNTIME_DIR:-/tmp}/gh-cli-mcp-$(id -u)"
umask 077
mkdir -p "$token_dir"
chmod 700 "$token_dir"
temporary_file=$(mktemp "$token_dir/token.XXXXXX")
trap 'rm -f "$temporary_file"' EXIT HUP INT TERM
if [ -n "${GH_HOST:-}" ]; then
  gh auth token --hostname "$GH_HOST" > "$temporary_file"
else
  gh auth token > "$temporary_file"
fi
if [ ! -s "$temporary_file" ]; then
  echo 'gh returned an empty authentication token' >&2
  exit 1
fi
mv -f "$temporary_file" "$token_dir/token"
trap - EXIT HUP INT TERM

export HOST_GH_TOKEN_FILE="$token_dir/token"
export HOST_GH_CONFIG_DIR="${GH_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/gh}"
exec docker compose --project-directory "$script_dir/.." up -d --build --force-recreate "$@"
