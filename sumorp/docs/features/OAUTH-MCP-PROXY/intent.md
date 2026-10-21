---
feature: OAUTH-MCP-PROXY
stage: intent
status: accepted
branch: main
---

# Intent: one-upstream MCP OAuth proxy

## Problem

A local MCP client currently has to own the upstream OAuth grant. That couples client credentials and token renewal to the client and makes a shared, persistent, transparent connection difficult.

## Proposed outcome

One local endpoint accepts unauthenticated MCP HTTP requests and sends them to one configured OAuth-protected upstream. The proxy manages authorization, renewal, and durable credentials; the upstream remains responsible for MCP sessions and response semantics.

## Affected users and systems

Local MCP clients, the proxy process, an OAuth authorization server, and one upstream MCP HTTP endpoint. Atlassian v2 is the first real acceptance target.

## Constraints

Preserve request bodies, query strings, MCP headers, response status and streaming behavior. Never replay a request automatically after an upstream 401. Keep credentials out of logs and restrict local access to loopback.

## Out of scope

Multiple upstreams or accounts, CIMD, MCP message interpretation, and automatic request replay.

## Open questions

None for the implementation. Real Atlassian acceptance needs browser access and network connectivity.
