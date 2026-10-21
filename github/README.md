# gh CLI GitHub MCP

Node.js MCP service that wraps `gh api` and uses the host's existing GitHub CLI login. Docker runs it as a persistent Streamable HTTP endpoint. MCP clients connect directly to `http://127.0.0.1:3000/mcp`; they do not run a Docker stdio wrapper.

## Start

```sh
gh auth status
./scripts/docker-http.sh
```

The script obtains the existing credential through host `gh auth token`, writes it to a private `0600` file under `${XDG_RUNTIME_DIR:-/tmp}/gh-cli-mcp-<uid>/`, then starts Compose. Docker mounts the token file and the host `gh` configuration read-only. The token does not enter the image or Compose environment. The container reads the mounted file for each GitHub request, so `docker restart` does not require another login. After a host reboot, run the script again to recreate the runtime token file from the host login.

Port 3000 is the default. If occupied, start with `MCP_PORT=37999 ./scripts/docker-http.sh` and use that port in the client URL. Compose publishes only on the host loopback address. The endpoint rejects nonlocal Host and Origin values.

Client configuration example:

```json
{
  "mcpServers": {
    "github-gh": {
      "type": "http",
      "url": "http://127.0.0.1:3000/mcp"
    }
  }
}
```

Use the equivalent HTTP MCP setting in your client. `GET /health` returns `ok` for a local readiness check. The service implements stateless Streamable HTTP at MCP protocol `2025-03-26`.

## Compatibility

The tool inventory is pinned to official `github/github-mcp-server` commit `e3809fe91c7546633241006bf0b91f23b2595e28`. It includes 92 tool names; input schemas for 91 tools came from the official binary's `tools/list` response under the current host credential. The remaining `delete_repository` schema comes from the pinned source because this credential lacks `delete_repo` scope.

[The per-tool comparison](docs/features/GITHUB-MCP/parity.md) lists all 92 tools and their 161 branches or standalone entries, their local implementation, and known mismatches. Tool naming and input schema matching do **not** imply full behavior parity. In particular, binary and large file resources, review threads, some pagination/filtering, typed output and UI resources still differ. Local HTTP tests cover 35 write tools across 73 route cases using a fake `gh` executable; they check generated commands and bodies, not GitHub's acceptance or resulting state. Write operations have not been exercised against live GitHub.

`GITHUB_TOOLSETS` accepts `default`, `all`, or comma-separated official toolset names. `GITHUB_TOOLS`, `GITHUB_EXCLUDE_TOOLS`, and `GITHUB_READ_ONLY=true` filter the exposed tools. The server never accepts shell commands from clients.

## Development

```sh
npm test
npm run check:inventory
node scripts/build-parity.mjs
```
