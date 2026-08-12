import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import ts from 'typescript'

const sourcePath = path.resolve('issh-llm/src/services/codexDesktopConfig.ts')
const source = fs.readFileSync(sourcePath, 'utf8')
const compiled = ts.transpileModule(source, {
    compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2020,
    },
    fileName: sourcePath,
})
const module = { exports: {} }
vm.runInNewContext(compiled.outputText, {
    exports: module.exports,
    module,
}, {
    filename: sourcePath,
})

const {
    buildCodexDesktopConfigFields,
    formatCodexDesktopConfigGuide,
} = module.exports

const scriptPath = 'C:\\Users\\tester\\AppData\\Roaming\\issh\\agent-bridge\\bin\\issh-mcp-server.mjs'
const bridgeFile = 'C:\\Users\\tester\\AppData\\Roaming\\issh\\issh-agent-bridge.json'
const fields = buildCodexDesktopConfigFields(scriptPath, bridgeFile)

assert.deepEqual({ ...fields }, {
    name: 'issh',
    type: 'STDIO',
    command: 'node',
    argument: scriptPath,
    environmentVariableName: 'ISSH_AGENT_BRIDGE_FILE',
    environmentVariableValue: bridgeFile,
    environmentVariablePassthrough: '',
    workingDirectory: '',
})

const guide = formatCodexDesktopConfigGuide(fields)
assert.match(guide, /类型：STDIO/)
assert.match(guide, /启动命令：node/)
assert.match(guide, /ISSH_AGENT_BRIDGE_FILE=/)
assert.doesNotMatch(guide, /流式 HTTP|\/sse/)

const pendingFields = buildCodexDesktopConfigFields(scriptPath, null)
assert.match(pendingFields.environmentVariableValue, /桥接服务启动后/)

const template = fs.readFileSync(
    path.resolve('issh-llm/src/components/agentBridgeSettingsTab.component.pug'),
    'utf8',
)
assert.match(template, /选择你的 AI 客户端/)
assert.match(template, /selectedAgentConfigItems/)
assert.match(template, /copyAgentConfigItem/)
assert.match(template, /agentConfigOptions/)
assert.match(template, /逐项复制参数/)

console.log('Codex Desktop MCP configuration tests passed')
