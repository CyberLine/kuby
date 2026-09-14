use kube::config::Kubeconfig;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthSummary {
    pub method: String,
    pub detail: String,
    pub exec_command: Option<String>,
    pub exec_args: Vec<String>,
    pub supports_refresh: bool,
}

/// Summarize auth for a kubeconfig user (OIDC / exec / cert / token / cloud helpers).
pub fn describe_auth(cfg: &Kubeconfig, user_name: &str) -> AuthSummary {
    let Some(auth) = cfg.auth_infos.iter().find(|a| a.name == user_name) else {
        return AuthSummary {
            method: "unknown".into(),
            detail: format!("user '{user_name}' not found in kubeconfig"),
            exec_command: None,
            exec_args: vec![],
            supports_refresh: false,
        };
    };

    let Some(info) = auth.auth_info.as_ref() else {
        return AuthSummary {
            method: "empty".into(),
            detail: "no auth info".into(),
            exec_command: None,
            exec_args: vec![],
            supports_refresh: false,
        };
    };

    if let Some(exec) = info.exec.as_ref() {
        let cmd = exec.command.clone().unwrap_or_default();
        let args = exec.args.clone().unwrap_or_default();
        let method = classify_exec(&cmd, &args);
        return AuthSummary {
            method: method.clone(),
            detail: format!("exec: {cmd} {}", args.join(" ")),
            exec_command: Some(cmd),
            exec_args: args,
            supports_refresh: true,
        };
    }

    if let Some(provider) = info.auth_provider.as_ref() {
        let name = provider.name.clone();
        return AuthSummary {
            method: if name.contains("oidc") {
                "oidc".into()
            } else {
                format!("auth-provider:{name}")
            },
            detail: format!("auth-provider {name}"),
            exec_command: None,
            exec_args: vec![],
            supports_refresh: true,
        };
    }

    if info.client_certificate.is_some()
        || info.client_certificate_data.is_some()
        || info.client_key.is_some()
        || info.client_key_data.is_some()
    {
        return AuthSummary {
            method: "client-cert".into(),
            detail: "client certificate authentication".into(),
            exec_command: None,
            exec_args: vec![],
            supports_refresh: false,
        };
    }

    if info.token.is_some() || info.token_file.is_some() {
        return AuthSummary {
            method: "token".into(),
            detail: "bearer token".into(),
            exec_command: None,
            exec_args: vec![],
            supports_refresh: false,
        };
    }

    if info.username.is_some() {
        return AuthSummary {
            method: "basic".into(),
            detail: "username/password".into(),
            exec_command: None,
            exec_args: vec![],
            supports_refresh: false,
        };
    }

    AuthSummary {
        method: "unknown".into(),
        detail: "no recognized auth method".into(),
        exec_command: None,
        exec_args: vec![],
        supports_refresh: false,
    }
}

fn classify_exec(cmd: &str, args: &[String]) -> String {
    let lower = cmd.to_lowercase();
    let joined = args.join(" ").to_lowercase();
    if lower.contains("kubelogin") || (lower.ends_with("kubectl") && joined.contains("oidc-login"))
    {
        return "oidc-kubelogin".into();
    }
    if lower.contains("aws") || joined.contains("eks get-token") {
        return "aws-eks".into();
    }
    if lower.contains("gke-gcloud-auth-plugin") || lower.contains("gcloud") {
        return "gcp-gke".into();
    }
    if lower.contains("azure") || (lower.contains("kubelogin") && joined.contains("azure")) {
        return "azure-aks".into();
    }
    if lower.contains("tsh") || lower.contains("teleport") {
        return "teleport".into();
    }
    "exec".into()
}
