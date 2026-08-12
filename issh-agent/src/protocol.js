export const AGENT_BRIDGE_PROTOCOL_VERSION = '1.0.0'

const tabProperty = {
    type: 'string',
    description: 'Tab id returned by issh_list_sessions, or "active".',
}

const commandProperty = {
    type: 'string',
    minLength: 1,
    description: 'Shell command to validate or execute.',
}

const confirmDangerousProperty = {
    type: 'boolean',
    description: 'Signals that the agent expects a dangerous-command confirmation. issh still requires native user approval.',
}

export const AGENT_BRIDGE_TOOLS = [
    {
        name: 'issh_health',
        scope: 'read',
        description: 'Check whether the issh Agent Bridge is reachable and report its basic state.',
        inputSchema: {
            type: 'object',
            properties: {},
            additionalProperties: false,
        },
    },
    {
        name: 'issh_list_sessions',
        scope: 'read',
        description: 'List terminal sessions currently registered in issh, including stable tab ids and connection metadata.',
        inputSchema: {
            type: 'object',
            properties: {},
            additionalProperties: false,
        },
    },
    {
        name: 'issh_list_profiles',
        scope: 'read',
        description: 'List configured SSH profiles that can be opened through the bridge.',
        inputSchema: {
            type: 'object',
            properties: {},
            additionalProperties: false,
        },
    },
    {
        name: 'issh_connect_profile',
        scope: 'write',
        description: 'Open an SSH profile by id or name and wait for its terminal session to connect.',
        inputSchema: {
            type: 'object',
            properties: {
                id: { type: 'string', minLength: 1, description: 'SSH profile id.' },
                name: { type: 'string', minLength: 1, description: 'SSH profile name.' },
                timeoutMs: { type: 'number', minimum: 1, maximum: 3600000, description: 'Connection timeout in milliseconds.' },
            },
            anyOf: [{ required: ['id'] }, { required: ['name'] }],
            additionalProperties: false,
        },
    },
    {
        name: 'issh_disconnect_session',
        scope: 'write',
        description: 'Close a issh terminal session.',
        inputSchema: {
            type: 'object',
            properties: { tab: tabProperty },
            additionalProperties: false,
        },
    },
    {
        name: 'issh_get_context',
        scope: 'read',
        description: 'Read cwd, shell, OS, partial command, and recent output from a terminal session.',
        inputSchema: {
            type: 'object',
            properties: { tab: tabProperty },
            additionalProperties: false,
        },
    },
    {
        name: 'issh_read_buffer',
        scope: 'read',
        description: 'Read recent terminal output lines from a terminal session.',
        inputSchema: {
            type: 'object',
            properties: {
                tab: tabProperty,
                lines: { type: 'number', minimum: 1, maximum: 500, description: 'Number of recent lines to return.' },
            },
            additionalProperties: false,
        },
    },
    {
        name: 'issh_select_session',
        scope: 'write',
        description: 'Select a issh terminal session and make it active in the application UI.',
        inputSchema: {
            type: 'object',
            properties: { tab: tabProperty },
            additionalProperties: false,
        },
    },
    {
        name: 'issh_preview_command',
        scope: 'read',
        description: 'Normalize a command and report whether issh considers it dangerous without executing it.',
        inputSchema: {
            type: 'object',
            required: ['command'],
            properties: {
                tab: tabProperty,
                command: commandProperty,
            },
            additionalProperties: false,
        },
    },
    {
        name: 'issh_insert_command',
        scope: 'exec',
        description: 'Insert a validated shell command into a terminal session without pressing Enter.',
        inputSchema: {
            type: 'object',
            required: ['command'],
            properties: {
                tab: tabProperty,
                command: commandProperty,
            },
            additionalProperties: false,
        },
    },
    {
        name: 'issh_run_command',
        scope: 'exec',
        description: 'Insert a validated command and press Enter in an interactive terminal. This does not wait for output.',
        inputSchema: {
            type: 'object',
            required: ['command'],
            properties: {
                tab: tabProperty,
                command: commandProperty,
                confirmDangerous: confirmDangerousProperty,
            },
            additionalProperties: false,
        },
    },
    {
        name: 'issh_exec_command',
        scope: 'exec',
        description: 'Execute a command and wait for isolated output and an exit code. SSH sessions use an exec channel; local sessions use a separate matching shell process. Use issh_run_command when the command must run visibly inside the interactive terminal.',
        inputSchema: {
            type: 'object',
            required: ['command'],
            properties: {
                tab: tabProperty,
                command: commandProperty,
                timeoutMs: { type: 'number', minimum: 1, maximum: 3600000, description: 'Execution timeout in milliseconds.' },
                cwd: { type: 'string', minLength: 1, description: 'Optional working directory for SSH or local execution.' },
                confirmDangerous: confirmDangerousProperty,
            },
            additionalProperties: false,
        },
    },
    {
        name: 'issh_get_output',
        scope: 'read',
        description: 'Read another page of output returned by a truncated issh_exec_command result.',
        inputSchema: {
            type: 'object',
            required: ['outputId'],
            properties: {
                outputId: { type: 'string', minLength: 1, description: 'Output id returned by issh_exec_command.' },
                offset: { type: 'number', minimum: 0, description: 'Character offset to start reading from.' },
                limit: { type: 'number', minimum: 1, maximum: 65536, description: 'Maximum characters to return.' },
            },
            additionalProperties: false,
        },
    },
    {
        name: 'issh_batch_exec',
        scope: 'exec',
        description: 'Execute one command across selected terminal sessions. Multi-session execution requires native user confirmation.',
        inputSchema: {
            type: 'object',
            required: ['command'],
            properties: {
                tabs: {
                    oneOf: [
                        { type: 'string', minLength: 1 },
                        { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 } },
                    ],
                    description: 'A tab id, "active", "all-ssh", or an array of tab ids.',
                },
                command: commandProperty,
                timeoutMs: { type: 'number', minimum: 1, maximum: 3600000 },
                cwd: { type: 'string', minLength: 1 },
                parallel: { type: 'boolean', description: 'Run targets in parallel when true; serially when false.' },
                confirmDangerous: confirmDangerousProperty,
            },
            additionalProperties: false,
        },
    },
    {
        name: 'issh_sftp_list',
        scope: 'sftp',
        description: 'List files in a remote directory through the selected SSH session.',
        inputSchema: {
            type: 'object',
            required: ['path'],
            properties: {
                tab: tabProperty,
                path: { type: 'string', minLength: 1, description: 'Remote directory path.' },
            },
            additionalProperties: false,
        },
    },
    {
        name: 'issh_sftp_read',
        scope: 'sftp',
        description: 'Read a remote file through SFTP. Use base64 encoding for binary data.',
        inputSchema: {
            type: 'object',
            required: ['path'],
            properties: {
                tab: tabProperty,
                path: { type: 'string', minLength: 1, description: 'Remote file path.' },
                encoding: { type: 'string', enum: ['utf8', 'base64'] },
                maxBytes: { type: 'number', minimum: 1, maximum: 1048576, description: 'Maximum bytes to read.' },
            },
            additionalProperties: false,
        },
    },
    {
        name: 'issh_sftp_write',
        scope: 'sftp',
        description: 'Write a remote file through SFTP. Use base64 encoding for binary data.',
        inputSchema: {
            type: 'object',
            required: ['path', 'content'],
            properties: {
                tab: tabProperty,
                path: { type: 'string', minLength: 1, description: 'Remote file path.' },
                content: { type: 'string', description: 'File content in the selected encoding.' },
                encoding: { type: 'string', enum: ['utf8', 'base64'] },
            },
            additionalProperties: false,
        },
    },
]

export const LEGACY_AGENT_BRIDGE_METHOD_ALIASES = Object.freeze(Object.fromEntries(
    AGENT_BRIDGE_TOOLS.map(tool => [tool.name.replace(/^issh_/, 'tabby_'), tool.name]),
))

export function normalizeAgentBridgeMethod (method) {
    return LEGACY_AGENT_BRIDGE_METHOD_ALIASES[method] ?? method
}

const primaryMethodScopes = Object.fromEntries(
    AGENT_BRIDGE_TOOLS.map(tool => [tool.name, tool.scope]),
)

export const AGENT_BRIDGE_METHOD_SCOPES = Object.freeze({
    ...primaryMethodScopes,
    ...Object.fromEntries(Object.entries(LEGACY_AGENT_BRIDGE_METHOD_ALIASES).map(([legacy, primary]) => [legacy, primaryMethodScopes[primary]])),
})

export function getMcpTools () {
    return AGENT_BRIDGE_TOOLS.map(({ scope: _scope, ...tool }) => tool)
}
