export interface CodexDesktopConfigFields {
    name: string
    type: 'STDIO'
    command: string
    argument: string
    environmentVariableName: string
    environmentVariableValue: string
    environmentVariablePassthrough: string
    workingDirectory: string
}

export function buildCodexDesktopConfigFields (
    mcpServerScriptPath: string,
    connectionFile: string | null,
): CodexDesktopConfigFields {
    return {
        name: 'issh',
        type: 'STDIO',
        command: 'node',
        argument: mcpServerScriptPath,
        environmentVariableName: 'TABBY_AGENT_BRIDGE_FILE',
        environmentVariableValue: connectionFile ?? '<桥接服务启动后显示的连接文件路径>',
        environmentVariablePassthrough: '',
        workingDirectory: '',
    }
}

export function formatCodexDesktopConfigGuide (fields: CodexDesktopConfigFields): string {
    return [
        'Codex Desktop 自定义 MCP',
        `名称：${fields.name}`,
        `类型：${fields.type}`,
        `启动命令：${fields.command}`,
        `参数：${fields.argument}`,
        `环境变量：${fields.environmentVariableName}=${fields.environmentVariableValue}`,
        '环境变量传递：留空',
        '工作目录：留空',
    ].join('\n')
}
