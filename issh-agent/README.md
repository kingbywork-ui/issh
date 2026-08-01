# issh Agent

This package is the dependency-free external client for the issh Agent Bridge.

- `bin/issh-agent.mjs` provides the command-line client.
- `bin/issh-mcp-server.mjs` provides the stdio MCP adapter.
- `src/protocol.js` is the canonical tool and scope definition shared with `issh-llm`.
- `src/client.mjs` handles validated loopback RPC connections.

The terminal-session implementation and all security decisions remain inside
`issh-llm/src/services/agentBridge.service.ts`.

Run `npm run test:issh-agent` from the repository root to execute the protocol,
RPC client, CLI mapping, and stdio MCP tests.

The legacy `tabby-agent`, `tabby-mcp-server`, and `tabby_*` tool aliases remain
available for one compatibility release.
