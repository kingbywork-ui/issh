//! End-to-end Bridge transport checks with isolated host data and a mock Runtime.
//! The real HTTP dispatcher, credential store, confirmation broker and named-pipe
//! client run unchanged; no user server, configuration or process is accessed.

use super::*;
use crate::host_profiles::HostProfileStore;
use crate::ssh_host_keys::{HostKeyConfirmation, HostKeyRequest, CANCEL_EVENT, REQUEST_EVENT};
use std::sync::Mutex;
use std::time::Duration;
use tokio::net::windows::named_pipe::ServerOptions;
use tokio::sync::mpsc::{unbounded_channel, UnboundedReceiver};
use tokio::task::JoinHandle;

const FINGERPRINT: &str = "SHA256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const CHANGED_FINGERPRINT: &str = "SHA256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const HOST: &str = "isolated-ssh-fixture.invalid";
const PASSWORD: &str = "fixture-password-never-used-on-a-real-host";

struct ConnectFixture {
    user_data: PathBuf,
    port: u16,
    bridge: AgentBridgeHandle,
    runtime: Arc<RuntimeManager>,
    requests: Arc<Mutex<Vec<Value>>>,
    fingerprint: Arc<Mutex<String>>,
    open_delay_ms: Arc<AtomicU64>,
    events: UnboundedReceiver<(String, HostKeyRequest)>,
    pipe_task: JoinHandle<()>,
}

impl ConnectFixture {
    async fn new() -> Self {
        let nonce = rand::random::<u64>();
        let user_data = std::env::temp_dir().join(format!(
            "issh-connect-profile-test-{}-{nonce}",
            std::process::id()
        ));
        std::fs::create_dir(&user_data).unwrap();
        let config = format!(
            "profiles:\n  - id: fixture-profile\n    name: Fixture SSH\n    host: {HOST}\n    port: 2222\n    user: fixture-user\nsecrets:\n  - type: ssh:password\n    key:\n      user: fixture-user\n      host: {HOST}\n      port: 2222\n    value: {PASSWORD}\n"
        );
        std::fs::write(user_data.join("config.yaml"), config).unwrap();
        let hosts = HostProfileStore::new(&user_data);
        hosts
            .enable_vault("isolated-fixture-master-password")
            .unwrap();
        assert_eq!(
            hosts
                .resolve_ssh_password("fixture-user", HOST, 2222)
                .unwrap()
                .as_deref(),
            Some(PASSWORD)
        );

        let pipe_name = format!(
            r"\\.\pipe\issh-connect-profile-test-{}-{nonce}",
            std::process::id()
        );
        let server = ServerOptions::new()
            .first_pipe_instance(true)
            .create(&pipe_name)
            .unwrap();
        let requests = Arc::new(Mutex::new(Vec::<Value>::new()));
        let fingerprint = Arc::new(Mutex::new(FINGERPRINT.to_string()));
        let open_delay_ms = Arc::new(AtomicU64::new(0));
        let recorded = requests.clone();
        let discovered = fingerprint.clone();
        let open_delay = open_delay_ms.clone();
        let server_pipe = pipe_name.clone();
        let pipe_task = tokio::spawn(async move {
            let mut server = server;
            loop {
                server.connect().await.unwrap();
                let mut line = String::new();
                BufReader::new(&mut server)
                    .read_line(&mut line)
                    .await
                    .unwrap();
                let request: Value = serde_json::from_str(&line).unwrap();
                recorded.lock().unwrap().push(request.clone());
                let method = request["method"].as_str().unwrap();
                let response = match method {
                    "runtime.health" => json!({"result": {
                        "protocolVersion": crate::PROTOCOL_VERSION,
                        "capabilities": ["workspace.list"]
                    }}),
                    "ssh.discoverHostKey" => json!({"result": {
                        "host": request["params"]["host"],
                        "port": request["params"]["port"],
                        "fingerprint": discovered.lock().unwrap().clone()
                    }}),
                    "session.openSsh" => {
                        let expected = request["params"]["expectedHostKey"].as_str().unwrap_or("");
                        if expected.is_empty() {
                            json!({"error": {"code": -32602, "message": "SSH host-key fingerprint is required"}})
                        } else if expected != *discovered.lock().unwrap() {
                            json!({"error": {"code": -32602, "message": "SSH host key rejected"}})
                        } else {
                            tokio::time::sleep(Duration::from_millis(
                                open_delay.load(Ordering::Relaxed),
                            ))
                            .await;
                            json!({"result": {"id": "fixture-session", "kind": "ssh", "state": "running"}})
                        }
                    }
                    "session.close" => {
                        json!({"result": {"id": request["params"]["sessionId"], "state": "closed"}})
                    }
                    _ => panic!("Unexpected Runtime method in isolated connect test: {method}"),
                };
                let mut response = response;
                response["id"] = request["id"].clone();
                response["jsonrpc"] = json!("2.0");
                // Keep another pipe instance ready before dropping this response
                // stream; RuntimeManager performs a health request before each RPC.
                let next = ServerOptions::new().create(&server_pipe).unwrap();
                server
                    .write_all(&serde_json::to_vec(&response).unwrap())
                    .await
                    .unwrap();
                drop(server);
                server = next;
            }
        });
        let (events_tx, events) = unbounded_channel();
        let runtime = Arc::new(RuntimeManager {
            pipe_name,
            database_path: user_data.join("unused-runtime.sqlite3"),
            // A reachable compatible mock pipe means no process is launched.
            binary_path: user_data.join("nonexistent-runtime.exe"),
            auth_token: "isolated-runtime-token".into(),
            child: Mutex::new(None),
            startup: tokio::sync::Mutex::new(()),
            hosts,
            ssh_host_keys: HostKeyConfirmation::new(move |event, request| {
                events_tx
                    .send((event.to_string(), request.clone()))
                    .map_err(|error| error.to_string())
            }),
        });
        let reservation = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = reservation.local_addr().unwrap().port();
        drop(reservation);
        let bridge = start(
            runtime.clone(),
            user_data.clone(),
            AgentBridgeConfig {
                enabled: false,
                token: "isolated-bridge-token".into(),
                port,
                allowed_scopes: vec!["read".into(), "write".into(), "exec".into(), "sftp".into()],
                sftp_root: None,
                public_discovery: false,
                audit_log_enabled: false,
                permission_mode: PermissionMode::Confirm,
            },
        )
        .await
        .unwrap();
        Self {
            user_data,
            port,
            bridge,
            runtime,
            requests,
            fingerprint,
            open_delay_ms,
            events,
            pipe_task,
        }
    }

    fn invoke(&self, method: &str, params: Value) -> JoinHandle<Value> {
        let url = format!("http://127.0.0.1:{}/rpc", self.port);
        let request = json!({"id": "isolated-connect", "method": method, "params": params});
        tokio::spawn(async move {
            reqwest::Client::builder()
                .no_proxy()
                .timeout(Duration::from_secs(5))
                .build()
                .unwrap()
                .post(url)
                .bearer_auth("isolated-bridge-token")
                .json(&request)
                .send()
                .await
                .unwrap()
                .json::<Value>()
                .await
                .unwrap()
        })
    }

    fn connect(&self, timeout_ms: u64) -> JoinHandle<Value> {
        self.invoke(
            "issh_connect_profile",
            json!({"id": "fixture-profile", "timeoutMs": timeout_ms}),
        )
    }

    async fn next_request(&mut self) -> HostKeyRequest {
        let (event, request) = tokio::time::timeout(Duration::from_secs(2), self.events.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(event, REQUEST_EVENT);
        assert_eq!(request.host, HOST);
        assert_eq!(request.port, 2222);
        assert_eq!(
            self.methods().last().map(String::as_str),
            Some("ssh.discoverHostKey")
        );
        request
    }

    fn methods(&self) -> Vec<String> {
        self.requests
            .lock()
            .unwrap()
            .iter()
            .map(|request| request["method"].as_str().unwrap().to_string())
            .collect()
    }

    fn opens(&self) -> Vec<Value> {
        self.requests
            .lock()
            .unwrap()
            .iter()
            .filter(|request| request["method"] == "session.openSsh")
            .cloned()
            .collect()
    }

    async fn finish(&self) {
        self.bridge.stop();
        tokio::time::sleep(Duration::from_millis(250)).await;
        assert!(
            TcpListener::bind(("127.0.0.1", self.port)).await.is_ok(),
            "isolated Bridge listener must close"
        );
        assert!(
            self.runtime.child.lock().unwrap().is_none(),
            "test must not launch a real runtime process"
        );
        self.pipe_task.abort();
    }
}

impl Drop for ConnectFixture {
    fn drop(&mut self) {
        self.bridge.stop();
        self.pipe_task.abort();
        std::fs::remove_dir_all(&self.user_data).unwrap();
    }
}

#[tokio::test]
async fn first_mcp_connection_discovers_confirms_and_passes_exact_host_key() {
    let mut fixture = ConnectFixture::new().await;
    let connection = fixture.connect(3_000);
    let request = fixture.next_request().await;
    assert_eq!(request.fingerprint, FINGERPRINT);
    assert!(
        fixture.opens().is_empty(),
        "credentials must not be used before the host key is trusted"
    );
    assert!(!connection.is_finished());
    fixture
        .runtime
        .ssh_host_keys
        .resolve(request.id, true)
        .unwrap();
    let response = connection.await.unwrap();
    assert_eq!(response["result"]["id"], "fixture-session", "{response}");
    let opens = fixture.opens();
    assert_eq!(opens.len(), 1);
    assert_eq!(opens[0]["params"]["expectedHostKey"], FINGERPRINT);
    assert_eq!(opens[0]["params"]["password"], PASSWORD);
    assert_eq!(opens[0]["params"]["host"], HOST);
    assert_eq!(opens[0]["params"]["port"], 2222);
    assert_eq!(
        fixture.methods(),
        [
            "runtime.health",
            "ssh.discoverHostKey",
            "runtime.health",
            "session.openSsh"
        ]
    );
    let closed = fixture
        .invoke("issh_disconnect_session", json!({"tab": "fixture-session"}))
        .await
        .unwrap();
    assert_eq!(closed["result"]["closed"], true, "{closed}");
    fixture.finish().await;
}

#[tokio::test]
async fn rejected_first_host_key_never_opens_a_session() {
    let mut fixture = ConnectFixture::new().await;
    let connection = fixture.connect(3_000);
    let request = fixture.next_request().await;
    fixture
        .runtime
        .ssh_host_keys
        .resolve(request.id, false)
        .unwrap();
    let response = connection.await.unwrap();
    assert!(
        response["error"]["message"]
            .as_str()
            .unwrap()
            .contains("未获信任"),
        "{response}"
    );
    assert!(fixture.opens().is_empty());
    assert!(
        fixture
            .runtime
            .ssh_host_keys
            .resolve(request.id, true)
            .is_err(),
        "rejection cannot be replayed as approval"
    );
    fixture.finish().await;
}

#[tokio::test]
async fn reconnect_rechecks_host_key_and_changed_key_requires_a_new_decision() {
    let mut fixture = ConnectFixture::new().await;
    for _ in 0..2 {
        let connection = fixture.connect(3_000);
        let request = fixture.next_request().await;
        assert_eq!(request.fingerprint, FINGERPRINT);
        // Models the desktop's remembered trust lookup for the same fingerprint.
        fixture
            .runtime
            .ssh_host_keys
            .resolve(request.id, true)
            .unwrap();
        assert_eq!(connection.await.unwrap()["result"]["id"], "fixture-session");
    }
    *fixture.fingerprint.lock().unwrap() = CHANGED_FINGERPRINT.into();
    let changed = fixture.connect(3_000);
    let request = fixture.next_request().await;
    assert_eq!(request.fingerprint, CHANGED_FINGERPRINT);
    assert_eq!(
        fixture.opens().len(),
        2,
        "changed key must wait for a fresh trust decision"
    );
    fixture
        .runtime
        .ssh_host_keys
        .resolve(request.id, false)
        .unwrap();
    assert!(changed.await.unwrap().get("error").is_some());
    assert_eq!(fixture.opens().len(), 2);
    assert!(fixture
        .opens()
        .iter()
        .all(|request| request["params"]["expectedHostKey"] == FINGERPRINT));
    assert_eq!(
        fixture
            .methods()
            .iter()
            .filter(|method| *method == "ssh.discoverHostKey")
            .count(),
        3
    );
    fixture.finish().await;
}

#[tokio::test]
async fn confirmation_timeout_cancels_dialog_and_late_approval_cannot_open_session() {
    let mut fixture = ConnectFixture::new().await;
    let connection = fixture.connect(300);
    let request = fixture.next_request().await;
    let response = connection.await.unwrap();
    assert!(
        response["error"]["message"]
            .as_str()
            .unwrap()
            .contains("timed out"),
        "{response}"
    );
    let (event, cancellation) = tokio::time::timeout(Duration::from_secs(1), fixture.events.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(event, CANCEL_EVENT);
    assert_eq!(request.id, cancellation.id);
    assert!(fixture
        .runtime
        .ssh_host_keys
        .resolve(request.id, true)
        .is_err());
    assert!(fixture.opens().is_empty());
    fixture.finish().await;
}

#[tokio::test]
async fn timeout_after_open_closes_the_session_returned_later() {
    let mut fixture = ConnectFixture::new().await;
    fixture.open_delay_ms.store(600, Ordering::Relaxed);
    let connection = fixture.connect(300);
    let request = fixture.next_request().await;
    fixture
        .runtime
        .ssh_host_keys
        .resolve(request.id, true)
        .unwrap();
    let response = connection.await.unwrap();
    assert!(
        response["error"]["message"]
            .as_str()
            .unwrap()
            .contains("timed out"),
        "{response}"
    );
    tokio::time::timeout(Duration::from_secs(2), async {
        while !fixture
            .methods()
            .iter()
            .any(|method| method == "session.close")
        {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("a timed-out open must not leave an orphan session");
    let requests = fixture.requests.lock().unwrap().clone();
    let close = requests
        .iter()
        .find(|request| request["method"] == "session.close")
        .unwrap();
    assert_eq!(close["params"]["sessionId"], "fixture-session");
    fixture.finish().await;
}

#[tokio::test]
async fn bridge_disconnect_cancels_pending_confirmation_without_opening_session() {
    let mut fixture = ConnectFixture::new().await;
    let connection = fixture.connect(3_000);
    let request = fixture.next_request().await;
    fixture.bridge.disconnect_clients();
    let response = connection.await.unwrap();
    assert!(
        response["error"]["message"]
            .as_str()
            .unwrap()
            .contains("disconnected"),
        "{response}"
    );
    let (event, cancellation) = tokio::time::timeout(Duration::from_secs(1), fixture.events.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(event, CANCEL_EVENT);
    assert_eq!(cancellation.id, request.id);
    assert!(fixture
        .runtime
        .ssh_host_keys
        .resolve(request.id, true)
        .is_err());
    assert!(fixture.opens().is_empty());
    fixture.finish().await;
}

#[tokio::test]
async fn bridge_disconnect_during_open_closes_the_session_returned_later() {
    let mut fixture = ConnectFixture::new().await;
    fixture.open_delay_ms.store(600, Ordering::Relaxed);
    let connection = fixture.connect(3_000);
    let request = fixture.next_request().await;
    fixture
        .runtime
        .ssh_host_keys
        .resolve(request.id, true)
        .unwrap();
    tokio::time::timeout(Duration::from_secs(1), async {
        while fixture.opens().is_empty() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("the handshake must be running before disconnecting");
    fixture.bridge.disconnect_clients();
    let response = connection.await.unwrap();
    assert!(
        response["error"]["message"]
            .as_str()
            .unwrap()
            .contains("disconnected"),
        "{response}"
    );
    tokio::time::timeout(Duration::from_secs(2), async {
        while !fixture
            .methods()
            .iter()
            .any(|method| method == "session.close")
        {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("disconnecting during a handshake must not leave an orphan session");
    let requests = fixture.requests.lock().unwrap().clone();
    let close = requests
        .iter()
        .find(|request| request["method"] == "session.close")
        .unwrap();
    assert_eq!(close["params"]["sessionId"], "fixture-session");
    fixture.finish().await;
}
