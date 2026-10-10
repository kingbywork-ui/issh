//! MCP SSH connections reuse the desktop's host-key trust decisions.
//! Fingerprints come from Runtime discovery; the UI can only accept or reject
//! the pending request, never replace its fingerprint.

use serde::Serialize;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use tokio::sync::oneshot;

pub const REQUEST_EVENT: &str = "issh://ssh-host-key-request";
pub const CANCEL_EVENT: &str = "issh://ssh-host-key-cancel";

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostKeyRequest {
    pub id: u64,
    pub host: String,
    pub port: u16,
    pub fingerprint: String,
}

type Emit = dyn Fn(&str, &HostKeyRequest) -> Result<(), String> + Send + Sync;

pub struct HostKeyConfirmation {
    next_id: AtomicU64,
    pending: Mutex<HashMap<u64, (HostKeyRequest, oneshot::Sender<bool>)>>,
    emit: Box<Emit>,
}

impl Default for HostKeyConfirmation {
    fn default() -> Self {
        Self::new(|_, _| Err("SSH 主机密钥确认界面不可用".into()))
    }
}

impl HostKeyConfirmation {
    pub fn new(
        emit: impl Fn(&str, &HostKeyRequest) -> Result<(), String> + Send + Sync + 'static,
    ) -> Self {
        Self {
            next_id: AtomicU64::new(1),
            pending: Mutex::new(HashMap::new()),
            emit: Box::new(emit),
        }
    }

    pub async fn confirm(&self, host: &str, port: u16, fingerprint: &str) -> Result<(), String> {
        if !fingerprint.starts_with("SHA256:") || fingerprint.len() <= 7 {
            return Err("SSH 主机密钥探测未返回有效指纹".into());
        }
        let request = HostKeyRequest {
            id: self.next_id.fetch_add(1, Ordering::Relaxed),
            host: host.to_string(),
            port,
            fingerprint: fingerprint.to_string(),
        };
        let (sender, receiver) = oneshot::channel();
        self.pending
            .lock()
            .map_err(|_| "SSH 主机密钥确认状态不可用")?
            .insert(request.id, (request.clone(), sender));
        // Dropping a timed-out/disconnected request also dismisses its dialog.
        let _pending = PendingConfirmation {
            broker: self,
            request: &request,
        };
        (self.emit)(REQUEST_EVENT, &request)?;
        match receiver.await {
            Ok(true) => Ok(()),
            Ok(false) => Err(format!("SSH 主机密钥未获信任：{host}:{port}")),
            Err(_) => Err("SSH 主机密钥确认已取消".into()),
        }
    }

    pub fn is_pending(&self, id: u64) -> bool {
        self.pending
            .lock()
            .is_ok_and(|pending| pending.contains_key(&id))
    }

    // Bridge can restore before the WebView finishes registering listeners.
    // Replay only still-pending requests once the desktop is ready (or reloads).
    pub fn replay_pending(&self) -> Result<(), String> {
        let requests: Vec<_> = self
            .pending
            .lock()
            .map_err(|_| "SSH 主机密钥确认状态不可用")?
            .values()
            .map(|(request, _)| request.clone())
            .collect();
        for request in requests {
            (self.emit)(REQUEST_EVENT, &request)?;
        }
        Ok(())
    }

    pub fn resolve(&self, id: u64, accepted: bool) -> Result<(), String> {
        let (_, sender) = self
            .pending
            .lock()
            .map_err(|_| "SSH 主机密钥确认状态不可用")?
            .remove(&id)
            .ok_or("SSH 主机密钥确认已过期")?;
        sender
            .send(accepted)
            .map_err(|_| "SSH 主机密钥确认已过期".into())
    }
}

struct PendingConfirmation<'a> {
    broker: &'a HostKeyConfirmation,
    request: &'a HostKeyRequest,
}

impl Drop for PendingConfirmation<'_> {
    fn drop(&mut self) {
        let removed = self
            .broker
            .pending
            .lock()
            .ok()
            .and_then(|mut pending| pending.remove(&self.request.id));
        if removed.is_some() {
            let _ = (self.broker.emit)(CANCEL_EVENT, self.request);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::time::Duration;

    #[tokio::test]
    async fn decisions_are_bound_to_their_request_and_cannot_be_replayed() {
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let broker = Arc::new(HostKeyConfirmation::new(move |event, request| {
            tx.send((event.to_string(), request.clone()))
                .map_err(|e| e.to_string())
        }));
        let first_broker = broker.clone();
        let first =
            tokio::spawn(async move { first_broker.confirm("first", 22, "SHA256:first").await });
        let second_broker = broker.clone();
        let second =
            tokio::spawn(async move { second_broker.confirm("second", 22, "SHA256:second").await });
        let a = rx.recv().await.unwrap().1;
        let b = rx.recv().await.unwrap().1;
        assert_ne!(a.id, b.id);
        for request in [a, b] {
            broker.resolve(request.id, request.host == "first").unwrap();
            assert!(broker.resolve(request.id, true).is_err());
        }
        assert!(first.await.unwrap().is_ok());
        assert!(second.await.unwrap().unwrap_err().contains("未获信任"));
        assert!(
            rx.try_recv().is_err(),
            "answered requests do not emit cancellation"
        );
    }

    #[tokio::test]
    async fn timeout_cancels_the_ui_request_and_rejects_late_approval() {
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let broker = HostKeyConfirmation::new(move |event, request| {
            tx.send((event.to_string(), request.clone()))
                .map_err(|e| e.to_string())
        });
        assert!(tokio::time::timeout(
            Duration::from_millis(20),
            broker.confirm("host", 22, "SHA256:key")
        )
        .await
        .is_err());
        let request = rx.recv().await.unwrap();
        let cancel = rx.recv().await.unwrap();
        assert_eq!(request.0, REQUEST_EVENT);
        assert_eq!(cancel.0, CANCEL_EVENT);
        assert_eq!(request.1.id, cancel.1.id);
        assert!(!broker.is_pending(request.1.id));
        assert!(broker.resolve(request.1.id, true).is_err());
    }

    #[tokio::test]
    async fn desktop_startup_replays_only_pending_requests() {
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let broker = Arc::new(HostKeyConfirmation::new(move |event, request| {
            tx.send((event.to_string(), request.clone()))
                .map_err(|e| e.to_string())
        }));
        let confirming = broker.clone();
        let task = tokio::spawn(async move { confirming.confirm("host", 22, "SHA256:key").await });
        let original = rx.recv().await.unwrap();
        broker.replay_pending().unwrap();
        let replay = rx.recv().await.unwrap();
        assert_eq!(original.1.id, replay.1.id);
        assert_eq!(replay.0, REQUEST_EVENT);
        broker.resolve(original.1.id, true).unwrap();
        assert!(task.await.unwrap().is_ok());
        broker.replay_pending().unwrap();
        assert!(rx.try_recv().is_err());
    }

    #[tokio::test]
    async fn missing_ui_or_invalid_discovery_cannot_approve_a_key() {
        let broker = HostKeyConfirmation::default();
        assert!(broker.confirm("host", 22, "").await.is_err());
        assert!(broker
            .confirm("host", 22, "SHA256:key")
            .await
            .unwrap_err()
            .contains("界面不可用"));
        assert!(!broker.is_pending(1));
    }
}
