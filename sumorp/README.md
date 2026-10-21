# sumorp

Single-upstream MCP OAuth proxy. Clients use `http://127.0.0.1:8765/mcp` without OAuth. The proxy obtains and refreshes one upstream OAuth grant and forwards MCP HTTP requests without interpreting their content. The upstream owns every MCP session ID.

## Configure and authorize

```sh
cp config.example.yaml config.yaml
# Edit upstream_url and oauth.scopes for your upstream.
docker compose build
docker compose run --rm --service-ports proxy authorize
```

The `authorize` command prints an authorization URL. Open it in the **host browser**. The callback returns to `http://127.0.0.1:8765/oauth/callback`; Compose publishes that port on host loopback. The command exits after the callback saves the grant. Stop the proxy before reauthorizing because both commands listen on port 8765.

The example uses the `read`, `search`, and `write` Jira scopes advertised by the [Atlassian v2 protected resource metadata](https://mcp.atlassian.com/.well-known/oauth-protected-resource/v2/mcp); select scopes for the actual tools you need. If the upstream does not support dynamic client registration, set `oauth.client_id` and optionally `oauth.client_secret_env` in `config.yaml`, then provide that environment variable to the container. The preregistered client must allow the exact callback URL above. This release requires OAuth protected-resource and authorization-server discovery plus PKCE S256. It does not support CIMD.

## Run and migrate Codex

```sh
docker compose up -d
docker compose ps
curl -fsS http://127.0.0.1:8765/healthz
codex mcp logout atlassian
codex mcp remove atlassian
codex mcp add atlassian --url http://127.0.0.1:8765/mcp
codex mcp list
```

If the old server has a different name, use that name in the `logout` and `remove` commands. The endpoint intentionally has no OAuth challenge; do not run `codex mcp login` against it. [Official Codex MCP configuration](https://learn.chatgpt.com/docs/extend/mcp?surface=cli) describes the CLI and `config.toml` options.

```sh
docker compose logs --tail=100 proxy
docker compose down
```

`docker compose down` retains the named `oauth-data` volume. Rebuild or recreate the container with `docker compose up -d --build`; the grant survives in `/data/oauth.json`. The file contains secrets and is written with mode `0600`. Do not copy it into a repository or logs.

## Behavior and recovery

- `/mcp` forwards POST, GET and DELETE, the request body and query, MCP headers, status, JSON and SSE. The proxy replaces `Authorization` and strips local cookies, API keys, forwarding headers and hop-by-hop headers. SSE chunks flush as they arrive.
- A single mutex serializes refresh and persistence. The default refresh threshold is five minutes before expiry. A token is available to requests only after the new grant is written to disk. Ten simultaneous requests share one refresh.
- An upstream 401 triggers at most one controlled refresh and returns a proxy error without replaying the request. Retry the MCP request explicitly. A second rejection of the refreshed token, `invalid_grant`, or a persistence failure requires `docker compose stop proxy` followed by the `authorize` command and `docker compose up -d`.
- `/healthz` reports only that the process is alive; it does not check OAuth or the upstream. A 503 from `/mcp` means reauthorization is needed. A 502 means the upstream rejected a request or a network/OAuth operation failed; inspect structured container logs for the error category.
- If Atlassian shows `invalid_request` after consent and never reaches the local callback, stop the waiting `authorize` command with Ctrl-C. Confirm the configured scopes are in the [v2 resource metadata](https://mcp.atlassian.com/.well-known/oauth-protected-resource/v2/mcp) and the registration used the issuer shown there. This is an authorization-server rejection before a token exists; no local refresh can repair it.
- Local Host and Origin checks restrict use to loopback names and port 8765. Compose also binds host loopback. Do not expose the container port publicly.

The supported scope is one upstream and one account per instance. The proxy does not parse or modify MCP messages, choose among upstreams, host public CIMD metadata, or replay calls. A crash after the remote server rotates a refresh token but before local persistence can require reauthorization.

## Verification

```sh
go test -race ./...
docker compose config
docker compose build
```

The Go tests use mock OAuth and MCP servers. Real Atlassian acceptance requires a host browser for authorization, then a read-only MCP request, an explicit refresh, a container restart, and another request. These steps are not implied by passing mock tests.
