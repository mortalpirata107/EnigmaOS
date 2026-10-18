//! Telegram Messenger Bridge for Enigma (`messenger_bridge.rs`)
//!
//! Replaces KDE Connect with a private, bi-directional Telegram Bot client
//! powered by `teloxide`:
//! - Receives incoming messages from the user's Telegram, passes them to
//!   Enigma's AI router (`router.rs`), and replies in chat.
//! - Exposes `send_telegram_alert(message: &str)` to send proactive notifications
//!   directly to the user's mobile device.

use std::sync::atomic::{AtomicI64, Ordering};
use tauri::{AppHandle, Emitter};
use teloxide::prelude::*;
use teloxide::types::ChatId;

static TARGET_CHAT_ID: AtomicI64 = AtomicI64::new(0);

/// Retrieves the configured Telegram bot token from environment or SQLite database
pub fn get_bot_token() -> Option<String> {
    if let Ok(token) = std::env::var("TELOXIDE_TOKEN") {
        let t = token.trim();
        if !t.is_empty() {
            return Some(t.to_string());
        }
    }
    if let Ok(token) = std::env::var("TELEGRAM_BOT_TOKEN") {
        let t = token.trim();
        if !t.is_empty() {
            return Some(t.to_string());
        }
    }

    // Fallback: check SQLite extensions table
    let db_path = crate::db::get_db_path();
    if let Ok(conn) = rusqlite::Connection::open(&db_path) {
        if let Ok(mut stmt) = conn.prepare(
            "SELECT auth_token FROM extensions WHERE service_name = 'telegram' AND status = 'active' LIMIT 1;",
        ) {
            if let Ok(mut rows) = stmt.query([]) {
                if let Ok(Some(row)) = rows.next() {
                    if let Ok(Some(token)) = row.get::<_, Option<String>>(0) {
                        let t = token.trim();
                        if !t.is_empty() {
                            return Some(t.to_string());
                        }
                    }
                }
            }
        }
    }

    None
}

/// Retrieves the active or cached Telegram target chat ID
pub fn get_target_chat_id() -> i64 {
    let current = TARGET_CHAT_ID.load(Ordering::Relaxed);
    if current != 0 {
        return current;
    }

    // Try reading from environment variable
    if let Ok(id_str) = std::env::var("TELEGRAM_CHAT_ID") {
        if let Ok(parsed) = id_str.trim().parse::<i64>() {
            TARGET_CHAT_ID.store(parsed, Ordering::Relaxed);
            return parsed;
        }
    }

    // Try reading cached chat_id from SQLite extensions table
    let db_path = crate::db::get_db_path();
    if let Ok(conn) = rusqlite::Connection::open(&db_path) {
        if let Ok(mut stmt) = conn.prepare(
            "SELECT auth_token FROM extensions WHERE service_name = 'telegram_chat_id' LIMIT 1;",
        ) {
            if let Ok(mut rows) = stmt.query([]) {
                if let Ok(Some(row)) = rows.next() {
                    if let Ok(Some(token)) = row.get::<_, Option<String>>(0) {
                        if let Ok(parsed) = token.trim().parse::<i64>() {
                            TARGET_CHAT_ID.store(parsed, Ordering::Relaxed);
                            return parsed;
                        }
                    }
                }
            }
        }
    }

    0
}

/// Updates and persists the active Telegram target chat ID
pub fn set_target_chat_id(chat_id: i64) {
    TARGET_CHAT_ID.store(chat_id, Ordering::Relaxed);

    let db_path = crate::db::get_db_path();
    if let Ok(conn) = rusqlite::Connection::open(&db_path) {
        let _ = conn.execute(
            "INSERT INTO extensions (service_name, auth_token, status) 
             VALUES ('telegram_chat_id', ?1, 'active')
             ON CONFLICT(service_name) DO UPDATE SET auth_token = ?1, status = 'active';",
            rusqlite::params![chat_id.to_string()],
        );
    }
}

/// Sends a proactive notification message directly to the user's mobile device via Telegram
pub async fn send_telegram_alert(message: &str) -> Result<String, String> {
    if message.trim().is_empty() {
        return Err("El mensaje de alerta no puede estar vacío.".to_string());
    }

    let token = match get_bot_token() {
        Some(t) => t,
        None => {
            eprintln!("[Telegram] No se encontró TELEGRAM_BOT_TOKEN ni registro en extensiones.");
            return Err("Token de Telegram no configurado (asigna TELEGRAM_BOT_TOKEN o configúralo en la app).".to_string());
        }
    };

    let chat_id = get_target_chat_id();
    if chat_id == 0 {
        eprintln!("[Telegram] Chat ID no establecido aún. Envía un mensaje a tu bot en Telegram primero.");
        return Err("Móvil no vinculado: Escribe un mensaje a tu bot de Telegram para que Enigma conozca tu chat.".to_string());
    }

    let bot = Bot::new(token);
    bot.send_message(ChatId(chat_id), message)
        .await
        .map_err(|e| format!("Error enviando alerta por Telegram: {}", e))?;

    eprintln!("[Telegram] Alerta enviada con éxito a chat ID {}: '{}'", chat_id, message);
    Ok(format!("Alerta enviada a Telegram (Chat ID: {})", chat_id))
}

/// Non-async helper to dispatch a Telegram alert in the background
#[allow(dead_code)]
pub fn send_telegram_alert_sync(message: String) {
    tauri::async_runtime::spawn(async move {
        if let Err(e) = send_telegram_alert(&message).await {
            eprintln!("[Telegram] Fallo en send_telegram_alert_sync: {}", e);
        }
    });
}

/// Starts the bi-directional Telegram bot long-polling listener
pub fn start_telegram_bot(app_handle: AppHandle) {
    // Cargar variables de entorno desde .env si existe
    let _ = dotenvy::dotenv();
    let _ = dotenvy::from_filename("src-tauri/.env");
    if let Ok(home) = std::env::var("HOME") {
        let _ = dotenvy::from_filename(format!("{}/.config/enigma/.env", home));
    }

    let token = match get_bot_token() {
        Some(t) => t,
        None => {
            eprintln!("[Telegram] Bot inactivo: No hay token de Telegram configurado. Configura TELEGRAM_BOT_TOKEN en tu entorno o en extensiones SQLite para activar Enigma Telegram.");
            return;
        }
    };

    let chat_id = get_target_chat_id();
    if chat_id != 0 {
        eprintln!("[Telegram] Target Chat ID pre-configurado: {}", chat_id);
    }

    tauri::async_runtime::spawn(async move {
        eprintln!("[Telegram] Iniciando bot privado de Telegram para Enigma...");
        let bot = Bot::new(token);

        let handler = Update::filter_message().endpoint(move |bot: Bot, msg: Message| {
            let app = app_handle.clone();
            async move {
                let chat_id = msg.chat.id;
                set_target_chat_id(chat_id.0);

                if let Some(user_text) = msg.text() {
                    let prompt = user_text.trim();
                    eprintln!("[Telegram] Mensaje entrante de {}: '{}'", chat_id.0, prompt);

                    // 1. Guardar mensaje del usuario en memoria SQLite
                    let _ = crate::memory::save_chat_message("user".to_string(), prompt.to_string());

                    // 2. Procesar con el enrutador inteligente de Enigma
                    let reply_text = match crate::router::process_enigma_message_core(Some(&app), prompt.to_string(), None).await {
                        Ok(res) => res.content,
                        Err(e) => format!("⚠️ Error en Enigma: {}", e),
                    };

                    // 3. Responder al usuario en Telegram
                    if let Err(e) = bot.send_message(chat_id, &reply_text).await {
                        eprintln!("[Telegram] Error enviando respuesta: {}", e);
                    }

                    // 4. Guardar respuesta del asistente en memoria y sincronizar con la interfaz de escritorio
                    let _ = crate::memory::save_chat_message("assistant".to_string(), reply_text.clone());
                    let _ = app.emit("enigma-token", reply_text);
                    let _ = app.emit("enigma-done", ());
                }

                respond(())
            }
        });

        Dispatcher::builder(bot, handler)
            .build()
            .dispatch()
            .await;
        
        eprintln!("[Telegram] Dispatcher de Telegram finalizado.");
    });
}

/// Tauri command to test sending a Telegram alert from the UI
#[tauri::command]
pub async fn send_telegram_notification(message: String) -> Result<String, String> {
    send_telegram_alert(&message).await
}

/// Tauri command to check Telegram configuration and status
#[tauri::command]
pub fn get_telegram_status() -> Result<serde_json::Value, String> {
    let has_token = get_bot_token().is_some();
    let chat_id = get_target_chat_id();
    Ok(serde_json::json!({
        "configured": has_token,
        "chat_id": if chat_id != 0 { Some(chat_id) } else { None },
        "active": has_token && chat_id != 0
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_chat_id_storage() {
        TARGET_CHAT_ID.store(12345678, Ordering::Relaxed);
        assert_eq!(get_target_chat_id(), 12345678);
    }

    #[test]
    fn test_dotenv_bot_token_loading() {
        let _ = dotenvy::dotenv();
        let _ = dotenvy::from_filename("src-tauri/.env");
        let token = get_bot_token();
        assert!(token.is_some(), "El token de Telegram debería poder leerse del archivo .env");
    }

    #[test]
    fn test_telegram_status_configured() {
        let _ = dotenvy::dotenv();
        let _ = dotenvy::from_filename("src-tauri/.env");
        let status = get_telegram_status().unwrap();
        assert_eq!(status["configured"], true);
    }

    #[tokio::test]
    async fn test_send_telegram_alert_empty_validation() {
        let res = send_telegram_alert("   ").await;
        assert!(res.is_err());
        assert!(res.unwrap_err().contains("vacío"));
    }
}

