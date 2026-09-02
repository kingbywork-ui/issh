mod clipboard;
mod host_profiles;
mod plugin_market;

use host_profiles::{
    CredentialMutation, HostProfileMutation, HostProfileStore, HostProfilesResult,
};
use plugin_market::{InstalledPlugin, PluginRegistry};
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
    auth_token: String,
    child: Mutex<Option<Child>>,
    startup: AsyncMutex<()>,
    hosts: HostProfileStore,
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
        let auth_token = generate_auth_token();
        Ok(Self {
            pipe_name: format!(r"\\.\pipe\issh-runtime-{instance_key}"),
            database_path: user_data.join("runtime").join("issh-runtime.sqlite3"),
            binary_path,
            auth_token,
            child: Mutex::new(None),
            startup: AsyncMutex::new(()),
            hosts: HostProfileStore::new(&user_data),
        })
    }

    async fn request(&self, mut request: Value) -> Result<Value, String> {
        validate_request(&request)?;
        inject_auth_token(&mut request, &self.auth_token);
        self.ensure_started().await?;
        send_request(&self.pipe_name, &request, request_timeout(&request)).await
    }

    async fn ensure_started(&self) -> Result<(), String> {
        let _startup = self.startup.lock().await;
        let mut health_request = json!({
            "jsonrpc": "2.0",
            "id": "tauri-startup-health",
            "method": "runtime.health"
        });
        inject_auth_token(&mut health_request, &self.auth_token);
        // pipe 可达但握手失败（如升级重装后残留旧 isshd、auth token 已轮换返回
        // Unauthorized 错误响应）：杀掉占用本 pipe 的残留进程后继续走 spawn 流程，
        // 而不是把「Runtime 健康响应缺少 result」直接抛给用户。
        match send_request(&self.pipe_name, &health_request, Duration::from_millis(500)).await {
            Ok(health) => match assert_compatible(&health) {
                Ok(()) => return Ok(()),
                Err(_) => self.terminate_stale_runtime(),
            },
            Err(_) => {}
        }

        if let Some(parent) = self.database_path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|error| format!("无法创建 Runtime 数据目录：{error}"))?;
        }

        let mut command = Command::new(&self.binary_path);
        command
            .args(["--pipe", &self.pipe_name, "--database"])
            .arg(&self.database_path)
            .args(["--auth-token", &self.auth_token])
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

    fn terminate_stale_runtime(&self) {
        // 清理占用本实例 pipe 的残留 isshd：升级重装后旧进程可能仍存活，但持有
        // 已轮换的 auth token，会让健康检查永远失败。按进程名 + pipe 名精确匹配，
        // 避免误杀其它实例或无关进程。
        let process_name = self
            .binary_path
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_else(|| "isshd.exe".to_string());
        let marker = self.pipe_name.trim_start_matches(r"\\.\pipe\");
        if marker.is_empty() {
            return;
        }
        let script = format!(
            "Get-CimInstance Win32_Process -Filter \"Name = '{process_name}'\" | \
             Where-Object {{ $_.CommandLine -like '*{marker}*' }} | \
             ForEach-Object {{ Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }}"
        );
        let mut command = Command::new("powershell");
        command
            .args(["-NoProfile", "-NonInteractive", "-Command", &script])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x0800_0000);
        }
        let _ = command.output();
        // 等待内核释放 pipe 句柄，避免新 isshd 绑定失败。
        std::thread::sleep(Duration::from_millis(250));
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
fn relaunch_elevated(app: tauri::AppHandle) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        let exe = std::env::current_exe()
            .map_err(|error| format!("无法定位当前程序：{error}"))?;
        let mut command = std::process::Command::new("powershell");
        command
            .args([
                "-NoProfile",
                "-Command",
                "Start-Process",
                "-FilePath",
            ])
            .arg(&exe)
            .args(["-Verb", "RunAs"])
            .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
            .spawn()
            .map_err(|error| format!("提权启动失败：{error}"))?;
        let _ = app;
        Ok(())
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = app;
        Err("仅 Windows 支持管理员重启".to_string())
    }
}

#[tauri::command]
async fn runtime_request(
    manager: State<'_, RuntimeManager>,
    request: Value,
) -> Result<Value, String> {
    manager.request(request).await
}

#[tauri::command]
fn host_profiles(manager: State<'_, RuntimeManager>) -> Result<HostProfilesResult, String> {
    manager.hosts.read()
}

#[tauri::command]
fn unlock_host_profiles(
    manager: State<'_, RuntimeManager>,
    passphrase: String,
) -> Result<HostProfilesResult, String> {
    manager.hosts.unlock(&passphrase)
}

#[tauri::command]
fn lock_host_profiles(manager: State<'_, RuntimeManager>) -> Result<HostProfilesResult, String> {
    manager.hosts.lock();
    manager.hosts.read()
}

#[tauri::command]
fn mutate_host_profiles(
    manager: State<'_, RuntimeManager>,
    mutation: HostProfileMutation,
) -> Result<HostProfilesResult, String> {
    manager.hosts.mutate(mutation)
}

#[tauri::command]
fn host_credentials(manager: State<'_, RuntimeManager>) -> Result<host_profiles::HostCredentialsResult, String> {
    manager.hosts.list_credentials()
}

#[tauri::command]
fn save_host_credential(
    manager: State<'_, RuntimeManager>,
    mutation: CredentialMutation,
) -> Result<host_profiles::HostCredentialsResult, String> {
    manager.hosts.save_credential(mutation)
}

#[tauri::command]
fn delete_host_credential(
    manager: State<'_, RuntimeManager>,
    user: String,
    host: String,
    port: u16,
) -> Result<host_profiles::HostCredentialsResult, String> {
    manager.hosts.delete_credential(&user, &host, port)
}

#[tauri::command]
fn enable_host_vault(
    manager: State<'_, RuntimeManager>,
    passphrase: String,
) -> Result<host_profiles::HostCredentialsResult, String> {
    manager.hosts.enable_vault(&passphrase)
}

#[tauri::command]
fn disable_host_vault(manager: State<'_, RuntimeManager>) -> Result<host_profiles::HostCredentialsResult, String> {
    manager.hosts.disable_vault()
}

#[tauri::command]
fn change_host_passphrase(
    manager: State<'_, RuntimeManager>,
    old_passphrase: String,
    new_passphrase: String,
) -> Result<host_profiles::HostCredentialsResult, String> {
    manager.hosts.change_passphrase(&old_passphrase, &new_passphrase)
}

#[tauri::command]
fn resolve_ssh_password(
    manager: State<'_, RuntimeManager>,
    user: String,
    host: String,
    port: u16,
) -> Result<Option<String>, String> {
    manager.hosts.resolve_ssh_password(&user, &host, port)
}

#[tauri::command]
fn clipboard_write_text(text: String) -> Result<(), String> {
    clipboard::write_text(&text)
}

#[tauri::command]
fn clipboard_read_text() -> Result<String, String> {
    clipboard::read_text()
}

#[tauri::command]
fn resolve_sudo_password(
    manager: State<'_, RuntimeManager>,
    user: String,
    host: String,
    port: u16,
) -> Result<Option<String>, String> {
    manager.hosts.resolve_sudo_password(&user, &host, port)
}

#[tauri::command]
fn resolve_key_passphrase(
    manager: State<'_, RuntimeManager>,
    user: String,
    host: String,
    port: u16,
    key_path: Option<String>,
) -> Result<Option<String>, String> {
    manager
        .hosts
        .resolve_key_passphrase(&user, &host, port, key_path.as_deref())
}

#[tauri::command]
async fn plugin_fetch_registry(url: String) -> Result<PluginRegistry, String> {
    plugin_market::fetch_registry(&url).await
}

#[tauri::command]
async fn plugin_download(
    app: tauri::AppHandle,
    id: String,
    url: String,
    sha256: String,
    signature: Option<String>,
    version: Option<String>,
) -> Result<InstalledPlugin, String> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("无法定位应用数据目录：{error}"))?;
    plugin_market::download_plugin(
        &app_data,
        &id,
        &url,
        &sha256,
        signature.as_deref(),
        version.as_deref().unwrap_or(""),
    )
    .await
}

#[tauri::command]
fn plugin_list_installed(app: tauri::AppHandle) -> Result<Vec<InstalledPlugin>, String> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("无法定位应用数据目录：{error}"))?;
    plugin_market::list_installed(&app_data)
}

#[tauri::command]
fn plugin_delete(app: tauri::AppHandle, id: String) -> Result<bool, String> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("无法定位应用数据目录：{error}"))?;
    plugin_market::delete_plugin(&app_data, &id)
}

#[tauri::command]
fn pick_save_path(title: String, default_file_name: String) -> Result<Option<String>, String> {
    Ok(rfd::FileDialog::new()
        .set_title(&title)
        .set_file_name(&default_file_name)
        .save_file()
        .map(|p| p.to_string_lossy().into_owned()))
}

#[tauri::command]
fn pick_directory(title: String) -> Result<Option<String>, String> {
    Ok(rfd::FileDialog::new()
        .set_title(&title)
        .pick_folder()
        .map(|p| p.to_string_lossy().into_owned()))
}

#[tauri::command]
fn write_local_chunk(path: String, data_base64: String, append: bool) -> Result<u64, String> {
    use base64::Engine;
    use std::io::Write;
    let data = base64::engine::general_purpose::STANDARD
        .decode(&data_base64)
        .map_err(|error| format!("base64 解码失败：{error}"))?;
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(append)
        .write(true)
        .truncate(!append)
        .open(&path)
        .map_err(|error| format!("无法打开本地文件 {path}：{error}"))?;
    file.write_all(&data)
        .map_err(|error| format!("写入本地文件失败：{error}"))?;
    Ok(data.len() as u64)
}

#[tauri::command]
fn delete_local_file(path: String) -> Result<(), String> {
    if Path::new(&path).exists() {
        std::fs::remove_file(&path).map_err(|error| format!("删除本地文件失败：{error}"))?;
    }
    Ok(())
}

#[tauri::command]
fn create_local_dir(path: String) -> Result<(), String> {
    std::fs::create_dir_all(&path).map_err(|error| format!("创建本地目录失败：{error}"))
}

/// 插件读取本地 shell 历史文件（~/.bash_history、PSReadLine 等）。
/// 只读 + 大小上限，防止插件侧误用变成任意大文件读取。
#[tauri::command]
fn read_local_text_file(path: String, max_bytes: Option<u64>) -> Result<Option<String>, String> {
    const DEFAULT_MAX: u64 = 1024 * 1024;
    const HARD_MAX: u64 = 4 * 1024 * 1024;
    let limit = max_bytes.unwrap_or(DEFAULT_MAX).min(HARD_MAX);
    let metadata = match std::fs::metadata(&path) {
        Ok(metadata) => metadata,
        // 文件不存在（如尚未生成过的 shell 历史文件）按缺失处理
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("无法读取文件信息 {path}：{error}")),
    };
    if !metadata.is_file() {
        return Ok(None);
    }
    if metadata.len() > limit {
        return Err(format!("文件超过大小上限（{limit} 字节）：{path}"));
    }
    match std::fs::read_to_string(&path) {
        Ok(content) => Ok(Some(content)),
        // 非 UTF-8 历史文件（如 GBK 编码的 PSReadLine 旧文件）按缺失处理
        Err(error) if error.kind() == std::io::ErrorKind::InvalidData => Ok(None),
        Err(error) => Err(format!("读取本地文件失败 {path}：{error}")),
    }
}

/// 插件获取用户目录路径，用于定位 shell 历史文件（~/.bash_history、PSReadLine 等）。
#[tauri::command]
fn user_paths() -> Result<Value, String> {
    let home = std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(|value| value.to_string_lossy().into_owned());
    let app_data = std::env::var_os("APPDATA")
        .or_else(|| {
            std::env::var_os("HOME").map(|home| {
                PathBuf::from(home)
                    .join(".config")
                    .into_os_string()
            })
        })
        .map(|value| value.to_string_lossy().into_owned());
    Ok(json!({ "home": home, "appData": app_data }))
}

pub fn run() {
    use tauri::Emitter;
    use tauri_plugin_deep_link::DeepLinkExt;
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            // 二次启动：聚焦已有主窗口（对齐 Electron requestSingleInstanceLock），
            // 并转发 ssh:// 深链参数（Windows 上深链二次触发会带 URL 参数）
            if let Some(url) = args.iter().find(|arg| arg.starts_with("ssh://")) {
                let _ = app.emit("issh://deep-link", url.clone());
            }
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_deep_link::init())
        .setup(|app| {
            app.manage(RuntimeManager::new(app.handle())?);
            setup_tray(app.handle())?;
            // 深链：启动时（含冷启动带 ssh:// 参数）与运行期事件都转发给前端
            {
                let handle = app.handle().clone();
                let launch_handle = handle.clone();
                app.deep_link().on_open_url(move |event| {
                    for url in event.urls() {
                        let _ = handle.emit("issh://deep-link", url.to_string());
                    }
                });
                std::thread::spawn(move || {
                    if let Ok(Some(urls)) = launch_handle.deep_link().get_current() {
                        for url in urls {
                            let _ = launch_handle.emit("issh://deep-link", url.to_string());
                        }
                    }
                });
            }
            // 关闭窗口 = 最小化到托盘（对齐 Electron close → tray 行为）
            if let Some(window) = app.get_webview_window("main") {
                let handle = window.clone();
                window.on_window_event(move |event| {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        let _ = handle.hide();
                    }
                });
            }
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
        .invoke_handler(tauri::generate_handler![
            clipboard_write_text,
            clipboard_read_text,
            runtime_health,
            runtime_request,
            host_profiles,
            host_credentials,
            save_host_credential,
            delete_host_credential,
            enable_host_vault,
            disable_host_vault,
            change_host_passphrase,
            unlock_host_profiles,
            lock_host_profiles,
            mutate_host_profiles,
            resolve_ssh_password,
            resolve_sudo_password,
            resolve_key_passphrase,
            plugin_fetch_registry,
            plugin_download,
            plugin_list_installed,
            plugin_delete,
            pick_save_path,
            pick_directory,
            write_local_chunk,
            delete_local_file,
            create_local_dir,
            read_local_text_file,
            user_paths,
            relaunch_elevated
        ])
        .build(tauri::generate_context!())
        .expect("failed to build issh Tauri client");

    app.run(|handle, event| {
        if matches!(event, tauri::RunEvent::Exit) {
            handle.state::<RuntimeManager>().stop();
        }
    });
}

/// 系统托盘：显示主窗口 / 退出。关闭窗口时最小化到托盘而非退出进程。
fn setup_tray(app: &tauri::AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    use tauri::menu::{Menu, MenuItem};
    use tauri::tray::TrayIconBuilder;

    let show = MenuItem::with_id(app, "show", "显示主窗口", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quit])?;

    let icon = app
        .default_window_icon()
        .cloned()
        .ok_or("无法加载托盘图标：应用无默认图标")?;

    TrayIconBuilder::with_id("issh-tray")
        .icon(icon)
        .tooltip("issh")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.unminimize();
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
            "quit" => {
                app.exit(0);
            }
            _ => {}
        })
        .build(app)?;
    Ok(())
}

fn inject_auth_token(request: &mut Value, token: &str) {
    if let Value::Object(map) = request {
        map.insert("auth".to_string(), Value::String(token.to_string()));
    }
}

/// 生成 256 位随机 hex token，用于 isshd Named Pipe 传输层认证。
fn generate_auth_token() -> String {
    use rand::RngCore;
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
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

// isshd 的 session.openSsh 允许 10s 连接 + 10s 开通道，sftp.open 允许 30s；
// 前端 pipe 超时必须大于 runtime 侧上限，否则慢网络下会「假失败」且会话在 runtime 侧泄漏。
fn request_timeout(request: &Value) -> Duration {
    let method = request.get("method").and_then(Value::as_str).unwrap_or("");
    match method {
        "session.openSsh" => Duration::from_secs(30),
        "sftp.open" | "sftp.read" | "sftp.write" | "sftp.list" | "sftp.stat" | "sftp.mkdir"
        | "sftp.remove" | "sftp.removeDir" | "sftp.rename" | "sftp.close" | "ssh.probe"
        | "ssh.discoverHostKey" => Duration::from_secs(35),
        _ => Duration::from_secs(10),
    }
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
