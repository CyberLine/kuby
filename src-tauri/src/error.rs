use serde::Serialize;
use thiserror::Error;

pub type Result<T> = std::result::Result<T, KubyError>;

#[derive(Debug, Error)]
pub enum KubyError {
    #[error("{0}")]
    Message(String),
    #[error(transparent)]
    Anyhow(#[from] anyhow::Error),
    #[error(transparent)]
    Kube(#[from] kube::Error),
    #[error(transparent)]
    SerdeJson(#[from] serde_json::Error),
    #[error(transparent)]
    SerdeYaml(#[from] serde_yaml::Error),
    #[error(transparent)]
    Io(#[from] std::io::Error),
}

impl KubyError {
    /// Full error chain for UI / IPC (anyhow's `Display` omits causes).
    pub fn full_message(&self) -> String {
        match self {
            Self::Anyhow(err) => format!("{err:#}"),
            Self::Kube(err) => format_error_chain(err),
            Self::SerdeJson(err) => format_error_chain(err),
            Self::SerdeYaml(err) => format_error_chain(err),
            Self::Io(err) => format_error_chain(err),
            Self::Message(msg) => msg.clone(),
        }
    }
}

fn format_error_chain(err: &dyn std::error::Error) -> String {
    let mut parts = vec![err.to_string()];
    let mut source = err.source();
    while let Some(cause) = source {
        parts.push(cause.to_string());
        source = cause.source();
    }
    parts.join(": ")
}

impl Serialize for KubyError {
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.full_message())
    }
}

impl From<&str> for KubyError {
    fn from(value: &str) -> Self {
        Self::Message(value.to_string())
    }
}

impl From<String> for KubyError {
    fn from(value: String) -> Self {
        Self::Message(value)
    }
}

pub fn kube_is_forbidden(err: &kube::Error) -> bool {
    matches!(err, kube::Error::Api(status) if status.code == 403)
}

pub fn kube_is_not_found(err: &kube::Error) -> bool {
    matches!(err, kube::Error::Api(status) if status.code == 404)
}

pub fn kube_is_method_not_allowed(err: &kube::Error) -> bool {
    matches!(err, kube::Error::Api(status) if status.code == 405)
}

/// Short API reason without kube-rs's `Display` dump of the full `Status`.
pub fn kube_api_message(err: &kube::Error) -> String {
    match err {
        kube::Error::Api(status) if !status.message.is_empty() => status.message.clone(),
        kube::Error::Api(status) if !status.reason.is_empty() => status.reason.clone(),
        kube::Error::Api(status) => format!("Kubernetes API error {}", status.code),
        other => other.to_string(),
    }
}
