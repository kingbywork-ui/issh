use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const PROTOCOL_VERSION: &str = "0.2.0";
pub const MAX_MESSAGE_BYTES: usize = 64 * 1024;

pub const INVALID_REQUEST: i32 = -32600;
pub const METHOD_NOT_FOUND: i32 = -32601;
pub const INVALID_PARAMS: i32 = -32602;
pub const PARSE_ERROR: i32 = -32700;
pub const MESSAGE_TOO_LARGE: i32 = -32001;

#[derive(Debug, Deserialize)]
pub struct RpcRequest {
    pub jsonrpc: String,
    #[serde(default)]
    pub id: Value,
    pub method: String,
    #[serde(default)]
    pub params: Option<Value>,
}

impl RpcRequest {
    pub fn validate(&self) -> Result<(), RpcError> {
        if self.jsonrpc != "2.0" || self.method.trim().is_empty() {
            return Err(RpcError::new(INVALID_REQUEST, "Invalid JSON-RPC request"));
        }
        Ok(())
    }
}

#[derive(Debug, Serialize)]
pub struct RpcResponse<T>
where
    T: Serialize,
{
    pub jsonrpc: &'static str,
    pub id: Value,
    pub result: T,
}

impl<T> RpcResponse<T>
where
    T: Serialize,
{
    pub fn new(id: Value, result: T) -> Self {
        Self {
            jsonrpc: "2.0",
            id,
            result,
        }
    }
}

#[derive(Debug, Serialize)]
pub struct RpcErrorResponse {
    pub jsonrpc: &'static str,
    pub id: Value,
    pub error: RpcError,
}

impl RpcErrorResponse {
    pub fn new(id: Value, error: RpcError) -> Self {
        Self {
            jsonrpc: "2.0",
            id,
            error,
        }
    }
}

#[derive(Debug, Serialize)]
pub struct RpcError {
    pub code: i32,
    pub message: String,
}

impl RpcError {
    pub fn new(code: i32, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HealthResult {
    pub protocol_version: &'static str,
    pub runtime_version: &'static str,
    pub pid: u32,
    pub started_at_unix_ms: u128,
    pub capabilities: Vec<&'static str>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_health_request() {
        let request: RpcRequest = serde_json::from_str(
            r#"{"jsonrpc":"2.0","id":1,"method":"runtime.health","params":{}}"#,
        )
        .expect("request should parse");

        request.validate().expect("request should be valid");
        assert_eq!(request.method, "runtime.health");
        assert_eq!(request.id, Value::from(1));
        assert_eq!(request.params, Some(Value::Object(Default::default())));
    }

    #[test]
    fn rejects_wrong_jsonrpc_version() {
        let request: RpcRequest =
            serde_json::from_str(r#"{"jsonrpc":"1.0","id":1,"method":"runtime.health"}"#)
                .expect("request should parse");

        let error = request.validate().expect_err("request should be rejected");
        assert_eq!(error.code, INVALID_REQUEST);
    }

    #[test]
    fn serializes_health_response_in_camel_case() {
        let response = RpcResponse::new(
            Value::from(1),
            HealthResult {
                protocol_version: PROTOCOL_VERSION,
                runtime_version: "0.2.0",
                pid: 42,
                started_at_unix_ms: 123,
                capabilities: vec!["runtime.health"],
            },
        );
        let value = serde_json::to_value(response).expect("response should serialize");

        assert_eq!(value["result"]["protocolVersion"], PROTOCOL_VERSION);
        assert_eq!(value["result"]["runtimeVersion"], "0.2.0");
        assert_eq!(value["result"]["startedAtUnixMs"], 123);
    }
}
