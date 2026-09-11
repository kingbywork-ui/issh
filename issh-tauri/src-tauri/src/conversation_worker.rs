use serde_json::{json, Value};
use std::path::Path;
use std::process::Stdio;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};

pub struct ConversationWorker {
    child: Child,
    input: ChildStdin,
    output: BufReader<ChildStdout>,
    sequence: u64,
}

impl ConversationWorker {
    pub async fn shutdown(&mut self) {
        let _ = self.input.shutdown().await;
        if tokio::time::timeout(Duration::from_secs(2), self.child.wait())
            .await
            .is_err()
        {
            let _ = self.child.kill().await;
        }
    }
    pub fn start(user_data: &Path) -> Result<Self, String> {
        let mut script = user_data.join("agent-bridge/bin/issh-conversation-worker.mjs");
        if cfg!(debug_assertions) && !script.is_file() {
            script = Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../issh-agent/bin/issh-conversation-worker.mjs");
        }
        if !script.is_file() {
            return Err("安装包缺少 Agent 通讯运行时，请更新 issh".into());
        }
        let mut command = Command::new(if cfg!(windows) { "node.exe" } else { "node" });
        command
            .arg(script)
            .arg(user_data.join("agent-conversations.json"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        #[cfg(windows)]
        command.creation_flags(0x08000000);
        let mut child = command.spawn().map_err(|error| {
            format!("无法启动 Agent 通讯服务，请确认已安装 Node.js 并加入 PATH：{error}")
        })?;
        let input = child.stdin.take().ok_or("通讯服务缺少输入管道")?;
        let output = BufReader::new(child.stdout.take().ok_or("通讯服务缺少输出管道")?);
        Ok(Self {
            child,
            input,
            output,
            sequence: 0,
        })
    }

    pub async fn call(
        &mut self,
        method: &str,
        params: Value,
        registry: Value,
    ) -> Result<Value, String> {
        if self.child.try_wait().map_err(|e| e.to_string())?.is_some() {
            return Err("Agent 通讯进程已退出；请重试读取状态，未自动重发消息".into());
        }
        self.sequence += 1;
        let id = self.sequence;
        let line = serde_json::to_vec(
            &json!({"id": id, "method": method, "params": params, "registry": registry}),
        )
        .map_err(|e| e.to_string())?;
        self.input
            .write_all(&line)
            .await
            .map_err(|e| e.to_string())?;
        self.input
            .write_all(b"\n")
            .await
            .map_err(|e| e.to_string())?;
        let result = tokio::time::timeout(Duration::from_secs(10), async {
            let mut data = Vec::new();
            loop {
                let buffer = self.output.fill_buf().await.map_err(|e| e.to_string())?;
                if buffer.is_empty() {
                    return Err("Agent 通讯服务已关闭，投递结果未知；未自动重发".to_string());
                }
                let end = buffer.iter().position(|b| *b == b'\n');
                let length = end.map_or(buffer.len(), |i| i + 1);
                data.extend_from_slice(&buffer[..length]);
                self.output.consume(length);
                if data.len() > 32 * 1024 * 1024 {
                    return Err("会话响应超过大小限制".to_string());
                }
                if end.is_some() {
                    break;
                }
            }
            let response: Value = serde_json::from_slice(&data).map_err(|e| e.to_string())?;
            if response["id"].as_u64() != Some(id) {
                return Err("通讯服务响应序号不匹配".into());
            }
            Ok(response)
        })
        .await
        .map_err(|_| "读取通讯服务超时；投递结果未知，请先查看会话记录".to_string())??;
        // Domain errors keep the worker alive; process/protocol errors cause
        // the owner to discard it instead of reading a stale next response.
        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn worker_roundtrip_and_restart_preserve_registered_room() {
        let dir = std::env::temp_dir().join(format!(
            "issh-worker-test-{}-{}",
            std::process::id(),
            rand::random::<u64>()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let registry = json!({"workspaceId":"w", "agents":[{"id":"a","name":"A","workspaceId":"w","scopes":["llm.prompt"]},{"id":"b","name":"B","workspaceId":"w","scopes":["llm.prompt"]}]});
        let mut worker = ConversationWorker::start(&dir).unwrap();
        let rejected = worker
            .call(
                "conversation.create",
                json!({"agentIds":["a","other"]}),
                registry.clone(),
            )
            .await
            .unwrap();
        assert!(rejected.get("error").is_some());
        let response = worker
            .call(
                "conversation.create",
                json!({"agentIds":["a","b"]}),
                registry.clone(),
            )
            .await
            .unwrap();
        let id = response["result"]["id"].clone();
        assert!(id.is_string());
        worker.shutdown().await;
        let mut reopened = ConversationWorker::start(&dir).unwrap();
        let room = reopened
            .call("conversation.read", json!({"conversationId":id}), registry)
            .await
            .unwrap();
        assert_eq!(room["result"]["title"], "A ↔ B");
        reopened.shutdown().await;
        std::fs::remove_dir_all(dir).unwrap();
    }
}
