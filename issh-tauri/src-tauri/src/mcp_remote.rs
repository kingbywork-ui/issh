use reqwest::header::{HeaderMap, HeaderName, HeaderValue, ACCEPT, CONTENT_TYPE};
use serde_json::{json, Value};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use tokio::time::{timeout, Duration};
use url::Url;

const MAX_MESSAGE: usize = 1024 * 1024;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Clone, Copy, PartialEq, Eq)]
enum Mode {
    StreamableHttp,
    Sse,
}

struct Event {
    kind: String,
    data: String,
}

#[derive(Default)]
struct EventDecoder {
    pending: Vec<u8>,
    kind: String,
    data: String,
}

impl EventDecoder {
    fn push(&mut self, bytes: &[u8]) -> Result<Vec<Event>, String> {
        self.pending.extend_from_slice(bytes);
        if self.pending.len() + self.data.len() > MAX_MESSAGE {
            return Err("MCP SSE 消息超过 1 MiB".to_string());
        }
        let mut events = Vec::new();
        while let Some(end) = self.pending.iter().position(|byte| *byte == b'\n') {
            let line = self.pending.drain(..=end).collect::<Vec<_>>();
            let line = std::str::from_utf8(&line[..line.len() - 1])
                .map_err(|_| "MCP SSE 文本不是 UTF-8".to_string())?
                .trim_end_matches('\r');
            if line.is_empty() {
                if !self.data.is_empty() {
                    events.push(Event {
                        kind: std::mem::take(&mut self.kind),
                        data: std::mem::take(&mut self.data),
                    });
                }
            } else if let Some(value) = line.strip_prefix("event:") {
                self.kind = value.trim_start().to_string();
            } else if let Some(value) = line.strip_prefix("data:") {
                if !self.data.is_empty() {
                    self.data.push('\n');
                }
                self.data.push_str(value.trim_start());
            }
        }
        Ok(events)
    }
}

fn validated_url(value: &str) -> Result<Url, String> {
    let url = Url::parse(value).map_err(|_| "MCP URL 无效".to_string())?;
    let host = url.host_str().ok_or("MCP URL 缺少主机")?;
    if url.scheme() != "https"
        && !(url.scheme() == "http" && matches!(host, "localhost" | "127.0.0.1" | "[::1]"))
    {
        return Err("远程 MCP 仅支持 HTTPS；本机可使用 HTTP".to_string());
    }
    if !url.username().is_empty() || url.password().is_some() || url.fragment().is_some() {
        return Err("MCP URL 不可包含账号或片段".to_string());
    }
    Ok(url)
}

fn validated_headers(args: &Value) -> Result<HeaderMap, String> {
    let mut headers = HeaderMap::new();
    if let Some(values) = args.get("headers") {
        let values = values.as_object().ok_or("MCP 请求头须为 JSON 对象")?;
        if values.len() > 16 {
            return Err("MCP 请求头过多".to_string());
        }
        for (name, value) in values {
            let key = HeaderName::from_bytes(name.as_bytes()).map_err(|_| "MCP 请求头名称无效")?;
            if matches!(
                key.as_str(),
                "host" | "accept" | "content-type" | "mcp-session-id" | "mcp-protocol-version"
            ) {
                return Err("MCP 请求头包含保留字段".to_string());
            }
            let value = value.as_str().ok_or("MCP 请求头值须为字符串")?;
            if value.len() > 4096 {
                return Err("MCP 请求头值过长".to_string());
            }
            headers.insert(
                key,
                HeaderValue::from_str(value).map_err(|_| "MCP 请求头值无效")?,
            );
        }
    }
    Ok(headers)
}

fn rpc_result(value: Value, id: u64) -> Option<Result<Value, String>> {
    if value.get("id") != Some(&json!(id)) {
        return None;
    }
    if let Some(error) = value.get("error") {
        return Some(Err(error
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("MCP 调用失败")
            .to_string()));
    }
    Some(Ok(value.get("result").cloned().unwrap_or(Value::Null)))
}

async fn bounded_json(mut response: reqwest::Response) -> Result<Value, String> {
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|e| format!("MCP 响应读取失败：{e}"))?
    {
        if bytes.len() + chunk.len() > MAX_MESSAGE {
            return Err("MCP 响应超过 1 MiB".to_string());
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|e| format!("MCP 响应格式错误：{e}"))
}

async fn stream_result(mut response: reqwest::Response, id: u64) -> Result<Value, String> {
    let mut decoder = EventDecoder::default();
    let mut total = 0usize;
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|e| format!("MCP SSE 读取失败：{e}"))?
    {
        total += chunk.len();
        if total > 4 * MAX_MESSAGE {
            return Err("MCP SSE 响应过大".to_string());
        }
        for event in decoder.push(&chunk)? {
            if let Ok(value) = serde_json::from_str::<Value>(&event.data) {
                if let Some(result) = rpc_result(value, id) {
                    return result;
                }
            }
        }
    }
    Err("MCP SSE 未返回请求结果".to_string())
}

pub struct RemoteMcpConnection {
    client: reqwest::Client,
    endpoint: Url,
    headers: HeaderMap,
    mode: Mode,
    session_id: Option<String>,
    next_id: u64,
    receiver: Option<mpsc::Receiver<Value>>,
    reader: Option<JoinHandle<()>>,
}

impl RemoteMcpConnection {
    pub async fn connect(args: &Value, transport: &str) -> Result<Self, String> {
        let endpoint = validated_url(
            args.get("url")
                .and_then(Value::as_str)
                .ok_or("缺少 MCP URL")?,
        )?;
        let headers = validated_headers(args)?;
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|e| format!("创建 MCP HTTP 客户端失败：{e}"))?;
        let mode = if transport == "sse" {
            Mode::Sse
        } else {
            Mode::StreamableHttp
        };
        let mut connection = Self {
            client,
            endpoint,
            headers,
            mode,
            session_id: None,
            next_id: 0,
            receiver: None,
            reader: None,
        };
        if mode == Mode::Sse {
            connection.open_legacy_sse().await?;
        }
        Ok(connection)
    }

    async fn open_legacy_sse(&mut self) -> Result<(), String> {
        let response = timeout(
            REQUEST_TIMEOUT,
            self.client
                .get(self.endpoint.clone())
                .headers(self.headers.clone())
                .header(ACCEPT, "text/event-stream")
                .send(),
        )
        .await
        .map_err(|_| "MCP SSE 连接超时".to_string())?
        .map_err(|e| format!("MCP SSE 连接失败：{e}"))?;
        if !response.status().is_success() {
            return Err(format!("MCP SSE 连接失败（HTTP {}）", response.status()));
        }
        let content_type = response
            .headers()
            .get(CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .unwrap_or("");
        if !content_type
            .to_ascii_lowercase()
            .starts_with("text/event-stream")
        {
            return Err("MCP SSE 服务未返回事件流".to_string());
        }
        let mut response = response;
        let mut decoder = EventDecoder::default();
        let (sender, receiver) = mpsc::channel(32);
        let endpoint = timeout(REQUEST_TIMEOUT, async {
            loop {
                let chunk = response
                    .chunk()
                    .await
                    .map_err(|e| format!("MCP SSE 读取失败：{e}"))?
                    .ok_or("MCP SSE 未提供消息地址")?;
                for event in decoder.push(&chunk)? {
                    if event.kind == "endpoint" {
                        return self
                            .endpoint
                            .join(event.data.trim())
                            .map_err(|_| "MCP SSE 消息地址无效".to_string());
                    }
                }
            }
        })
        .await
        .map_err(|_| "MCP SSE 等待消息地址超时".to_string())??;
        let endpoint = validated_url(endpoint.as_str())?;
        if endpoint.scheme() != self.endpoint.scheme()
            || endpoint.host_str() != self.endpoint.host_str()
            || endpoint.port_or_known_default() != self.endpoint.port_or_known_default()
        {
            return Err("MCP SSE 消息地址必须与服务地址同源".to_string());
        }
        self.endpoint = endpoint;
        self.receiver = Some(receiver);
        self.reader = Some(tokio::spawn(async move {
            while let Ok(Some(chunk)) = response.chunk().await {
                let Ok(events) = decoder.push(&chunk) else {
                    break;
                };
                for event in events {
                    if event.kind == "message" || event.kind.is_empty() {
                        if let Ok(value) = serde_json::from_str::<Value>(&event.data) {
                            if sender.send(value).await.is_err() {
                                return;
                            }
                        }
                    }
                }
            }
        }));
        Ok(())
    }

    async fn post(&self, payload: &Value) -> Result<reqwest::Response, String> {
        let mut request = self
            .client
            .post(self.endpoint.clone())
            .headers(self.headers.clone())
            .header(CONTENT_TYPE, "application/json")
            .header(ACCEPT, "application/json, text/event-stream")
            .header("MCP-Protocol-Version", "2025-03-26")
            .json(payload);
        if let Some(session) = &self.session_id {
            request = request.header("Mcp-Session-Id", session);
        }
        let response = timeout(REQUEST_TIMEOUT, request.send())
            .await
            .map_err(|_| "MCP HTTP 请求超时".to_string())?
            .map_err(|e| format!("MCP HTTP 请求失败：{e}"))?;
        if !response.status().is_success() {
            return Err(format!("MCP HTTP 请求失败（HTTP {}）", response.status()));
        }
        Ok(response)
    }

    pub async fn call(&mut self, method: &str, params: Value) -> Result<Value, String> {
        self.next_id += 1;
        let id = self.next_id;
        let payload = json!({"jsonrpc":"2.0","id":id,"method":method,"params":params});
        let response = self.post(&payload).await?;
        if self.mode == Mode::Sse {
            let receiver = self.receiver.as_mut().ok_or("MCP SSE 已断开")?;
            return timeout(REQUEST_TIMEOUT, async {
                while let Some(value) = receiver.recv().await {
                    if let Some(result) = rpc_result(value, id) {
                        return result;
                    }
                }
                Err("MCP SSE 已断开".to_string())
            })
            .await
            .map_err(|_| "MCP SSE 请求超时".to_string())?;
        }
        if method == "initialize" {
            self.session_id = response
                .headers()
                .get("mcp-session-id")
                .and_then(|value| value.to_str().ok())
                .filter(|value| value.len() <= 256 && !value.contains(['\r', '\n']))
                .map(str::to_string);
        }
        let media_type = response
            .headers()
            .get(CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .unwrap_or("")
            .to_ascii_lowercase();
        timeout(REQUEST_TIMEOUT, async {
            if media_type.starts_with("text/event-stream") {
                stream_result(response, id).await
            } else {
                let value = bounded_json(response).await?;
                rpc_result(value, id).ok_or("MCP 响应 ID 不匹配".to_string())?
            }
        })
        .await
        .map_err(|_| "MCP HTTP 响应超时".to_string())?
    }

    pub async fn notify(&self, method: &str) -> Result<(), String> {
        let payload = json!({"jsonrpc":"2.0","method":method});
        self.post(&payload).await.map(|_| ())
    }

    pub async fn disconnect(&mut self) {
        if let Some(reader) = self.reader.take() {
            reader.abort();
        }
        if self.mode == Mode::StreamableHttp {
            if let Some(session) = self.session_id.take() {
                let _ = timeout(
                    Duration::from_secs(5),
                    self.client
                        .delete(self.endpoint.clone())
                        .headers(self.headers.clone())
                        .header("Mcp-Session-Id", session)
                        .send(),
                )
                .await;
            }
        }
    }
}

impl Drop for RemoteMcpConnection {
    fn drop(&mut self) {
        if let Some(reader) = self.reader.take() {
            reader.abort();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::{TcpListener, TcpStream};

    async fn read_request(stream: &mut TcpStream) -> (String, Value) {
        let mut bytes = Vec::new();
        let header_end = loop {
            let mut chunk = [0u8; 4096];
            let count = stream.read(&mut chunk).await.unwrap();
            assert!(count > 0);
            bytes.extend_from_slice(&chunk[..count]);
            if let Some(end) = bytes.windows(4).position(|part| part == b"\r\n\r\n") {
                break end + 4;
            }
        };
        let headers = String::from_utf8_lossy(&bytes[..header_end]);
        let path = headers.split_whitespace().nth(1).unwrap().to_string();
        let length = headers
            .lines()
            .find_map(|line| {
                line.to_ascii_lowercase()
                    .strip_prefix("content-length:")
                    .and_then(|value| value.trim().parse::<usize>().ok())
            })
            .unwrap_or(0);
        while bytes.len() < header_end + length {
            let mut chunk = [0u8; 4096];
            let count = stream.read(&mut chunk).await.unwrap();
            assert!(count > 0);
            bytes.extend_from_slice(&chunk[..count]);
        }
        let body = if length == 0 {
            Value::Null
        } else {
            serde_json::from_slice(&bytes[header_end..header_end + length]).unwrap()
        };
        (path, body)
    }

    fn fixture_response(request: &Value) -> Value {
        let result = match request
            .get("method")
            .and_then(Value::as_str)
            .unwrap_or_default()
        {
            "initialize" => {
                json!({"protocolVersion":"2025-03-26","capabilities":{"tools":{}},"serverInfo":{"name":"fixture","version":"1"}})
            }
            "tools/list" => json!({"tools":[{"name":"echo","inputSchema":{"type":"object"}}]}),
            "tools/call" => json!({"content":[{"type":"text","text":"ok"}]}),
            method => panic!("unexpected method: {method}"),
        };
        json!({"jsonrpc":"2.0","id":request["id"],"result":result})
    }

    async fn fixture_server(mode: &str) -> (String, JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let legacy = mode == "sse";
        let streamable_sse = mode == "streamable-sse";
        let (events, receiver) = mpsc::channel::<String>(16);
        let task = tokio::spawn(async move {
            let mut receiver = Some(receiver);
            loop {
                let (mut socket, _) = listener.accept().await.unwrap();
                let (path, request) = read_request(&mut socket).await;
                if legacy && path == "/sse" {
                    socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: keep-alive\r\n\r\nevent: endpoint\ndata: /message\r\n\r\n").await.unwrap();
                    let mut incoming = receiver.take().unwrap();
                    tokio::spawn(async move {
                        let mut stream = socket;
                        while let Some(message) = incoming.recv().await {
                            if stream.write_all(message.as_bytes()).await.is_err() {
                                break;
                            }
                        }
                    });
                    continue;
                }
                if request.get("id").is_none() {
                    socket.write_all(b"HTTP/1.1 202 Accepted\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await.unwrap();
                    continue;
                }
                let payload = fixture_response(&request).to_string();
                if legacy {
                    socket.write_all(b"HTTP/1.1 202 Accepted\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await.unwrap();
                    events
                        .send(format!("event: message\ndata: {payload}\n\n"))
                        .await
                        .unwrap();
                } else {
                    let body = if streamable_sse {
                        format!("event: message\ndata: {payload}\n\n")
                    } else {
                        payload
                    };
                    let media_type = if streamable_sse {
                        "text/event-stream"
                    } else {
                        "application/json"
                    };
                    let header = format!("HTTP/1.1 200 OK\r\nContent-Type: {media_type}\r\nMcp-Session-Id: fixture-session\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len());
                    socket.write_all(header.as_bytes()).await.unwrap();
                    socket.write_all(body.as_bytes()).await.unwrap();
                }
            }
        });
        (
            format!("http://{address}/{}", if legacy { "sse" } else { "mcp" }),
            task,
        )
    }

    async fn verify_transport(mode: &str) {
        let (url, server) = fixture_server(mode).await;
        let transport = if mode == "sse" {
            "sse"
        } else {
            "streamable-http"
        };
        let manager = crate::mcp_stdio::LocalMcpManager::default();
        let init = manager
            .connect(
                "issh-plugin-ai-assistant",
                &json!({"serverId":"remote","transport":transport,"url":url}),
            )
            .await
            .unwrap();
        assert_eq!(init["serverInfo"]["name"], "fixture");
        assert_eq!(
            manager
                .list_tools("issh-plugin-ai-assistant", &json!({"serverId":"remote"}))
                .await
                .unwrap()["tools"][0]["name"],
            "echo"
        );
        assert_eq!(
            manager
                .call_tool(
                    "issh-plugin-ai-assistant",
                    &json!({"serverId":"remote","name":"echo","arguments":{}})
                )
                .await
                .unwrap()["content"][0]["text"],
            "ok"
        );
        assert!(manager
            .list_tools("other-plugin", &json!({"serverId":"remote"}))
            .await
            .is_err());
        manager
            .disconnect("issh-plugin-ai-assistant", &json!({"serverId":"remote"}))
            .await
            .unwrap();
        server.abort();
    }

    #[tokio::test]
    async fn streamable_http_json_roundtrip() {
        verify_transport("json").await;
    }

    #[tokio::test]
    async fn streamable_http_sse_roundtrip() {
        verify_transport("streamable-sse").await;
    }

    #[tokio::test]
    async fn legacy_sse_roundtrip() {
        verify_transport("sse").await;
    }

    #[test]
    fn validates_remote_urls_and_headers() {
        assert!(validated_url("https://example.com/mcp").is_ok());
        assert!(validated_url("http://127.0.0.1:3000/mcp").is_ok());
        assert!(validated_url("http://example.com/mcp").is_err());
        assert!(validated_url("https://user:password@example.com/mcp").is_err());
        assert!(validated_headers(&json!({"headers":{"Authorization":"Bearer test"}})).is_ok());
        assert!(validated_headers(&json!({"headers":{"Host":"other"}})).is_err());
    }

    #[test]
    fn decodes_sse_across_chunks() {
        let mut decoder = EventDecoder::default();
        assert!(decoder
            .push(b"event: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":1")
            .unwrap()
            .is_empty());
        let events = decoder.push(b",\"result\":{\"ok\":true}}\r\n\r\n").unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].kind, "message");
        assert_eq!(
            rpc_result(serde_json::from_str(&events[0].data).unwrap(), 1)
                .unwrap()
                .unwrap()["ok"],
            true
        );
    }
}
