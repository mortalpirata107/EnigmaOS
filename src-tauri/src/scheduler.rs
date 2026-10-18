//! Scheduler Module for Enigma (`scheduler.rs`)
//!
//! Orchestrates proactive time blocks, routines, and calendar event notifications:
//! - Intercepts SQLite schedule blocks (`schedules`), local calendar events (`calendar_events`),
//!   and Google Calendar meetings (`google_auth.rs`).
//! - Beautifies event alerts dynamically using local LLM (`gemma4:e4b`) with Enigma's personal assistant prompt.
//! - Proactively routes formatted alerts to the user's mobile via Telegram using `teloxide` and `TELEGRAM_CHAT_ID`.
//! - Synchronizes notifications with desktop topbar UI and voice synthesis.

use chrono::{Datelike, Local, NaiveDate, NaiveDateTime, NaiveTime, Weekday};
use std::collections::HashSet;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use teloxide::prelude::*;
use teloxide::types::ChatId;

static LAST_ACTIVE_BLOCK_ID: AtomicI64 = AtomicI64::new(-1);
static NOTIFIED_CALENDAR_EVENTS: Mutex<Option<HashSet<String>>> = Mutex::new(None);

/// Obtiene el CHAT_ID configurado para Telegram, leyendo prioritariamente de `TELEGRAM_CHAT_ID`
/// en variables de entorno / `.env`, o recurriendo a la caché de `messenger_bridge` / SQLite.
pub fn get_telegram_chat_id() -> Option<i64> {
    if let Ok(val) = std::env::var("TELEGRAM_CHAT_ID") {
        if let Ok(parsed) = val.trim().parse::<i64>() {
            if parsed != 0 {
                return Some(parsed);
            }
        }
    }

    let bridge_id = crate::messenger_bridge::get_target_chat_id();
    if bridge_id != 0 {
        Some(bridge_id)
    } else {
        None
    }
}

/// Envía un mensaje proactivo a Telegram utilizando la biblioteca `teloxide`
/// conectándose directamente al bot y despachando al ChatId configurado en `.env`.
pub async fn send_telegram_alert_direct(message: &str) -> Result<(), String> {
    let chat_id = match get_telegram_chat_id() {
        Some(id) => id,
        None => {
            let err = "[Scheduler] Error: TELEGRAM_CHAT_ID no configurado en .env ni en base de datos.".to_string();
            eprintln!("{}", err);
            return Err(err);
        }
    };

    let token = match crate::messenger_bridge::get_bot_token() {
        Some(t) => t,
        None => {
            let err = "[Scheduler] Error: Token de Telegram no configurado (TELEGRAM_BOT_TOKEN o TELOXIDE_TOKEN).".to_string();
            eprintln!("{}", err);
            return Err(err);
        }
    };

    let bot = Bot::new(token);
    bot.send_message(ChatId(chat_id), message)
        .await
        .map_err(|e| {
            let err_msg = format!("Fallo al enviar mensaje por Telegram con teloxide: {}", e);
            eprintln!("[Scheduler] {}", err_msg);
            err_msg
        })?;

    eprintln!("[Scheduler] Alerta enviada con éxito a Telegram (ChatId: {})", chat_id);
    Ok(())
}

/// Elimina etiquetas internas `<think>...</think>` emitidas por modelos con cadena de razonamiento
fn strip_thinking_tags(input: &str) -> String {
    let mut out = String::new();
    let mut in_think = false;
    let mut chars = input.chars().peekable();

    while let Some(c) = chars.next() {
        if c == '<' {
            let mut tag = String::from("<");
            while let Some(&next_c) = chars.peek() {
                tag.push(next_c);
                chars.next();
                if next_c == '>' {
                    break;
                }
            }
            if tag == "<think>" {
                in_think = true;
                continue;
            } else if tag == "</think>" {
                in_think = false;
                continue;
            } else {
                if !in_think {
                    out.push_str(&tag);
                }
                continue;
            }
        }
        if !in_think {
            out.push(c);
        }
    }
    out.trim().to_string()
}

/// Genera un mensaje dinámico, cálido y con emojis utilizando el LLM local `gemma4:e4b`
/// con el System Prompt interno especificado para Enigma.
pub async fn generate_dynamic_alert_message(event_data: &str) -> String {
    let system_prompt = "Eres Enigma, el asistente personal de Santiago. Tienes que avisarle de un evento inminente. Redacta un mensaje de Telegram corto, amigable, directo y con emojis adecuados al tema. No añadas introducciones, solo el mensaje que le enviarías.";
    let user_prompt = format!("Datos del evento: {}", event_data);

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new());

    let request_body = serde_json::json!({
        "model": "gemma4:e4b",
        "stream": false,
        "options": {
            "temperature": 0.4,
            "num_predict": 2048
        },
        "messages": [
            { "role": "system", "content": system_prompt },
            { "role": "user", "content": user_prompt }
        ]
    });

    match client
        .post("http://localhost:11434/api/chat")
        .json(&request_body)
        .send()
        .await
    {
        Ok(res) if res.status().is_success() => {
            if let Ok(json) = res.json::<serde_json::Value>().await {
                if let Some(content) = json.pointer("/message/content").and_then(|v| v.as_str()) {
                    let cleaned = strip_thinking_tags(content);
                    let trimmed = cleaned.trim();
                    if !trimmed.is_empty() {
                        return trimmed.to_string();
                    }
                }
            }
        }
        Ok(res) => {
            eprintln!("[Scheduler] Ollama HTTP status {} al generar mensaje dinámico.", res.status());
        }
        Err(e) => {
            eprintln!("[Scheduler] Fallo de conexión con Ollama ({}), utilizando mensaje estructurado base.", e);
        }
    }

    // Mensaje de respaldo limpio si el LLM no está disponible
    format!("🔔 *Recordatorio de Enigma*\n\n{}", event_data)
}

/// Coincidencia de patrones de días de la semana para bloques de horarios
fn is_block_for_today(pattern: &str, weekday: Weekday) -> bool {
    let lower = pattern.to_lowercase();
    if lower.contains("todos") || lower.contains("diario") || lower.contains("cada día") || lower.contains("diarios") {
        return true;
    }

    match weekday {
        Weekday::Mon => lower.contains("lunes") || lower.contains("lunes a viernes") || lower.contains("laboral"),
        Weekday::Tue => lower.contains("martes") || lower.contains("lunes a viernes") || lower.contains("laboral"),
        Weekday::Wed => lower.contains("miércoles") || lower.contains("miercoles") || lower.contains("lunes a viernes") || lower.contains("laboral"),
        Weekday::Thu => lower.contains("jueves") || lower.contains("lunes a viernes") || lower.contains("laboral"),
        Weekday::Fri => lower.contains("viernes") || lower.contains("lunes a viernes") || lower.contains("laboral"),
        Weekday::Sat => lower.contains("sábado") || lower.contains("sabado") || lower.contains("fin de semana"),
        Weekday::Sun => lower.contains("domingo") || lower.contains("fin de semana"),
    }
}

/// Comprueba si la hora actual ("HH:MM") se encuentra en el intervalo [start, end)
fn is_time_in_range(current: &str, start: &str, end: &str) -> bool {
    current >= start && current < end
}

/// Evalúa bloques de rutinas (`schedules`) en SQLite y dispara alertas dinámicas por Telegram
async fn check_schedule_blocks(app_handle: &AppHandle, now: &chrono::DateTime<Local>) {
    let current_time_str = now.format("%H:%M").to_string();
    let weekday = now.weekday();

    let schedules = match crate::db::db_get_schedules() {
        Ok(s) => s,
        Err(e) => {
            eprintln!("[Scheduler] Error leyendo tabla schedules de SQLite: {}", e);
            return;
        }
    };

    let active_block = schedules.into_iter().find(|block| {
        is_block_for_today(&block.day_of_week, weekday)
            && is_time_in_range(&current_time_str, &block.start_time, &block.end_time)
    });

    let prev_id = LAST_ACTIVE_BLOCK_ID.load(Ordering::Relaxed);

    match active_block {
        Some(block) => {
            if prev_id != block.id {
                LAST_ACTIVE_BLOCK_ID.store(block.id, Ordering::Relaxed);

                let event_data = format!(
                    "Título: {}, Horario: {} - {}, Tipo: Rutina / Bloque de Enfoque. Acaba de comenzar.",
                    block.block_name, block.start_time, block.end_time
                );

                eprintln!("[Scheduler] Nuevo bloque horario detectado: '{}' ({} - {})", block.block_name, block.start_time, block.end_time);

                // Generación de mensaje bonito vía gemma4:e4b
                let alert_msg = generate_dynamic_alert_message(&event_data).await;

                // 1. Enviar notificación proactiva a Telegram con teloxide
                if let Err(e) = send_telegram_alert_direct(&alert_msg).await {
                    eprintln!("[Scheduler] Fallo enviando alerta a Telegram: {}", e);
                }

                // 2. Notificación local al escritorio
                let _ = notify_rust::Notification::new()
                    .appname("Enigma")
                    .summary("Enigma: Bloque Horario")
                    .body(&alert_msg)
                    .icon("appointment-soon")
                    .timeout(notify_rust::Timeout::Milliseconds(8000))
                    .show();

                // 3. Sincronizar con historial de chat y UI de escritorio
                let _ = crate::memory::save_chat_message("assistant".to_string(), alert_msg.clone());
                let _ = app_handle.emit("enigma-token", alert_msg.clone());
                let _ = app_handle.emit("enigma-done", ());

                // 4. Sintetizar voz si está habilitada
                if crate::enigma::get_enigma_voice_enabled().unwrap_or(true) {
                    let spoken = format!("Santiago, acaba de comenzar tu bloque de {}.", block.block_name);
                    crate::enigma::speak_text_async(spoken);
                }
            }
        }
        None => {
            if prev_id > 0 {
                LAST_ACTIVE_BLOCK_ID.store(0, Ordering::Relaxed);
                let event_data = "Título: Fin de bloque horario, Tipo: Pausa / Descanso, Hora: Ahora. Has completado tu tiempo de trabajo programado.";
                eprintln!("[Scheduler] Fin de bloque horario detectado.");

                let alert_msg = generate_dynamic_alert_message(event_data).await;

                let _ = send_telegram_alert_direct(&alert_msg).await;
                let _ = notify_rust::Notification::new()
                    .appname("Enigma")
                    .summary("Enigma: Fin de Bloque")
                    .body(&alert_msg)
                    .icon("dialog-information")
                    .timeout(notify_rust::Timeout::Milliseconds(6000))
                    .show();

                let _ = crate::memory::save_chat_message("assistant".to_string(), alert_msg.clone());
                let _ = app_handle.emit("enigma-token", alert_msg.clone());
                let _ = app_handle.emit("enigma-done", ());
            }
        }
    }
}

/// Evalúa reuniones y eventos de Google Calendar para los próximos 15 minutos
async fn check_google_calendar_events(app_handle: &AppHandle, now: &chrono::DateTime<Local>) {
    let events = match crate::google_auth::fetch_google_calendar_events(5).await {
        Ok(ev) => ev,
        Err(_) => return,
    };

    let mut pending_alerts = Vec::new();
    {
        let mut guard = NOTIFIED_CALENDAR_EVENTS.lock().unwrap();
        let notified_set = guard.get_or_insert_with(HashSet::new);

        for event in events {
            if notified_set.contains(&event.id) {
                continue;
            }

            if let Ok(parsed_start) = chrono::DateTime::parse_from_rfc3339(&event.start) {
                let start_local = parsed_start.with_timezone(&Local);
                let diff_mins = (start_local - *now).num_minutes();

                if diff_mins >= -5 && diff_mins <= 15 {
                    notified_set.insert(event.id.clone());

                    let time_formatted = start_local.format("%H:%M").to_string();
                    let time_notice = if diff_mins > 0 {
                        format!("en {} minutos ({})", diff_mins, time_formatted)
                    } else if diff_mins == 0 {
                        format!("ahora mismo ({})", time_formatted)
                    } else {
                        format!("acaba de comenzar ({})", time_formatted)
                    };

                    let event_data = format!(
                        "Reunión Google Calendar: '{}', Hora: {}, Comienza: {}. Descripción: {}",
                        event.summary,
                        time_formatted,
                        time_notice,
                        event.description.as_deref().unwrap_or("Sin descripción adicional")
                    );

                    pending_alerts.push(event_data);
                }
            }
        }
    }

    for event_data in pending_alerts {
        eprintln!("[Scheduler] Evento de Google Calendar próximo alertado.");

        // Generar mensaje bonito mediante LLM gemma4:e4b
        let alert_msg = generate_dynamic_alert_message(&event_data).await;

        // 1. Enviar a Telegram
        let _ = send_telegram_alert_direct(&alert_msg).await;

        // 2. Notificación local al escritorio
        let _ = notify_rust::Notification::new()
            .appname("Enigma")
            .summary("Enigma: Google Calendar")
            .body(&alert_msg)
            .icon("appointment-soon")
            .timeout(notify_rust::Timeout::Milliseconds(8000))
            .show();

        // 3. Sincronizar UI y voz
        let _ = crate::memory::save_chat_message("assistant".to_string(), alert_msg.clone());
        let _ = app_handle.emit("enigma-token", alert_msg.clone());
        let _ = app_handle.emit("enigma-done", ());

        if crate::enigma::get_enigma_voice_enabled().unwrap_or(true) {
            crate::enigma::speak_text_async(alert_msg);
        }
    }
}

/// Evalúa eventos locales de la tabla SQLite `calendar_events` para enviarlos por Telegram
async fn check_sqlite_calendar_events(app_handle: &AppHandle, now: &chrono::DateTime<Local>) {
    let now_naive = now.naive_local();
    let today_str = now.format("%Y-%m-%d").to_string();

    let pending_events = {
        let db_path = crate::db::get_db_path();
        if let Ok(conn) = rusqlite::Connection::open(&db_path) {
            let stmt = conn.prepare(
                "SELECT id, title, event_date, event_time, notify_before_mins, notified, category_id 
                 FROM calendar_events 
                 WHERE notified = 0 AND event_date = ?1",
            );
            if let Ok(mut s) = stmt {
                let rows = s.query_map(rusqlite::params![today_str], |row| {
                    Ok(crate::db::CalendarEvent {
                        id: row.get(0)?,
                        title: row.get(1)?,
                        event_date: row.get(2)?,
                        event_time: row.get(3)?,
                        notify_before_mins: row.get(4)?,
                        notified: row.get(5)?,
                        category_id: row.get(6)?,
                    })
                });
                if let Ok(iter) = rows {
                    iter.filter_map(|r| r.ok()).collect::<Vec<_>>()
                } else {
                    Vec::new()
                }
            } else {
                Vec::new()
            }
        } else {
            Vec::new()
        }
    };

    for event in pending_events {
        let date = match NaiveDate::parse_from_str(&event.event_date, "%Y-%m-%d") {
            Ok(d) => d,
            Err(_) => continue,
        };
        let time = match NaiveTime::parse_from_str(&event.event_time, "%H:%M") {
            Ok(t) => t,
            Err(_) => continue,
        };
        let event_dt = NaiveDateTime::new(date, time);
        let notify_dt = event_dt - chrono::Duration::minutes(event.notify_before_mins as i64);

        if now_naive >= notify_dt && now_naive <= event_dt + chrono::Duration::minutes(30) {
            eprintln!("[Scheduler] Evento local de calendario detectado: #{} '{}' a las {}", event.id, event.title, event.event_time);

            let event_data = format!(
                "Evento de Calendario: '{}', Fecha: {}, Hora: {}. El evento está por comenzar.",
                event.title, event.event_date, event.event_time
            );

            // Generar mensaje bonito mediante gemma4:e4b
            let alert_msg = generate_dynamic_alert_message(&event_data).await;

            // 1. Enviar a Telegram
            let _ = send_telegram_alert_direct(&alert_msg).await;

            // 2. Notificación local complementaria
            let _ = notify_rust::Notification::new()
                .appname("Enigma")
                .summary("Enigma: Calendario")
                .body(&alert_msg)
                .icon("appointment-soon")
                .timeout(notify_rust::Timeout::Milliseconds(8000))
                .show();

            // 3. Sincronizar UI y voz
            let _ = crate::memory::save_chat_message("assistant".to_string(), alert_msg.clone());
            let _ = app_handle.emit("enigma-token", alert_msg.clone());
            let _ = app_handle.emit("enigma-done", ());

            if crate::enigma::get_enigma_voice_enabled().unwrap_or(true) {
                crate::enigma::speak_text_async(alert_msg);
            }

            // Marcar como notificado en SQLite
            let db_path = crate::db::get_db_path();
            if let Ok(conn) = rusqlite::Connection::open(&db_path) {
                let _ = conn.execute(
                    "UPDATE calendar_events SET notified = 1 WHERE id = ?1",
                    rusqlite::params![event.id],
                );
            }
        }
    }
}

/// Ejecuta un ciclo de verificación del planificador (bloques de rutina, Google Calendar y eventos locales)
pub async fn execute_scheduler_tick(app_handle: &AppHandle) {
    let now = Local::now();
    check_schedule_blocks(app_handle, &now).await;
    check_google_calendar_events(app_handle, &now).await;
    check_sqlite_calendar_events(app_handle, &now).await;
}

/// Inicia el bucle continuo del scheduler en segundo plano (evaluación cada 60 segundos)
pub fn start_scheduler(app_handle: AppHandle) {
    // Cargar variables de entorno desde .env prioritariamente
    let _ = dotenvy::dotenv();
    let _ = dotenvy::from_filename("src-tauri/.env");

    let chat_id_display = get_telegram_chat_id()
        .map(|id| id.to_string())
        .unwrap_or_else(|| "NO CONFIGURADO".to_string());

    eprintln!("[Scheduler] Iniciando daemon del planificador Enigma (intervalo: 60s). Chat ID activo: {}", chat_id_display);

    tauri::async_runtime::spawn(async move {
        // Periodo de gracia inicial de 15 segundos para dar tiempo a la inicialización de UI y DB
        tokio::time::sleep(Duration::from_secs(15)).await;

        let mut interval = tokio::time::interval(Duration::from_secs(60));
        loop {
            interval.tick().await;
            execute_scheduler_tick(&app_handle).await;
        }
    });
}

/// Comando Tauri para forzar una comprobación manual inmediata del scheduler
#[tauri::command]
pub async fn trigger_scheduler_check(app_handle: AppHandle) -> Result<String, String> {
    execute_scheduler_tick(&app_handle).await;
    let block_id = LAST_ACTIVE_BLOCK_ID.load(Ordering::Relaxed);
    let chat_id = get_telegram_chat_id().unwrap_or(0);
    Ok(format!("Chequeo de Scheduler completado. Último bloque activo ID: {}, Chat ID: {}", block_id, chat_id))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_time_range_matching() {
        assert!(is_time_in_range("09:30", "09:00", "11:30"));
        assert!(is_time_in_range("09:00", "09:00", "11:30"));
        assert!(!is_time_in_range("11:30", "09:00", "11:30"));
        assert!(!is_time_in_range("08:59", "09:00", "11:30"));
    }

    #[test]
    fn test_weekday_pattern() {
        assert!(is_block_for_today("Lunes a Viernes", Weekday::Wed));
        assert!(is_block_for_today("Lunes a Viernes", Weekday::Fri));
        assert!(!is_block_for_today("Lunes a Viernes", Weekday::Sun));
        assert!(is_block_for_today("Todos los días", Weekday::Sun));
    }

    #[test]
    fn test_strip_thinking_tags() {
        let raw = "<think>Analizando evento...</think>🔔 ¡Hola! Tienes una reunión ahora.";
        assert_eq!(strip_thinking_tags(raw), "🔔 ¡Hola! Tienes una reunión ahora.");
    }
}
