use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

#[derive(Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AuthMode {
    Subscription,
    ApiKey,
    None,
}

#[derive(Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Provider {
    Claude,
    Codex,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderAuth {
    pub mode: AuthMode,
    #[serde(default)]
    pub api_key: Option<String>,
}

impl Default for ProviderAuth {
    fn default() -> Self {
        Self {
            mode: AuthMode::None,
            api_key: None,
        }
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppConfig {
    pub onboarded: bool,
    pub username: String,
    pub avatar: String,
    pub theme: String,
    #[serde(default)]
    pub claude: ProviderAuth,
    #[serde(default)]
    pub codex: ProviderAuth,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            onboarded: false,
            username: String::new(),
            avatar: "preset:0".into(),
            theme: "system".into(),
            claude: ProviderAuth::default(),
            codex: ProviderAuth::default(),
        }
    }
}

pub fn config_dir() -> PathBuf {
    dirs::config_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("agentmux")
}

fn config_file() -> PathBuf {
    config_dir().join("config.json")
}

pub fn load_config() -> AppConfig {
    fs::read_to_string(config_file())
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

pub fn store_config(config: &AppConfig) -> Result<(), String> {
    let dir = config_dir();
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let json = serde_json::to_string_pretty(config).map_err(|e| e.to_string())?;
    fs::write(config_file(), json).map_err(|e| e.to_string())
}
