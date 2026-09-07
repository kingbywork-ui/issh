# Agent conversation adapter prototype

This is the first stage of R-071, not the production workspace relay. It is not
wired into registration, the desktop UI, or the packaged runtime.

`src/conversation-adapters.mjs` implements newline JSON RPC over a supplied
readable/writable stream. Codex uses App Server; Hermes uses ACP; Pi uses its
native RPC mode (a custom JSON protocol, not JSON-RPC 2.0, carried by
`PiRpcPeer`). All require an explicit conversation ID to resume, or
`create: true` to create a test conversation. Resume failure never creates a
replacement conversation.

## Local checks

Run `node --test issh-agent/test/conversation-adapters.test.mjs` from the repository
root. These tests simulate protocol peers; they do not prove SSH connectivity or
real model replies.

For an explicitly selected pair of installed agents, create a local JSON file:

```json
{
  "agents": [
    {
      "kind": "pi",
      "executable": "wsl.exe",
      "args": [
        "-d", "Ubuntu", "--", "bash", "-c",
        "env PATH=/home/USER/.local/share/pi-node/node-v22.23.2-linux-x64/bin:/usr/bin:/bin:/usr/sbin:/sbin pi --mode rpc --provider 9router --model ha"
      ],
      "cwd": "/absolute/test/directory",
      "create": true,
      "timeoutMs": 300000
    },
    {
      "kind": "codex",
      "executable": "/absolute/path/to/codex",
      "args": ["app-server"],
      "cwd": "/absolute/test/directory",
      "create": true,
      "timeoutMs": 120000
    }
  ]
}
```

Run `node issh-agent/bin/issh-conversation-check.mjs <config.json>`. It invokes
real model turns using each provider's existing local authentication and may
consume provider usage. The harness forwards a unique marker A → B → A and
checks that the return reaches A's original conversation. To test resume,
replace `create` with `conversationId`; do not specify both. Use isolated test
conversations, not a conversation being driven by an interactive client.

## Pi adapter specifics

Pi RPC mode speaks its own JSON protocol: commands are `{"id", "type": ...}`
records, responses echo the `id` with `success`, and agent lifecycle events
(`agent_start`, `message_update`, `agent_end`, ...) stream as id-less records.
`prompt()` sends the `prompt` command, waits for `agent_end`, then reads the
final assistant text via `get_last_assistant_text`.

Verified against a real WSL Pi (standalone 0.85.1, custom OpenAI-compatible
provider): spawn `wsl.exe ... bash -c "env PATH=<absolute pi-node bin> ... pi
--mode rpc ..."`. Three gotchas:

- Do not reference `$PATH` inside the `bash -c` string: `wsl.exe` expands it
  on the Windows side into the Windows PATH, which breaks bash quoting.
  Hardcode the absolute pi-node bin path (plus `/usr/bin:/bin`).
- Never pass `--offline`: it makes pi skip API key resolution and the
  provider rejects requests with 401.
- `-p` print mode waits for stdin EOF; RPC mode exits when stdin closes, so
  the spawn must keep stdin open for the lifetime of the conversation.

The wrapper still launches local executables with argument arrays, without a
shell. It does not reuse issh SSH connections yet. Do not put remote paths in
this configuration and expect them to run on an SSH host.

## Boundaries and remaining work

- Successful handshake does not prove model authentication or a completed turn.
- Resuming a saved conversation does not establish ownership of a running TUI.
- Client permission requests are declined. This is not a general sandbox for
  provider-internal tools, especially Hermes; text-only prompts are not a
  security boundary.
- A timeout closes the connection and reports an unknown delivery outcome.
  There is no automatic retry. Concurrent turns are rejected for the caller to
  queue.
- Dedicated SSH exec streams, registered adapter metadata, authenticated
  workspace routing, persistent delivery state, reconciliation, sequential
  queues, bounded autonomous replies, and the desktop UI remain to be built
  after the real two-agent acceptance check.

Protocol references:
[Codex App Server](https://developers.openai.com/codex/app-server/),
[Hermes ACP](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/developer-guide/acp-internals.md).
