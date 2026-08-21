use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{Manager, Runtime, State, WebviewUrl, WebviewWindowBuilder};
use tokio::sync::Mutex as AsyncMutex;

const MAX_MESSAGE_BYTES: usize = 64 * 1024;
const PROTOCOL_VERSION: &str = "0.4.0";

struct RuntimeManager {
    pipe_name: String,
    database_path: PathBuf,
    binary_path: PathBuf,
    child: Mutex<Option<Child>>,
    startup: AsyncMutex<()>,
}

impl RuntimeManager {
    fn new<R: Runtime>(app: &tauri::AppHandle<R>) -> Result<Self, String> {
        let user_data = match std::env::var_os("ISSH_CONFIG_DIRECTORY") {
            Some(path) => PathBuf::from(path),
            None => app
                .path()
                .app_data_dir()
                .map_err(|error| format!("无法定位应用数据目录：{error}"))?,
        };
        let digest = Sha256::digest(user_data.to_string_lossy().as_bytes());
        let instance_key = hex_prefix(&digest, 8);
        let binary_path = resolve_runtime_binary(app)?;
        Ok(Self {
            pipe_name: format!(r"\\.\pipe\issh-runtime-{instance_key}"),
            database_path: user_data.join("runtime").join("issh-runtime.sqlite3"),
            binary_path,
            child: Mutex::new(None),
            startup: AsyncMutex::new(()),
        })
    }

    async fn request(&self, request: Value) -> Result<Value, String> {
        validate_request(&request)?;
        self.ensure_started().await?;
        send_request(&self.pipe_name, &request, Duration::from_secs(5)).await
    }

    async fn ensure_started(&self) -> Result<(), String> {
        let _startup = self.startup.lock().await;
        let health_request = json!({
            "jsonrpc": "2.0",
            "id": "tauri-startup-health",
            "method": "runtime.health"
        });
        if let Ok(health) =
            send_request(&self.pipe_name, &health_request, Duration::from_millis(500)).await
        {
            return assert_compatible(&health);
        }

        if let Some(parent) = self.database_path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|error| format!("无法创建 Runtime 数据目录：{error}"))?;
        }

        let mut command = Command::new(&self.binary_path);
        command
            .args(["--pipe", &self.pipe_name, "--database"])
            .arg(&self.database_path)
            .current_dir(self.binary_path.parent().unwrap_or_else(|| Path::new(".")))
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x0800_0000);
        }
        let child = command
            .spawn()
            .map_err(|error| format!("无法启动 {}：{error}", self.binary_path.display()))?;
        *self
            .child
            .lock()
            .map_err(|_| "Runtime 子进程状态不可用".to_string())? = Some(child);

        let mut last_error = "Runtime 尚未响应".to_string();
        for _ in 0..50 {
            let exited = {
                let mut child = self
                    .child
                    .lock()
                    .map_err(|_| "Runtime 子进程状态不可用".to_string())?;
                match child.as_mut() {
                    Some(child) => child
                        .try_wait()
                        .map_err(|error| format!("无法读取 Runtime 进程状态：{error}"))?,
                    None => None,
                }
            };
            if let Some(status) = exited {
                return Err(format!("isshd 在启动期间退出：{status}"));
            }
            match send_request(&self.pipe_name, &health_request, Duration::from_millis(500)).await {
                Ok(health) => return assert_compatible(&health),
                Err(error) => last_error = error,
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        self.stop();
        Err(format!("isshd 未能就绪：{last_error}"))
    }

    fn stop(&self) {
        if let Ok(mut slot) = self.child.lock() {
            if let Some(mut child) = slot.take() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }
}

#[tauri::command]
async fn runtime_health(manager: State<'_, RuntimeManager>) -> Result<Value, String> {
    manager
        .request(json!({
            "jsonrpc": "2.0",
            "id": "tauri-runtime-health",
            "method": "runtime.health"
        }))
        .await
}

#[tauri::command]
async fn runtime_request(
    manager: State<'_, RuntimeManager>,
    request: Value,
) -> Result<Value, String> {
    manager.request(request).await
}

pub fn run() {
    let app = tauri::Builder::default()
        .setup(|app| {
            app.manage(RuntimeManager::new(app.handle())?);
            if app.get_webview_window("main").is_none() {
                WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                    .title("issh")
                    .inner_size(1180.0, 760.0)
                    .min_inner_size(760.0, 560.0)
                    .resizable(true)
                    .center()
                    .build()
                    .map_err(|error| format!("无法创建 issh 主窗口：{error}"))?;
            }
            if let Some(window) = app.get_webview_window("main") {
                window
                    .show()
                    .map_err(|error| format!("无法显示 issh 主窗口：{error}"))?;
                window
                    .set_focus()
                    .map_err(|error| format!("无法聚焦 issh 主窗口：{error}"))?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![runtime_health, runtime_request])
        .build(tauri::generate_context!())
        .expect("failed to build issh Tauri client");

    app.run(|handle, event| {
        if matches!(event, tauri::RunEvent::Exit) {
            handle.state::<RuntimeManager>().stop();
        }
    });
}

fn validate_request(request: &Value) -> Result<(), String> {
    let valid_id = request
        .get("id")
        .is_some_and(|id| id.is_string() || id.is_number());
    if request.get("jsonrpc") != Some(&Value::String("2.0".to_string()))
        || !valid_id
        || !request
            .get("method")
            .is_some_and(|method| method.is_string())
    {
        return Err("Runtime 请求格式无效".to_string());
    }
    let bytes = serde_json::to_vec(request).map_err(|error| error.to_string())?;
    if bytes.len() > MAX_MESSAGE_BYTES {
        return Err(format!("Runtime 请求超过 {MAX_MESSAGE_BYTES} 字节"));
    }
    Ok(())
}

fn assert_compatible(response: &Value) -> Result<(), String> {
    let result = response
        .get("result")
        .ok_or_else(|| "Runtime 健康响应缺少 result".to_string())?;
    let compatible = result.get("protocolVersion").and_then(Value::as_str)
        == Some(PROTOCOL_VERSION)
        && result
            .get("capabilities")
            .and_then(Value::as_array)
            .is_some_and(|capabilities| {
                capabilities
                    .iter()
                    .any(|item| item.as_str() == Some("workspace.list"))
            });
    if compatible {
        Ok(())
    } else {
        Err(format!("Runtime 协议不兼容，需要 {PROTOCOL_VERSION}"))
    }
}

fn hex_prefix(bytes: &[u8], count: usize) -> String {
    bytes
        .iter()
        .take(count)
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn resolve_runtime_binary<R: Runtime>(app: &tauri::AppHandle<R>) -> Result<PathBuf, String> {
    let executable = if cfg!(windows) { "isshd.exe" } else { "isshd" };
    let mut candidates = Vec::new();
    if let Some(path) = std::env::var_os("ISSH_RUNTIME_BIN") {
        candidates.push(PathBuf::from(path));
    }
    if let Ok(resource_dir) = app.path().resource_dir() {
        candidates.push(resource_dir.join("issh-runtime").join(executable));
    }
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    if let Some(repository_root) = manifest_dir.parent().and_then(Path::parent) {
        candidates.push(
            repository_root
                .join("issh-runtime")
                .join("target")
                .join("debug")
                .join(executable),
        );
        candidates.push(
            repository_root
                .join("issh-runtime")
                .join("target")
                .join("x86_64-pc-windows-msvc")
                .join("debug")
                .join(executable),
        );
    }
    candidates
        .into_iter()
        .find(|candidate| candidate.is_file())
        .ok_or_else(|| "找不到 isshd；请先构建 issh-runtime 或设置 ISSH_RUNTIME_BIN".to_string())
}

#[cfg(windows)]
async fn send_request(
    pipe_name: &str,
    request: &Value,
    timeout: Duration,
) -> Result<Value, String> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::windows::named_pipe::ClientOptions;

    let operation = async {
        let mut client = loop {
            match ClientOptions::new().open(pipe_name) {
                Ok(client) => break client,
                Err(error) if matches!(error.raw_os_error(), Some(2 | 231)) => {
                    tokio::time::sleep(Duration::from_millis(25)).await;
                }
                Err(error) => return Err(format!("无法连接 Runtime Named Pipe：{error}")),
            }
        };
        let mut payload = serde_json::to_vec(request).map_err(|error| error.to_string())?;
        payload.push(b'\n');
        client
            .write_all(&payload)
            .await
            .map_err(|error| format!("写入 Runtime 失败：{error}"))?;
        client
            .shutdown()
            .await
            .map_err(|error| format!("结束 Runtime 请求失败：{error}"))?;

        let mut response = Vec::new();
        client
            .take((MAX_MESSAGE_BYTES + 1) as u64)
            .read_to_end(&mut response)
            .await
            .map_err(|error| format!("读取 Runtime 响应失败：{error}"))?;
        if response.len() > MAX_MESSAGE_BYTES {
            return Err(format!("Runtime 响应超过 {MAX_MESSAGE_BYTES} 字节"));
        }
        serde_json::from_slice::<Value>(&response)
            .map_err(|error| format!("Runtime 响应不是有效 JSON：{error}"))
    };
    tokio::time::timeout(timeout, operation)
        .await
        .map_err(|_| format!("Runtime 请求在 {} ms 后超时", timeout.as_millis()))?
}

#[cfg(not(windows))]
async fn send_request(
    _pipe_name: &str,
    _request: &Value,
    _timeout: Duration,
) -> Result<Value, String> {
    Err("当前迁移阶段仅实现 Windows Named Pipe".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_runtime_request_shape_and_size() {
        assert!(validate_request(&json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "runtime.health"
        }))
        .is_ok());
        assert!(validate_request(&json!({ "method": "runtime.health" })).is_err());
        assert!(validate_request(&json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "pane.write",
            "params": { "data": "x".repeat(MAX_MESSAGE_BYTES) }
        }))
        .is_err());
    }

    #[test]
    fn accepts_only_compatible_health() {
        assert!(assert_compatible(&json!({
            "result": {
                "protocolVersion": "0.4.0",
                "capabilities": ["workspace.list"]
            }
        }))
        .is_ok());
        assert!(assert_compatible(&json!({
            "result": {
                "protocolVersion": "0.3.0",
                "capabilities": ["workspace.list"]
            }
        }))
        .is_err());
    }
}
