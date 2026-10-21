---
feature: GITHUB-MCP
stage: spec
status: draft
branch: main
---

# Spec: GitHub MCP with existing CLI authentication

## Requirements

- Provide the official local server's tools and input schemas at a pinned upstream revision.
- Use `gh` for every GitHub operation.
- Support MCP Streamable HTTP on a persistent Docker service bound to host loopback.
- Read GitHub CLI authentication from a read-only host bind mount; persist after container restart.
- Do not include a token in image layers, application logs, or MCP error messages.
- Provide an offline test suite and an end-to-end Docker smoke test where Docker and valid authentication are available.
- Verify write-tool HTTP routing locally with a fake `gh` executable, checking the exact command arguments, request body, headers, and GraphQL operation without calling GitHub write APIs.

## Design

The Node process speaks stateless MCP Streamable HTTP at `/mcp`. It validates tool inputs against the official schema snapshot and executes mapped `gh api` calls as argv arrays. A host launcher extracts the existing `gh` credential from the keyring into a mode `0600` runtime file, starts Compose, and exits. Docker bind mounts the runtime file and host `gh` configuration read-only. The image contains `gh`, Node, and the service code.

## Affected modules

New `github/` service. No existing service modules.

## Trade-offs and concerns

The official local implementation contains 92 distinct listed tools at upstream commit `e3809fe91c7546633241006bf0b91f23b2595e28`, plus feature-gated and compatibility aliases. Exact response formatting, UI resources, feature gates, and GraphQL operations require per-tool handling. Tool enumeration alone is insufficient to claim compatibility.

## Related ADRs

None. Node and `gh` were specified by the user.

## Acceptance criteria

- The exposed default and all-tool inventories match the pinned official inventory.
- Every exposed tool has a `gh` invocation mapping and a row in the parity matrix; unverified behavior and known gaps are stated explicitly.
- MCP initialization, listing, and tool calls work over HTTP without live GitHub access in automated tests.
- Every listed write tool and its method/action branches have local HTTP-to-`gh` command assertions; no automated write test uses a real credential or invokes real `gh`.
- A container restart can reuse a mounted authenticated `gh` configuration in a live smoke test.
