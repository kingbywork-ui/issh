# Tabby Agent

This package is the dependency-free external client for the issh Tabby Agent Bridge.

- `bin/tabby-agent.mjs` provides the command-line client.
- `bin/tabby-mcp-server.mjs` provides the stdio MCP adapter.
- `src/protocol.js` is the canonical tool and scope definition shared with `tabby-llm`.
- `src/client.mjs` handles validated loopback RPC connections.

The terminal-session implementation and all security decisions remain inside
`tabby-llm/src/services/agentBridge.service.ts`.

Run `npm run test:tabby-agent` from the repository root to execute the protocol,
RPC client, CLI mapping, and stdio MCP tests.
