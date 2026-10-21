---
feature: GITHUB-MCP
stage: intent
status: accepted
branch: main
---

# Intent: GitHub MCP with existing CLI authentication

## Problem

The user cannot use the official GitHub MCP authentication flow and needs an MCP service that works with the existing GitHub CLI login.

## Proposed outcome

An MCP client can use the local open source GitHub MCP tool surface through a Docker service. Container restarts retain access to the host's GitHub CLI authentication state.

## Affected users and systems

Local MCP clients, Docker, the host GitHub CLI configuration, and GitHub API.

## Constraints

Implement the service in Node.js. Execute GitHub operations through `gh`. Do not copy credentials into the image or print them. Match the official local open source tool inventory and input schemas at a pinned upstream revision.

## Out of scope

GitHub's remote-only proprietary MCP tools.

## Open questions

None. The user selected the local open source tool inventory.
