use crate::mcp_remote::RemoteMcpConnection;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::process::Stdio;
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio::sync::Mutex;
use tokio::time::{timeout, Duration};

const MAX_LINE: usize = 1024 * 1024;

struct StdioConnection {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    next_id: u64,
}

impl StdioConnection {
    async fn call(&mut self, method: &str, params: Value) -> Result<Value, String> {
        self.next_id += 1;
        let id = self.next_id;
        let wire =
            json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}).to_string() + "\n";
        self.stdin
            .write_all(wire.as_bytes())
            .await
            .map_err(|e| format!("MCP 写入失败：{e}"))?;
        timeout(Duration::from_secs(30), async {
            loop {
                let mut line = Vec::new();
                loop {
                    let available = self.stdout.fill_buf().await.map_err(|e| e.to_string())?;
                    if available.is_empty() {
                        return Err("MCP 服务已退出".to_string());
                    }
                    let count = available
                        .iter()
                        .position(|byte| *byte == b'\n')
                        .map_or(available.len(), |position| position + 1);
                    if line.len() + count > MAX_LINE {
                        return Err("MCP 响应超过 1 MiB".to_string());
                    }
                    let complete = available[count - 1] == b'\n';
                    line.extend_from_slice(&available[..count]);
                    self.stdout.consume(count);
                    if complete {
                        break;
                    }
                }
                let value: Value =
                    serde_json::from_slice(&line).map_err(|e| format!("MCP 响应格式错误：{e}"))?;
                if value.get("id") != Some(&json!(id)) {
                    continue;
                }
                if let Some(error) = value.get("error") {
                    return Err(error
                        .get("message")
                        .and_then(Value::as_str)
                        .unwrap_or("MCP 调用失败")
                        .to_string());
                }
                return Ok(value.get("result").cloned().unwrap_or(Value::Null));
            }
        })
        .await
        .map_err(|_| "MCP 请求超时".to_string())?
    }

    async fn notify(&mut self, method: &str) -> Result<(), String> {
        let wire = json!({"jsonrpc":"2.0","method":method}).to_string() + "\n";
        self.stdin
            .write_all(wire.as_bytes())
            .await
            .map_err(|e| e.to_string())
    }
}

enum Connection {
    Stdio(StdioConnection),
    Remote(RemoteMcpConnection),
}

impl Connection {
    async fn call(&mut self, method: &str, params: Value) -> Result<Value, String> {
        match self {
            Self::Stdio(connection) => connection.call(method, params).await,
            Self::Remote(connection) => connection.call(method, params).await,
        }
    }
}

#[derive(Default)]
pub struct LocalMcpManager {
    connections: Mutex<HashMap<String, Arc<Mutex<Connection>>>>,
}

impl LocalMcpManager {
    fn key(plugin: &str, server: &str) -> Result<String, String> {
        if server.is_empty()
            || server.len() > 64
            || !server
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        {
            return Err("MCP 服务 ID 无效".to_string());
        }
        Ok(format!("{plugin}:{server}"))
    }

    pub async fn connect(&self, plugin: &str, args: &Value) -> Result<Value, String> {
        let server = args
            .get("serverId")
            .and_then(Value::as_str)
            .ok_or("缺少 serverId")?;
        let key = Self::key(plugin, server)?;
        if self.connections.lock().await.contains_key(&key) {
            return Err("MCP 服务已连接".to_string());
        }
        let transport = args
            .get("transport")
            .and_then(Value::as_str)
            .unwrap_or("stdio");
        if transport != "stdio" && transport != "streamable-http" && transport != "sse" {
            return Err("不支持的 MCP 连接方式".to_string());
        }
        if transport != "stdio" {
            let mut connection = RemoteMcpConnection::connect(args, transport).await?;
            let init = connection.call("initialize", json!({"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"issh-ai-assistant","version":"0.2.1"}})).await?;
            connection.notify("notifications/initialized").await?;
            let result = json!({"serverId":server,"serverInfo":init.get("serverInfo"),"capabilities":init.get("capabilities")});
            let mut connections = self.connections.lock().await;
            if connections.len() >= 8 || connections.contains_key(&key) {
                return Err("MCP 连接数超过上限或服务已连接".to_string());
            }
            connections.insert(key, Arc::new(Mutex::new(Connection::Remote(connection))));
            return Ok(result);
        }
        let command = args
            .get("command")
            .and_then(Value::as_str)
            .ok_or("缺少 command")?
            .trim();
        if command.is_empty() || command.len() > 2048 || command.contains(['\n', '\r', '\0']) {
            return Err("MCP 命令无效".to_string());
        }
        let arguments = args
            .get("arguments")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        if arguments.len() > 32
            || arguments.iter().any(|v| {
                v.as_str()
                    .is_none_or(|s| s.len() > 4096 || s.contains('\0'))
            })
        {
            return Err("MCP 参数无效".to_string());
        }
        let environment = args.get("environment").and_then(Value::as_object);
        if environment.is_some_and(|env| {
            env.len() > 32
                || env.iter().any(|(k, v)| {
                    k.len() > 128
                        || k.contains(['=', '\0'])
                        || v.as_str()
                            .is_none_or(|s| s.len() > 4096 || s.contains('\0'))
                })
        }) {
            return Err("MCP 环境变量无效".to_string());
        }
        let mut process = Command::new(command);
        process.args(arguments.iter().filter_map(Value::as_str));
        if let Some(cwd) = args
            .get("cwd")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
        {
            process.current_dir(cwd);
        }
        if let Some(env) = environment {
            for (k, v) in env {
                process.env(k, v.as_str().unwrap_or_default());
            }
        }
        process
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        let mut child = process
            .spawn()
            .map_err(|e| format!("启动 MCP 服务失败：{e}"))?;
        let stdin = child.stdin.take().ok_or("MCP stdin 不可用")?;
        let stdout = child.stdout.take().ok_or("MCP stdout 不可用")?;
        let mut connection = StdioConnection {
            child,
            stdin,
            stdout: BufReader::new(stdout),
            next_id: 0,
        };
        let init = connection.call("initialize", json!({"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"issh-ai-assistant","version":"0.2.1"}})).await?;
        connection.notify("notifications/initialized").await?;
        let result = json!({"serverId":server,"serverInfo":init.get("serverInfo"),"capabilities":init.get("capabilities")});
        let mut connections = self.connections.lock().await;
        if connections.len() >= 8 {
            return Err("MCP 连接数超过上限".to_string());
        }
        if connections.contains_key(&key) {
            return Err("MCP 服务已连接".to_string());
        }
        connections.insert(key, Arc::new(Mutex::new(Connection::Stdio(connection))));
        Ok(result)
    }

    pub async fn list_tools(&self, plugin: &str, args: &Value) -> Result<Value, String> {
        let connection = self.get(plugin, args).await?;
        let mut connection = connection.lock().await;
        let mut tools = Vec::new();
        let mut cursor: Option<String> = None;
        for _ in 0..8 {
            let params = cursor
                .as_ref()
                .map_or_else(|| json!({}), |value| json!({"cursor":value}));
            let result = connection.call("tools/list", params).await?;
            if let Some(items) = result.get("tools").and_then(Value::as_array) {
                tools.extend(items.iter().take(100 - tools.len()).cloned());
            }
            if tools.len() >= 100 {
                break;
            }
            cursor = result
                .get("nextCursor")
                .and_then(Value::as_str)
                .map(str::to_string);
            if cursor.is_none() {
                break;
            }
        }
        Ok(json!({"tools":tools}))
    }

    pub async fn call_tool(&self, plugin: &str, args: &Value) -> Result<Value, String> {
        let name = args
            .get("name")
            .and_then(Value::as_str)
            .ok_or("缺少工具名称")?;
        if name.is_empty() || name.len() > 256 {
            return Err("工具名称无效".to_string());
        }
        let arguments = args.get("arguments").cloned().unwrap_or_else(|| json!({}));
        let connection = self.get(plugin, args).await?;
        let result = connection
            .lock()
            .await
            .call("tools/call", json!({"name":name,"arguments":arguments}))
            .await?;
        if serde_json::to_vec(&result).map_or(0, |v| v.len()) > MAX_LINE {
            return Err("工具结果超过 1 MiB".to_string());
        }
        Ok(result)
    }

    pub async fn disconnect(&self, plugin: &str, args: &Value) -> Result<Value, String> {
        let server = args
            .get("serverId")
            .and_then(Value::as_str)
            .ok_or("缺少 serverId")?;
        let key = Self::key(plugin, server)?;
        if let Some(connection) = self.connections.lock().await.remove(&key) {
            match &mut *connection.lock().await {
                Connection::Stdio(connection) => {
                    connection.child.kill().await.map_err(|e| e.to_string())?
                }
                Connection::Remote(connection) => connection.disconnect().await,
            }
        }
        Ok(json!({"serverId":server,"disconnected":true}))
    }

    async fn get(&self, plugin: &str, args: &Value) -> Result<Arc<Mutex<Connection>>, String> {
        let server = args
            .get("serverId")
            .and_then(Value::as_str)
            .ok_or("缺少 serverId")?;
        let key = Self::key(plugin, server)?;
        self.connections
            .lock()
            .await
            .get(&key)
            .cloned()
            .ok_or("MCP 服务未连接".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn local_stdio_server_lists_and_calls_tools() {
        let fixture = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../plugins/issh-plugin-ai-assistant/scripts/mcp-fixture.mjs");
        let manager = LocalMcpManager::default();
        manager
            .connect(
                "issh-plugin-ai-assistant",
                &json!({
                    "serverId":"fixture", "command":"node", "arguments":[fixture.to_string_lossy()]
                }),
            )
            .await
            .unwrap();
        let tools = manager
            .list_tools("issh-plugin-ai-assistant", &json!({"serverId":"fixture"}))
            .await
            .unwrap();
        assert_eq!(tools["tools"][0]["name"], "echo");
        let result = manager
            .call_tool(
                "issh-plugin-ai-assistant",
                &json!({"serverId":"fixture","name":"echo","arguments":{"text":"你好"}}),
            )
            .await
            .unwrap();
        assert_eq!(result["content"][0]["text"], "你好");
        assert!(manager
            .call_tool(
                "another-plugin",
                &json!({"serverId":"fixture","name":"echo"})
            )
            .await
            .is_err());
        manager
            .disconnect("issh-plugin-ai-assistant", &json!({"serverId":"fixture"}))
            .await
            .unwrap();
    }
}
