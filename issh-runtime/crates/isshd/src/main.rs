use issh_runtime_protocol::{
    HealthResult, RpcError, RpcErrorResponse, RpcRequest, RpcResponse, INVALID_REQUEST,
    MAX_MESSAGE_BYTES, MESSAGE_TOO_LARGE, METHOD_NOT_FOUND, PARSE_ERROR, PROTOCOL_VERSION,
};
use serde_json::Value;
use std::env;
use std::io;
use std::time::{SystemTime, UNIX_EPOCH};

#[cfg(windows)]
mod windows_security;

const DEFAULT_PIPE_NAME: &str = r"\\.\pipe\issh-runtime-v1";

#[derive(Debug)]
struct Options {
    pipe_name: String,
    once: bool,
}

impl Options {
    fn parse() -> Result<Self, String> {
        let mut pipe_name = env::var("ISSH_RUNTIME_PIPE")
            .ok()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| DEFAULT_PIPE_NAME.to_string());
        let mut once = false;
        let mut args = env::args().skip(1);

        while let Some(arg) = args.next() {
            match arg.as_str() {
                "--pipe" => {
                    pipe_name = args
                        .next()
                        .filter(|value| !value.trim().is_empty())
                        .ok_or_else(|| "--pipe requires a non-empty value".to_string())?;
                }
                "--once" => once = true,
                "--help" | "-h" => {
                    println!("Usage: isshd [--pipe <name>] [--once]");
                    std::process::exit(0);
                }
                unknown => return Err(format!("Unknown argument: {unknown}")),
            }
        }

        Ok(Self { pipe_name, once })
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let options =
        Options::parse().map_err(|message| io::Error::new(io::ErrorKind::InvalidInput, message))?;
    let started_at_unix_ms = SystemTime::now().duration_since(UNIX_EPOCH)?.as_millis();

    run(options, started_at_unix_ms).await?;
    Ok(())
}

#[cfg(windows)]
async fn run(options: Options, started_at_unix_ms: u128) -> io::Result<()> {
    use tokio::net::windows::named_pipe::{NamedPipeServer, ServerOptions};

    fn create_pipe(pipe_name: &str, first: bool) -> io::Result<NamedPipeServer> {
        let mut security = windows_security::PipeSecurityAttributes::for_current_user()?;
        let mut options = ServerOptions::new();
        options
            .first_pipe_instance(first)
            .reject_remote_clients(true)
            .in_buffer_size((MAX_MESSAGE_BYTES + 1) as u32)
            .out_buffer_size((MAX_MESSAGE_BYTES + 1) as u32);
        // SAFETY: `security` owns both the SECURITY_ATTRIBUTES structure and
        // its descriptor for the duration of CreateNamedPipeW. Windows copies
        // the descriptor while creating the pipe.
        unsafe { options.create_with_security_attributes_raw(pipe_name, security.as_mut_ptr()) }
    }

    let mut first = true;
    loop {
        let server = create_pipe(&options.pipe_name, first)?;
        first = false;
        server.connect().await?;
        handle_client(server, started_at_unix_ms).await?;
        if options.once {
            return Ok(());
        }
    }
}

#[cfg(not(windows))]
async fn run(_options: Options, _started_at_unix_ms: u128) -> io::Result<()> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "Phase 0 only implements Windows Named Pipe transport",
    ))
}

#[cfg(windows)]
async fn handle_client(
    mut server: tokio::net::windows::named_pipe::NamedPipeServer,
    started_at_unix_ms: u128,
) -> io::Result<()> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let mut message = Vec::with_capacity(1024);
    let mut chunk = [0_u8; 1024];
    let mut oversized = false;

    loop {
        let read = server.read(&mut chunk).await?;
        if read == 0 {
            break;
        }
        if let Some(newline) = chunk[..read].iter().position(|byte| *byte == b'\n') {
            if message.len() + newline > MAX_MESSAGE_BYTES {
                oversized = true;
            } else {
                message.extend_from_slice(&chunk[..newline]);
            }
            break;
        }
        if message.len() + read > MAX_MESSAGE_BYTES {
            oversized = true;
            break;
        }
        message.extend_from_slice(&chunk[..read]);
    }

    let response = if oversized {
        serialize_error(Value::Null, MESSAGE_TOO_LARGE, "Message exceeds 64 KiB")
    } else {
        dispatch(&message, started_at_unix_ms)
    };

    server.write_all(&response).await?;
    server.write_all(b"\n").await?;
    server.flush().await?;
    Ok(())
}

fn dispatch(message: &[u8], started_at_unix_ms: u128) -> Vec<u8> {
    let request = match serde_json::from_slice::<RpcRequest>(message) {
        Ok(request) => request,
        Err(_) => return serialize_error(Value::Null, PARSE_ERROR, "Invalid JSON"),
    };

    let id = request.id.clone();
    if let Err(error) = request.validate() {
        return serialize_error(id, error.code, error.message);
    }

    if request
        .params
        .as_ref()
        .is_some_and(|params| !params.is_object() && !params.is_null())
    {
        return serialize_error(id, INVALID_REQUEST, "params must be an object or null");
    }

    match request.method.as_str() {
        "runtime.health" => serde_json::to_vec(&RpcResponse::new(
            id,
            HealthResult {
                protocol_version: PROTOCOL_VERSION,
                runtime_version: env!("CARGO_PKG_VERSION"),
                pid: std::process::id(),
                started_at_unix_ms,
                capabilities: vec!["runtime.health"],
            },
        ))
        .expect("health response serialization cannot fail"),
        _ => serialize_error(id, METHOD_NOT_FOUND, "Method not found"),
    }
}

fn serialize_error(id: Value, code: i32, message: impl Into<String>) -> Vec<u8> {
    serde_json::to_vec(&RpcErrorResponse::new(id, RpcError::new(code, message)))
        .expect("error response serialization cannot fail")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dispatches_health() {
        let response = dispatch(
            br#"{"jsonrpc":"2.0","id":"health","method":"runtime.health","params":{}}"#,
            123,
        );
        let value: Value = serde_json::from_slice(&response).expect("response should be JSON");

        assert_eq!(value["id"], "health");
        assert_eq!(value["result"]["protocolVersion"], PROTOCOL_VERSION);
        assert_eq!(value["result"]["capabilities"][0], "runtime.health");
    }

    #[test]
    fn returns_parse_error_for_invalid_json() {
        let response = dispatch(b"not-json", 123);
        let value: Value = serde_json::from_slice(&response).expect("response should be JSON");
        assert_eq!(value["error"]["code"], PARSE_ERROR);
    }

    #[test]
    fn returns_method_not_found() {
        let response = dispatch(
            br#"{"jsonrpc":"2.0","id":9,"method":"missing.method"}"#,
            123,
        );
        let value: Value = serde_json::from_slice(&response).expect("response should be JSON");
        assert_eq!(value["id"], 9);
        assert_eq!(value["error"]["code"], METHOD_NOT_FOUND);
    }
}
