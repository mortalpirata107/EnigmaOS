use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::Duration;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

static WHATSAPP_CHILD: Mutex<Option<Child>> = Mutex::new(None);

#[allow(dead_code)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WhatsAppStatus {
    pub connected: bool,
    pub status: String,
    pub user: Option<String>,
    pub has_qr: bool,
}

#[allow(dead_code)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WhatsAppQrResponse {
    pub connected: bool,
    pub status: String,
    pub qr: Option<String>,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WhatsAppSendResult {
    pub success: bool,
    pub message_id: Option<String>,
    pub to: Option<String>,
    pub message: Option<String>,
    pub error: Option<String>,
}

/// Locates the whatsapp-bridge directory containing index.js
fn find_bridge_dir() -> Option<PathBuf> {
    let candidate_dirs = [
        PathBuf::from("whatsapp-bridge"),
        PathBuf::from("/usr/share/enigmaos/whatsapp-bridge"),
        PathBuf::from("/usr/local/share/enigmaos/whatsapp-bridge"),
    ];

    for dir in &candidate_dirs {
        if dir.join("index.js").exists() {
            return Some(dir.clone());
        }
    }

    if let Ok(current) = std::env::current_dir() {
        let p = current.join("whatsapp-bridge");
        if p.join("index.js").exists() {
            return Some(p);
        }
    }

    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            let p = parent.join("whatsapp-bridge");
            if p.join("index.js").exists() {
                return Some(p);
            }
            if let Some(grandparent) = parent.parent() {
                let gp = grandparent.join("whatsapp-bridge");
                if gp.join("index.js").exists() {
                    return Some(gp);
                }
            }
        }
    }

    if let Ok(home) = std::env::var("HOME") {
        let p = PathBuf::from(home).join(".local/share/enigma/whatsapp-bridge");
        if p.join("index.js").exists() {
            return Some(p);
        }
    }

    None
}

/// Checks synchronously if the WhatsApp bridge is already running on port 3030
pub fn is_bridge_running() -> bool {
    use std::net::{SocketAddr, TcpStream};
    if let Ok(addr) = "127.0.0.1:3030".parse::<SocketAddr>() {
        return TcpStream::connect_timeout(&addr, Duration::from_millis(300)).is_ok();
    }
    false
}

/// Starts the Node.js WhatsApp microservice in the background silently
pub fn start_whatsapp_bridge() {
    let mut child_lock = WHATSAPP_CHILD.lock().unwrap();
    if let Some(ref mut child) = *child_lock {
        match child.try_wait() {
            Ok(None) => {
                // Sigue corriendo
                return;
            }
            _ => {
                *child_lock = None;
            }
        }
    }

    if is_bridge_running() {
        eprintln!("[WhatsAppBridge] Bridge is already running and responding on http://127.0.0.1:3030.");
        return;
    }

    let bridge_dir = match find_bridge_dir() {
        Some(d) => d,
        None => {
            eprintln!("[WhatsAppBridge] Error: Directory 'whatsapp-bridge' not found.");
            return;
        }
    };

    eprintln!("[WhatsAppBridge] Launching Node.js Baileys microservice from: {:?}", bridge_dir);

    match Command::new("node")
        .arg("index.js")
        .current_dir(&bridge_dir)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
    {
        Ok(child) => {
            eprintln!("[WhatsAppBridge] Node process spawned silently with PID: {}", child.id());
            *child_lock = Some(child);
        }
        Err(e) => {
            eprintln!("[WhatsAppBridge] Failed to spawn Node.js microservice: {}", e);
        }
    }
}

/// Performs a synchronous HTTP GET to /shutdown to let Baileys flush E2EE keys and credentials to disk
pub fn shutdown_bridge_http() {
    eprintln!("[WhatsAppBridge] Sending synchronous HTTP GET to http://127.0.0.1:3030/shutdown...");
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_millis(2000))
        .build();

    match client {
        Ok(c) => {
            match c.get("http://127.0.0.1:3030/shutdown").send() {
                Ok(resp) => {
                    eprintln!("[WhatsAppBridge] /shutdown HTTP response: {}", resp.status());
                }
                Err(e) => {
                    eprintln!("[WhatsAppBridge] /shutdown HTTP call finished/dropped: {}", e);
                }
            }
        }
        Err(_) => {
            let _ = reqwest::blocking::get("http://127.0.0.1:3030/shutdown");
        }
    }
}

/// Terminates the Node.js WhatsApp microservice child process gracefully
pub fn stop_whatsapp_bridge() {
    eprintln!("[WhatsAppBridge] Stopping WhatsApp microservice gracefully...");
    // 1. Primer intento: Apagado elegante vía HTTP
    shutdown_bridge_http();

    if let Ok(mut lock) = WHATSAPP_CHILD.lock() {
        if let Some(mut child) = lock.take() {
            let pid = child.id();

            // Esperar hasta 1.5s para que termine limpiamente por HTTP
            for _ in 0..15 {
                if let Ok(Some(_)) = child.try_wait() {
                    eprintln!("[WhatsAppBridge] WhatsApp microservice PID {} exited gracefully via HTTP shutdown.", pid);
                    return;
                }
                std::thread::sleep(std::time::Duration::from_millis(100));
            }

            // 2. Si aún sigue corriendo, enviar señal SIGTERM
            let _ = std::process::Command::new("kill")
                .arg("-15")
                .arg(pid.to_string())
                .status();

            for _ in 0..10 {
                if let Ok(Some(_)) = child.try_wait() {
                    eprintln!("[WhatsAppBridge] WhatsApp microservice PID {} exited gracefully via SIGTERM.", pid);
                    return;
                }
                std::thread::sleep(std::time::Duration::from_millis(100));
            }

            // 3. Fallback forzado
            let _ = child.kill();
            let _ = child.wait();
            eprintln!("[WhatsAppBridge] Force-killed WhatsApp microservice PID {}", pid);
        }
    }
}

/// Sends a WhatsApp message via the local microservice POST /send
pub async fn send_whatsapp_http(number: &str, message: &str) -> Result<WhatsAppSendResult, String> {
    let client = Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())?;

    let payload = serde_json::json!({
        "number": number,
        "message": message
    });

    let res = client
        .post("http://127.0.0.1:3030/send")
        .json(&payload)
        .send()
        .await
        .map_err(|e| format!("Error conectando con el microservicio de WhatsApp: {}", e))?;

    let status = res.status();
    let body_text = res.text().await.unwrap_or_default();

    if !status.is_success() {
        if let Ok(val) = serde_json::from_str::<serde_json::Value>(&body_text) {
            let err_msg = val.get("error").and_then(|v| v.as_str()).unwrap_or(&body_text);
            return Err(err_msg.to_string());
        }
        return Err(format!("WhatsApp bridge HTTP {}: {}", status, body_text));
    }

    let parsed = serde_json::from_str::<serde_json::Value>(&body_text).map_err(|e| e.to_string())?;
    Ok(WhatsAppSendResult {
        success: parsed.get("success").and_then(|v| v.as_bool()).unwrap_or(true),
        message_id: parsed.get("messageId").and_then(|v| v.as_str()).map(String::from),
        to: parsed.get("to").and_then(|v| v.as_str()).map(String::from),
        message: parsed.get("message").and_then(|v| v.as_str()).map(String::from),
        error: None,
    })
}

// ==========================================
// TAURI COMMANDS FOR FRONTEND
// ==========================================

#[tauri::command]
pub async fn get_whatsapp_status() -> Result<serde_json::Value, String> {
    let client = Client::builder()
        .timeout(Duration::from_secs(3))
        .build()
        .map_err(|e| e.to_string())?;

    let res = client
        .get("http://127.0.0.1:3030/status")
        .send()
        .await
        .map_err(|e| format!("Microservicio no disponible: {}", e))?;

    let val = res.json::<serde_json::Value>().await.map_err(|e| e.to_string())?;
    Ok(val)
}

#[tauri::command]
pub async fn get_whatsapp_qr() -> Result<serde_json::Value, String> {
    let client = Client::builder()
        .timeout(Duration::from_secs(3))
        .build()
        .map_err(|e| e.to_string())?;

    let res = client
        .get("http://127.0.0.1:3030/qr")
        .send()
        .await
        .map_err(|e| format!("Microservicio no disponible: {}", e))?;

    let val = res.json::<serde_json::Value>().await.map_err(|e| e.to_string())?;
    Ok(val)
}

#[tauri::command]
pub async fn send_whatsapp_command(number: String, message: String) -> Result<WhatsAppSendResult, String> {
    send_whatsapp_http(&number, &message).await
}

/// Sincroniza los contactos desde http://127.0.0.1:3030/contacts a SQLite
pub async fn sync_contacts_from_bridge(app_handle: Option<AppHandle>) -> Result<usize, String> {
    let client = Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
        .map_err(|e| e.to_string())?;

    let res = client
        .get("http://127.0.0.1:3030/contacts")
        .send()
        .await
        .map_err(|e| format!("Error conectando con GET /contacts: {}", e))?;

    if !res.status().is_success() {
        return Err(format!("GET /contacts HTTP {}", res.status()));
    }

    let contacts = res
        .json::<Vec<crate::db::WhatsAppContact>>()
        .await
        .map_err(|e| format!("Error deserializando contactos: {}", e))?;

    if contacts.is_empty() {
        return Ok(0);
    }

    let count = crate::db::db_upsert_whatsapp_contacts_batch(&contacts)
        .map_err(|e| format!("Error guardando en SQLite: {}", e))?;

    eprintln!("[WhatsAppSync] Sincronizados {} contactos de WhatsApp en SQLite.", count);

    if let Some(app) = app_handle {
        let _ = app.emit("refresh-contacts", ());
    }

    Ok(count)
}

/// Supervisa el microservicio de WhatsApp en segundo plano y sincroniza contactos en el arranque
pub fn start_contacts_sync_daemon(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        // Esperar 4 segundos tras arrancar para verificar que Baileys / Express esté activo
        tokio::time::sleep(Duration::from_secs(4)).await;

        if is_bridge_running() {
            let _ = sync_contacts_from_bridge(Some(app.clone())).await;
        }

        loop {
            if !is_bridge_running() {
                start_whatsapp_bridge();
            }
            // Comprobación de salud del proceso cada 60 segundos
            tokio::time::sleep(Duration::from_secs(60)).await;
        }
    });
}

#[tauri::command]
pub async fn sync_whatsapp_contacts(app: AppHandle) -> Result<usize, String> {
    sync_contacts_from_bridge(Some(app)).await
}
