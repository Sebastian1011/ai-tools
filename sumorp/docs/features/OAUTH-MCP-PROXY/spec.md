---
feature: OAUTH-MCP-PROXY
stage: spec
status: accepted
branch: main
---

# Spec: one-upstream MCP OAuth proxy

## Requirements

- Configure one HTTPS upstream, local listen address, durable store, refresh lead time, and explicit scopes.
- Discover OAuth resource and authorization metadata. Use dynamic registration or a configured client ID, PKCE S256, authorization code, and refresh token grants.
- Serialize token refresh and persist credentials atomically before releasing a new access token.
- Forward POST, GET, DELETE, MCP headers, body, query, status, JSON, and SSE without processing MCP messages.
- Strip incoming credentials and hop-by-hop headers; reject nonlocal Host or Origin.
- Refresh once after an upstream 401 without replay; require reauthorization on repeated rejection or invalid grant.
- Ship a nonroot container, Compose volume and health check, usage instructions, and mock tests.

## Design

`authorize` discovers metadata, registers or selects the client, prints a PKCE authorization URL, accepts the loopback callback, exchanges the code and writes `/data/oauth.json`. DCR includes the requested scope and resource in the registration metadata. `serve` loads that file. Its one token manager locks around freshness checks, refreshes and writes. The HTTP proxy copies each request to the configured upstream, replacing Authorization and preserving the upstream MCP session header. The health endpoint checks only process liveness.

The store includes the upstream URL so a volume cannot silently authorize a different endpoint. A temporary file is synced, renamed, and followed by directory sync. A failed write blocks further token use in the process. The unavoidable remote-rotation/local-crash window requires reauthorization.

## Affected modules

This is a new repository component: configuration, OAuth manager, persistent store, HTTP proxy, CLI, and container deployment. No preexisting architecture documents or ADRs exist in this checkout.

## Trade-offs and concerns

An HTTP-level proxy preserves unknown MCP methods and session semantics. It cannot inspect or retry an individual MCP call. OAuth is implemented with direct HTTP calls because mcp-go's OAuth handler is built for its MCP client transport, while this proxy needs its own serialized durable store and explicit no-replay 401 behavior. A fixed loopback callback port simplifies DCR and container mapping; `listen` can choose the interface on that port. The first release handles DCR and preregistration; CIMD requires publicly hosted HTTPS metadata and is deferred.

## Related ADRs

None. This repository starts with this single component; these initial boundaries are recorded here and in the README.

## Acceptance criteria

`go test -race ./...` covers OAuth discovery, registration, refresh concurrency/rotation, invalid grant, persistence failure, forward semantics, SSE, local request checks, connection failure, and 401 without replay. Compose config and image build succeed. Real Atlassian browser authorization, read-only request, explicit refresh, restart, and another request are recorded separately when connectivity is available.
