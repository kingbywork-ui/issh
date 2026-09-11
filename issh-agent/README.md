# issh Agent

This package is the dependency-free external client for the issh Agent Bridge.

The built-in Agent Hub Web also uses `bin/issh-conversation-worker.mjs` to
connect registered Agents through the Pi RPC, Hermes ACP and Codex App Server
adapters. It persists message history and preserves native conversation IDs;
registration alone does not attach an existing interactive terminal chat.
See [Agent Hub Web conversations](../docs/agent-hub-conversations.md) for setup,
supported transports and the tested delivery boundary. These conversation
methods are management RPCs, not additional MCP tools.

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

New discovery files use `issh-agent-bridge.json` in configuration directories
and `.issh-agent-bridge.json` in workspaces. The legacy Tabby file names and
configuration directories remain read-only discovery fallbacks for one
compatibility release; iSSH only writes the new file name.
