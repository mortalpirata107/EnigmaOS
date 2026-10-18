//! Models Configuration Subsystem for EnigmaOS
//!
//! Provides:
//! 1. User-editable configuration file: `~/.config/enigmaos/models.json`
//! 2. Automatic preset selection (Lightweight, Balanced, Pro)
//! 3. Auto-detection of installed Ollama models via `/api/tags`
//! 4. Seamless fallback so Enigma never crashes if a specialized model is missing.

use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::PathBuf;
use std::time::Duration;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelConfig {
    #[serde(default = "default_preset")]
    pub preset: String, // "lightweight" | "balanced" | "pro" | "custom"
    #[serde(default = "default_orchestrator")]
    pub orchestrator_model: String,
    #[serde(default = "default_system")]
    pub system_model: String,
    #[serde(default = "default_code")]
    pub code_model: String,
    #[serde(default = "default_reasoning")]
    pub reasoning_model: String,
    #[serde(default = "default_general")]
    pub general_model: String,
    #[serde(default = "default_vision")]
    pub vision_model: String,
    #[serde(default = "default_fallback")]
    pub default_model: String,
}

fn default_preset() -> String {
    "balanced".to_string()
}
fn default_orchestrator() -> String {
    "llama3.2:3b".to_string()
}
fn default_system() -> String {
    "hermes3:8b".to_string()
}
fn default_code() -> String {
    "qwen2.5-coder:7b".to_string()
}
fn default_reasoning() -> String {
    "deepseek-r1:8b".to_string()
}
fn default_general() -> String {
    "llama3.2:3b".to_string()
}
fn default_vision() -> String {
    "llava:7b".to_string()
}
fn default_fallback() -> String {
    "llama3.2:3b".to_string()
}

impl Default for ModelConfig {
    fn default() -> Self {
        Self {
            preset: default_preset(),
            orchestrator_model: default_orchestrator(),
            system_model: default_system(),
            code_model: default_code(),
            reasoning_model: default_reasoning(),
            general_model: default_general(),
            vision_model: default_vision(),
            default_model: default_fallback(),
        }
    }
}

/// Resolves config path `~/.config/enigmaos/models.json`
pub fn get_models_config_path() -> PathBuf {
    let base = std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".config")))
        .unwrap_or_else(|| PathBuf::from("."));
    base.join("enigmaos").join("models.json")
}

/// Loads `models.json` or writes default if not present
pub fn load_model_config() -> ModelConfig {
    let path = get_models_config_path();
    if path.exists() {
        if let Ok(content) = std::fs::read_to_string(&path) {
            if let Ok(cfg) = serde_json::from_str::<ModelConfig>(&content) {
                return cfg;
            }
        }
    }

    // Si no existe, crear directorio y escribir configuración por defecto comentada
    let default_cfg = ModelConfig::default();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(json) = serde_json::to_string_pretty(&default_cfg) {
        let _ = std::fs::write(&path, json);
    }
    default_cfg
}

/// Saves `models.json`
pub fn save_model_config_to_disk(cfg: &ModelConfig) -> Result<(), String> {
    let path = get_models_config_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(cfg).map_err(|e| e.to_string())?;
    std::fs::write(path, json).map_err(|e| e.to_string())?;
    Ok(())
}

/// Queries Ollama API `/api/tags` to list all models already installed locally
pub async fn get_installed_ollama_models() -> Vec<String> {
    let client = Client::builder()
        .timeout(Duration::from_millis(1500))
        .build()
        .unwrap_or_default();

    let res = match client.get("http://localhost:11434/api/tags").send().await {
        Ok(r) => r,
        Err(_) => return Vec::new(),
    };

    if let Ok(json) = res.json::<Value>().await {
        if let Some(models) = json.get("models").and_then(|m| m.as_array()) {
            return models
                .iter()
                .filter_map(|item| item.get("name").and_then(|n| n.as_str()).map(|s| s.to_string()))
                .collect();
        }
    }
    Vec::new()
}

/// Resolves a requested model name against locally available models.
/// If the model is not found, it gracefully falls back to default_model or any installed model.
pub async fn resolve_or_fallback_model(preferred: &str, default_fallback: &str) -> String {
    let installed = get_installed_ollama_models().await;
    if installed.is_empty() {
        // No se pudo contactar a Ollama o no hay modelos listados aún: usar preferred tal cual
        return preferred.to_string();
    }

    let clean_pref = preferred.trim().to_lowercase();
    let pref_base = clean_pref.split(':').next().unwrap_or(&clean_pref);

    // 1. Coincidencia exacta o por prefijo (ej: "llama3.2" coincide con "llama3.2:latest" o "llama3.2:3b")
    for inst in &installed {
        let inst_lower = inst.to_lowercase();
        if inst_lower == clean_pref || inst_lower.starts_with(&format!("{}:", clean_pref)) {
            return inst.clone();
        }
        if inst_lower.starts_with(&format!("{}:", pref_base)) {
            return inst.clone();
        }
    }

    // 2. Coincidencia con default_fallback
    let clean_def = default_fallback.trim().to_lowercase();
    let def_base = clean_def.split(':').next().unwrap_or(&clean_def);
    for inst in &installed {
        let inst_lower = inst.to_lowercase();
        if inst_lower == clean_def || inst_lower.starts_with(&format!("{}:", def_base)) {
            eprintln!(
                "[ModelsConfig] Modelo preferido '{}' no encontrado. Usando fallback por defecto: '{}'",
                preferred, inst
            );
            return inst.clone();
        }
    }

    // 3. Fallback al primer modelo disponible en Ollama para no fallar jamás
    if let Some(first) = installed.first() {
        eprintln!(
            "[ModelsConfig] Ni '{}' ni '{}' encontrados. Usando primer modelo disponible: '{}'",
            preferred, default_fallback, first
        );
        return first.clone();
    }

    preferred.to_string()
}

/// Tauri command to get current model configuration and installed models
#[tauri::command]
pub async fn get_model_config_cmd() -> Result<Value, String> {
    let cfg = load_model_config();
    let installed = get_installed_ollama_models().await;
    let path = get_models_config_path();

    Ok(serde_json::json!({
        "config": cfg,
        "installed_models": installed,
        "config_file_path": path.to_string_lossy()
    }))
}

/// Tauri command to save updated model configuration
#[tauri::command]
pub fn save_model_config_cmd(config: ModelConfig) -> Result<(), String> {
    save_model_config_to_disk(&config)
}
