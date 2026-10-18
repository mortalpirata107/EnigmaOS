//! Google OAuth 2.0 Desktop Authentication & Token Management for Enigma
//!
//! Provides:
//! - Local TCP listener on `http://localhost:3456/callback` using `tiny_http`
//! - Automated browser authorization flow using `open`
//! - Code exchange & offline Refresh Token acquisition (Gmail + Calendar)
//! - SQLite persistence in `google_tokens` with automatic transparent token renewal

use std::time::Duration;
use chrono::Utc;
use rusqlite::params;
use serde::{Deserialize, Serialize};
use tiny_http::{Header, Response, Server};
use url::Url;

pub const OAUTH_REDIRECT_URI: &str = "http://localhost:3456/callback";
pub const OAUTH_AUTH_URL: &str = "https://accounts.google.com/o/oauth2/v2/auth";
pub const OAUTH_TOKEN_URL: &str = "https://oauth2.googleapis.com/token";

pub const SCOPE_GMAIL: &str = "https://www.googleapis.com/auth/gmail.modify";
pub const SCOPE_CALENDAR: &str = "https://www.googleapis.com/auth/calendar.readonly";

/// Google OAuth2 Token Exchange response payload
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GoogleTokenResponse {
    pub access_token: String,
    pub expires_in: i64,
    pub token_type: String,
    #[serde(default)]
    pub scope: Option<String>,
    #[serde(default)]
    pub refresh_token: Option<String>,
}

/// Token record stored in SQLite
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GoogleTokenRecord {
    pub id: String,
    pub access_token: String,
    pub refresh_token: Option<String>,
    pub expires_at: i64,
    pub token_type: String,
    pub scope: Option<String>,
    pub client_id: Option<String>,
    pub client_secret: Option<String>,
    pub updated_at: String,
}

/// Status of the Google connection returned to Tauri frontend
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GoogleAuthStatus {
    pub connected: bool,
    pub has_refresh_token: bool,
    pub expires_at: i64,
    pub is_expired: bool,
    pub scopes: Vec<String>,
}

/// Initializes the `google_tokens` table in SQLite
pub fn init_google_auth_table() -> Result<(), String> {
    let conn = crate::db::get_connection().map_err(|e| e.to_string())?;
    conn.execute(
        "CREATE TABLE IF NOT EXISTS google_tokens (
            id TEXT PRIMARY KEY,
            access_token TEXT NOT NULL,
            refresh_token TEXT,
            expires_at INTEGER NOT NULL,
            token_type TEXT NOT NULL DEFAULT 'Bearer',
            scope TEXT,
            client_id TEXT,
            client_secret TEXT,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );",
        [],
    )
    .map_err(|e| format!("Error creando tabla google_tokens: {}", e))?;
    Ok(())
}

/// Generates the Google OAuth 2.0 authorization URL
pub fn build_authorization_url(client_id: &str) -> String {
    let combined_scopes = format!("{} {}", SCOPE_GMAIL, SCOPE_CALENDAR);

    let mut url = Url::parse(OAUTH_AUTH_URL).unwrap();
    url.query_pairs_mut()
        .append_pair("client_id", client_id)
        .append_pair("redirect_uri", OAUTH_REDIRECT_URI)
        .append_pair("response_type", "code")
        .append_pair("scope", &combined_scopes)
        .append_pair("access_type", "offline")
        .append_pair("prompt", "consent");

    url.to_string()
}

/// Listens for a single authorization callback on http://localhost:3456/callback
/// Releases the port immediately after receiving the response.
fn listen_for_auth_code(timeout_secs: u64) -> Result<String, String> {
    let server = Server::http("127.0.0.1:3456")
        .map_err(|e| format!("No se pudo abrir el listener local en el puerto 3456: {}", e))?;

    eprintln!("[GoogleAuth] Esperando redirección de Google en {} (timeout: {}s)...", OAUTH_REDIRECT_URI, timeout_secs);

    let start = std::time::Instant::now();
    let timeout = Duration::from_secs(timeout_secs);

    loop {
        if start.elapsed() > timeout {
            return Err("Tiempo de espera agotado (timeout) para la autorización de Google.".to_string());
        }

        // Poll con pequeños bloques para chequear el timeout
        match server.recv_timeout(Duration::from_millis(500)) {
            Ok(Some(request)) => {
                let raw_url = request.url().to_string();
                let full_url = format!("http://localhost:3456{}", raw_url);

                if let Ok(parsed) = Url::parse(&full_url) {
                    if parsed.path() == "/callback" {
                        let mut auth_code = None;
                        let mut error_param = None;

                        for (k, v) in parsed.query_pairs() {
                            if k == "code" {
                                auth_code = Some(v.to_string());
                            } else if k == "error" {
                                error_param = Some(v.to_string());
                            }
                        }

                        // Responder al navegador del usuario
                        let (html_body, status_code) = if auth_code.is_some() {
                            (
                                r#"<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <title>Enigma - Autenticación Exitosa</title>
  <style>
    body { background: #090a0f; color: #f3f4f6; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
    .card { background: rgba(255,255,255,0.03); border: 1px solid rgba(16,185,129,0.3); border-radius: 24px; padding: 40px; text-align: center; box-shadow: 0 20px 50px rgba(0,0,0,0.8); max-width: 440px; }
    .icon { width: 56px; height: 56px; background: rgba(16,185,129,0.15); border: 1px solid rgba(16,185,129,0.4); border-radius: 18px; display: inline-flex; align-items: center; justify-content: center; font-size: 26px; color: #34d399; margin-bottom: 20px; }
    h2 { margin: 0 0 10px; font-size: 20px; font-weight: 700; color: #ffffff; }
    p { margin: 0; color: rgba(255,255,255,0.6); font-size: 14px; line-height: 1.5; }
    .badge { display: inline-block; margin-top: 20px; padding: 6px 14px; background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1); border-radius: 12px; font-size: 12px; font-family: monospace; color: #a7f3d0; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">✓</div>
    <h2>Autenticación de Enigma completada</h2>
    <p>La vinculación con Google Workspace (Gmail y Calendar) se ha completado con éxito.</p>
    <div class="badge">Puedes cerrar esta pestaña y volver a la app</div>
  </div>
</body>
</html>"#,
                                200,
                            )
                        } else {
                            (
                                r#"<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <title>Enigma - Error de Autenticación</title>
  <style>
    body { background: #090a0f; color: #f3f4f6; font-family: system-ui, sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
    .card { background: rgba(255,255,255,0.03); border: 1px solid rgba(239,68,68,0.3); border-radius: 24px; padding: 40px; text-align: center; max-width: 440px; }
    h2 { color: #f87171; margin-top: 0; }
    p { color: rgba(255,255,255,0.6); font-size: 14px; }
  </style>
</head>
<body>
  <div class="card">
    <h2>Error de Autenticación</h2>
    <p>No se pudo obtener la autorización de Google. Puedes cerrar esta pestaña.</p>
  </div>
</body>
</html>"#,
                                400,
                            )
                        };

                        let response = Response::from_string(html_body)
                            .with_status_code(status_code)
                            .with_header(
                                Header::from_bytes(&b"Content-Type"[..], &b"text/html; charset=utf-8"[..]).unwrap(),
                            );
                        let _ = request.respond(response);

                        // Puerto 3456 liberado al retornar (el servidor se destruye fuera del scope)
                        if let Some(code) = auth_code {
                            return Ok(code);
                        } else if let Some(err) = error_param {
                            return Err(format!("Google denegó el acceso: {}", err));
                        } else {
                            return Err("Callback recibido sin parámetro 'code'".to_string());
                        }
                    } else {
                        // Respuesta para rutas distintas a /callback
                        let _ = request.respond(Response::from_string("Not Found").with_status_code(404));
                    }
                }
            }
            Ok(None) => {}
            Err(e) => {
                eprintln!("[GoogleAuth] Advertencia en recv_timeout: {}", e);
            }
        }
    }
}

/// Canjea el código de autorización por los tokens de Google OAuth
pub async fn exchange_code_for_tokens(
    code: &str,
    client_id: &str,
    client_secret: &str,
) -> Result<GoogleTokenResponse, String> {
    let client = reqwest::Client::new();

    let params = [
        ("code", code),
        ("client_id", client_id),
        ("client_secret", client_secret),
        ("redirect_uri", OAUTH_REDIRECT_URI),
        ("grant_type", "authorization_code"),
    ];

    let res = client
        .post(OAUTH_TOKEN_URL)
        .form(&params)
        .send()
        .await
        .map_err(|e| format!("Error conectando con Google Token endpoint: {}", e))?;

    if !res.status().is_success() {
        let err_text = res.text().await.unwrap_or_default();
        return Err(format!("Error en el canje de tokens de Google: {}", err_text));
    }

    let token_data: GoogleTokenResponse = res
        .json()
        .await
        .map_err(|e| format!("Error deserializando tokens de Google: {}", e))?;

    Ok(token_data)
}

/// Renueva el `access_token` usando el `refresh_token` de forma 100% transparente
pub async fn refresh_access_token(
    client_id: &str,
    client_secret: &str,
    refresh_token: &str,
) -> Result<GoogleTokenResponse, String> {
    let client = reqwest::Client::new();

    let params = [
        ("client_id", client_id),
        ("client_secret", client_secret),
        ("refresh_token", refresh_token),
        ("grant_type", "refresh_token"),
    ];

    let res = client
        .post(OAUTH_TOKEN_URL)
        .form(&params)
        .send()
        .await
        .map_err(|e| format!("Error conectando con Google Token endpoint (refresh): {}", e))?;

    if !res.status().is_success() {
        let err_text = res.text().await.unwrap_or_default();
        return Err(format!("Error renovando el token de Google: {}", err_text));
    }

    let mut token_data: GoogleTokenResponse = res
        .json()
        .await
        .map_err(|e| format!("Error deserializando respuesta de renovación: {}", e))?;

    // Si Google no devuelve un nuevo refresh_token en la respuesta, conservamos el original
    if token_data.refresh_token.is_none() {
        token_data.refresh_token = Some(refresh_token.to_string());
    }

    Ok(token_data)
}

/// Guarda o actualiza los tokens en SQLite (`google_tokens`)
pub fn save_google_tokens(
    tokens: &GoogleTokenResponse,
    client_id: Option<&str>,
    client_secret: Option<&str>,
) -> Result<(), String> {
    init_google_auth_table()?;
    let conn = crate::db::get_connection().map_err(|e| e.to_string())?;

    let now_ts = Utc::now().timestamp();
    let expires_at = now_ts + tokens.expires_in;

    conn.execute(
        "INSERT INTO google_tokens (
            id, access_token, refresh_token, expires_at, token_type, scope, client_id, client_secret, updated_at
        ) VALUES (
            'primary', ?1, ?2, ?3, ?4, ?5, ?6, ?7, CURRENT_TIMESTAMP
        )
        ON CONFLICT(id) DO UPDATE SET
            access_token = excluded.access_token,
            refresh_token = COALESCE(excluded.refresh_token, google_tokens.refresh_token),
            expires_at = excluded.expires_at,
            token_type = excluded.token_type,
            scope = COALESCE(excluded.scope, google_tokens.scope),
            client_id = COALESCE(excluded.client_id, google_tokens.client_id),
            client_secret = COALESCE(excluded.client_secret, google_tokens.client_secret),
            updated_at = CURRENT_TIMESTAMP;",
        params![
            &tokens.access_token,
            &tokens.refresh_token,
            expires_at,
            &tokens.token_type,
            &tokens.scope,
            client_id,
            client_secret
        ],
    )
    .map_err(|e| format!("Error guardando tokens de Google en SQLite: {}", e))?;

    eprintln!("[GoogleAuth] Tokens de Google guardados exitosamente. Expiran en {}s.", tokens.expires_in);
    Ok(())
}

/// Obtiene el registro completo de tokens de SQLite
pub fn get_stored_token_record() -> Result<Option<GoogleTokenRecord>, String> {
    init_google_auth_table()?;
    let conn = crate::db::get_connection().map_err(|e| e.to_string())?;

    let mut stmt = conn
        .prepare(
            "SELECT id, access_token, refresh_token, expires_at, token_type, scope, client_id, client_secret, updated_at 
             FROM google_tokens WHERE id = 'primary' LIMIT 1",
        )
        .map_err(|e| e.to_string())?;

    let mut rows = stmt.query([]).map_err(|e| e.to_string())?;

    if let Some(row) = rows.next().map_err(|e| e.to_string())? {
        let record = GoogleTokenRecord {
            id: row.get(0).unwrap_or_default(),
            access_token: row.get(1).unwrap_or_default(),
            refresh_token: row.get(2).ok(),
            expires_at: row.get(3).unwrap_or(0),
            token_type: row.get(4).unwrap_or_else(|_| "Bearer".to_string()),
            scope: row.get(5).ok(),
            client_id: row.get(6).ok(),
            client_secret: row.get(7).ok(),
            updated_at: row.get(8).unwrap_or_default(),
        };
        Ok(Some(record))
    } else {
        Ok(None)
    }
}

/// Obtiene un `access_token` válido garantizado.
/// Si ha caducado (o le quedan menos de 60 segundos), lo renueva usando el `refresh_token`
/// de forma totalmente transparente sin intervención del usuario.
pub async fn get_valid_access_token(
    client_id_override: Option<&str>,
    client_secret_override: Option<&str>,
) -> Result<String, String> {
    let record = match get_stored_token_record()? {
        Some(r) => r,
        None => return Err("No hay cuenta de Google vinculada. Inicia sesión primero.".to_string()),
    };

    let now_ts = Utc::now().timestamp();
    // Margen de seguridad: si expira en menos de 60 segundos, renovar
    let is_expired = now_ts >= (record.expires_at - 60);

    if !is_expired {
        return Ok(record.access_token);
    }

    // Está caducado, renovar usando el refresh_token
    eprintln!("[GoogleAuth] Access token caducado o próximo a expirar. Renovando con refresh_token...");

    let refresh_token = record
        .refresh_token
        .as_deref()
        .ok_or_else(|| "El token ha caducado y no existe refresh_token guardado. Se requiere re-autenticar.".to_string())?;

    let client_id = client_id_override
        .or(record.client_id.as_deref())
        .ok_or_else(|| "No se encontró el Client ID para renovar el token.".to_string())?;

    let client_secret = client_secret_override
        .or(record.client_secret.as_deref())
        .ok_or_else(|| "No se encontró el Client Secret para renovar el token.".to_string())?;

    let renewed = refresh_access_token(client_id, client_secret, refresh_token).await?;
    save_google_tokens(&renewed, Some(client_id), Some(client_secret))?;

    Ok(renewed.access_token)
}

// ============================================================================
// TAURI COMMANDS (INTEGRACIÓN DIRECTA CON EL FRONTEND DE ENIGMA)
// ============================================================================

/// Inicia el flujo de autenticación completo:
/// 1. Genera URL con acceso offline y prompt=consent
/// 2. Abre el navegador del usuario automáticamente
/// 3. Levanta el listener temporal en el puerto 3456
/// 4. Atrapa el código, cierra el puerto y canjea los tokens
/// 5. Guarda los tokens en SQLite
#[tauri::command]
pub async fn start_google_auth(client_id: String, client_secret: String) -> Result<GoogleAuthStatus, String> {
    let auth_url = build_authorization_url(&client_id);

    // Abrir automáticamente el navegador predeterminado del sistema operativo
    eprintln!("[GoogleAuth] Abriendo navegador para autorización de Google...");
    open::that(&auth_url).map_err(|e| format!("Error abriendo el navegador del sistema: {}", e))?;

    // Escuchar el callback en hilo secundario para no bloquear el runtime asíncrono
    let (tx, rx) = tokio::sync::oneshot::channel::<Result<String, String>>();
    tokio::task::spawn_blocking(move || {
        let res = listen_for_auth_code(120);
        let _ = tx.send(res);
    });

    let code = rx
        .await
        .map_err(|_| "El listener local fue interrumpido antes de recibir el código.".to_string())??;

    // Canje del código por tokens
    let tokens = exchange_code_for_tokens(&code, &client_id, &client_secret).await?;

    // Persistencia en SQLite
    save_google_tokens(&tokens, Some(&client_id), Some(&client_secret))?;

    get_google_auth_status()
}

/// Consulta el estado actual de la autenticación de Google en SQLite
#[tauri::command]
pub fn get_google_auth_status() -> Result<GoogleAuthStatus, String> {
    match get_stored_token_record()? {
        Some(record) => {
            let now_ts = Utc::now().timestamp();
            let is_expired = now_ts >= (record.expires_at - 60);
            let scopes = record
                .scope
                .unwrap_or_default()
                .split_whitespace()
                .map(|s| s.to_string())
                .collect();

            Ok(GoogleAuthStatus {
                connected: true,
                has_refresh_token: record.refresh_token.is_some(),
                expires_at: record.expires_at,
                is_expired,
                scopes,
            })
        }
        None => Ok(GoogleAuthStatus {
            connected: false,
            has_refresh_token: false,
            expires_at: 0,
            is_expired: true,
            scopes: Vec::new(),
        }),
    }
}

/// Desconecta la cuenta de Google eliminando los tokens de SQLite
#[tauri::command]
pub fn disconnect_google_auth() -> Result<(), String> {
    init_google_auth_table()?;
    let conn = crate::db::get_connection().map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM google_tokens WHERE id = 'primary'", [])
        .map_err(|e| format!("Error eliminando tokens de Google: {}", e))?;
    eprintln!("[GoogleAuth] Cuenta de Google desconectada de Enigma.");
    Ok(())
}

/// Devuelve un access token válido para realizar llamadas a Gmail o Google Calendar
#[tauri::command]
pub async fn get_google_access_token() -> Result<String, String> {
    get_valid_access_token(None, None).await
}

/// Resumen estructurado de un correo electrónico de Gmail
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GmailMessageSummary {
    pub id: String,
    pub thread_id: String,
    pub snippet: String,
    pub from: String,
    pub subject: String,
    pub date: String,
}

/// Resumen estructurado de un evento de Google Calendar
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GoogleCalendarEventSummary {
    pub id: String,
    pub summary: String,
    pub start: String,
    pub end: String,
    pub description: Option<String>,
}

/// Credenciales guardadas de Google
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SavedGoogleCredentials {
    pub client_id: Option<String>,
    pub client_secret: Option<String>,
}

/// Obtiene las credenciales guardadas de Google (Client ID y Client Secret)
pub fn get_saved_credentials() -> Result<SavedGoogleCredentials, String> {
    init_google_auth_table()?;
    let conn = crate::db::get_connection().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare("SELECT client_id, client_secret FROM google_tokens WHERE id = 'primary' LIMIT 1")
        .map_err(|e| e.to_string())?;
    let mut rows = stmt.query([]).map_err(|e| e.to_string())?;
    if let Some(row) = rows.next().map_err(|e| e.to_string())? {
        Ok(SavedGoogleCredentials {
            client_id: row.get(0).ok(),
            client_secret: row.get(1).ok(),
        })
    } else {
        Ok(SavedGoogleCredentials {
            client_id: None,
            client_secret: None,
        })
    }
}

/// Consulta los últimos correos electrónicos de Gmail usando la API REST oficial de Google
pub async fn fetch_recent_emails(max_results: u32) -> Result<Vec<GmailMessageSummary>, String> {
    let access_token = get_valid_access_token(None, None).await?;
    let client = reqwest::Client::new();
    let limit = max_results.clamp(1, 20);

    let list_url = format!(
        "https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults={}",
        limit
    );

    let res = client
        .get(&list_url)
        .bearer_auth(&access_token)
        .send()
        .await
        .map_err(|e| format!("Error conectando con Gmail API: {}", e))?;

    if !res.status().is_success() {
        let status = res.status();
        let err_body = res.text().await.unwrap_or_default();
        return Err(format!("Gmail API devolvió error {}: {}", status, err_body));
    }

    let list_json: serde_json::Value = res
        .json()
        .await
        .map_err(|e| format!("Error deserializando lista de mensajes de Gmail: {}", e))?;

    let messages = match list_json.get("messages").and_then(|m| m.as_array()) {
        Some(arr) => arr,
        None => return Ok(Vec::new()),
    };

    let mut summaries = Vec::new();
    for msg_ref in messages.iter().take(limit as usize) {
        if let Some(msg_id) = msg_ref.get("id").and_then(|id| id.as_str()) {
            let detail_url = format!(
                "https://gmail.googleapis.com/gmail/v1/users/me/messages/{}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date",
                msg_id
            );

            if let Ok(detail_res) = client.get(&detail_url).bearer_auth(&access_token).send().await {
                if let Ok(val) = detail_res.json::<serde_json::Value>().await {
                    let snippet = val.get("snippet").and_then(|s| s.as_str()).unwrap_or_default().to_string();
                    let thread_id = val.get("threadId").and_then(|s| s.as_str()).unwrap_or_default().to_string();

                    let mut from = "Desconocido".to_string();
                    let mut subject = "(Sin asunto)".to_string();
                    let mut date = "".to_string();

                    if let Some(headers) = val.get("payload").and_then(|p| p.get("headers")).and_then(|h| h.as_array()) {
                        for h in headers {
                            let name = h.get("name").and_then(|n| n.as_str()).unwrap_or_default();
                            let value = h.get("value").and_then(|v| v.as_str()).unwrap_or_default();
                            if name.eq_ignore_ascii_case("From") {
                                from = value.to_string();
                            } else if name.eq_ignore_ascii_case("Subject") {
                                subject = value.to_string();
                            } else if name.eq_ignore_ascii_case("Date") {
                                date = value.to_string();
                            }
                        }
                    }

                    summaries.push(GmailMessageSummary {
                        id: msg_id.to_string(),
                        thread_id,
                        snippet,
                        from,
                        subject,
                        date,
                    });
                }
            }
        }
    }

    Ok(summaries)
}

/// Consulta eventos próximos de Google Calendar usando la API oficial
pub async fn fetch_google_calendar_events(max_results: u32) -> Result<Vec<GoogleCalendarEventSummary>, String> {
    let access_token = get_valid_access_token(None, None).await?;
    let client = reqwest::Client::new();
    let limit = max_results.clamp(1, 20);

    let mut cal_url = Url::parse("https://www.googleapis.com/calendar/v3/calendars/primary/events").unwrap();
    cal_url.query_pairs_mut()
        .append_pair("timeMin", &Utc::now().to_rfc3339())
        .append_pair("maxResults", &limit.to_string())
        .append_pair("singleEvents", "true")
        .append_pair("orderBy", "startTime");

    let res = client
        .get(cal_url.as_str())
        .bearer_auth(&access_token)
        .send()
        .await
        .map_err(|e| format!("Error conectando con Google Calendar API: {}", e))?;

    if !res.status().is_success() {
        let status = res.status();
        let err_body = res.text().await.unwrap_or_default();
        return Err(format!("Google Calendar API devolvió error {}: {}", status, err_body));
    }

    let val: serde_json::Value = res
        .json()
        .await
        .map_err(|e| format!("Error deserializando eventos de Google Calendar: {}", e))?;

    let mut summaries = Vec::new();
    if let Some(items) = val.get("items").and_then(|i| i.as_array()) {
        for item in items {
            let id = item.get("id").and_then(|i| i.as_str()).unwrap_or_default().to_string();
            let summary = item.get("summary").and_then(|s| s.as_str()).unwrap_or_default().to_string();
            let description = item.get("description").and_then(|d| d.as_str()).map(|s| s.to_string());

            let start = item.get("start")
                .and_then(|s| s.get("dateTime").or_else(|| s.get("date")))
                .and_then(|d| d.as_str())
                .unwrap_or_default()
                .to_string();

            let end = item.get("end")
                .and_then(|e| e.get("dateTime").or_else(|| e.get("date")))
                .and_then(|d| d.as_str())
                .unwrap_or_default()
                .to_string();

            summaries.push(GoogleCalendarEventSummary {
                id,
                summary,
                start,
                end,
                description,
            });
        }
    }

    Ok(summaries)
}

#[tauri::command]
pub async fn get_gmail_emails(max_results: Option<u32>) -> Result<Vec<GmailMessageSummary>, String> {
    fetch_recent_emails(max_results.unwrap_or(5)).await
}

#[tauri::command]
pub async fn get_google_calendar_events(max_results: Option<u32>) -> Result<Vec<GoogleCalendarEventSummary>, String> {
    fetch_google_calendar_events(max_results.unwrap_or(5)).await
}

#[tauri::command]
pub fn get_saved_google_credentials() -> Result<SavedGoogleCredentials, String> {
    get_saved_credentials()
}
