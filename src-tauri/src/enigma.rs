use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::Mutex;

use futures_util::StreamExt;
use reqwest::Client;
use serde_json::Value;
use tauri::{AppHandle, Emitter};

static VOICE_ENABLED: AtomicBool = AtomicBool::new(true);
static SPEECH_TX: Mutex<Option<Sender<SpeechCommand>>> = Mutex::new(None);
static CURRENT_PLAYER_PID: Mutex<Option<u32>> = Mutex::new(None);
static SPEECH_APP_HANDLE: Mutex<Option<AppHandle>> = Mutex::new(None);

pub fn set_speech_app_handle(handle: AppHandle) {
    if let Ok(mut lock) = SPEECH_APP_HANDLE.lock() {
        *lock = Some(handle);
    }
}

pub fn get_app_handle() -> Option<AppHandle> {
    SPEECH_APP_HANDLE.lock().ok().and_then(|lock| lock.clone())
}

enum SpeechCommand {
    Speak(String),
    Clear,
}

/// Finds the Piper voice model file (Dave Spanish medium)
fn find_piper_model() -> Option<PathBuf> {
    let candidate_paths = [
        "models/piper/es_ES-dave-medium.onnx",
        "src-tauri/models/piper/es_ES-dave-medium.onnx",
        "/usr/share/piper/models/es_ES-dave-medium.onnx",
        "/usr/local/share/piper/models/es_ES-dave-medium.onnx",
    ];

    for candidate in candidate_paths {
        let p = Path::new(candidate);
        if p.is_file() {
            return Some(p.to_path_buf());
        }
    }

    if let Ok(home) = std::env::var("HOME") {
        let home_path = PathBuf::from(home);
        let user_candidates = [
            home_path.join(".local/share/piper/models/es_ES-dave-medium.onnx"),
            home_path.join(".local/share/piper/models/es_ES-davefx-medium.onnx"),
            home_path.join(".local/share/enigma/models/es_ES-dave-medium.onnx"),
        ];
        for user_path in user_candidates {
            if user_path.is_file() {
                return Some(user_path);
            }
        }
    }

    None
}

/// Finds the Piper binary executable
fn find_piper_binary() -> String {
    if Command::new("piper").arg("-h").output().is_ok() {
        return "piper".to_string();
    }

    if let Ok(home) = std::env::var("HOME") {
        let home_path = PathBuf::from(home);
        let candidate_paths = [
            home_path.join(".local/bin/piper"),
            home_path.join(".cargo/bin/piper"),
            home_path.join(".local/share/piper/piper"),
        ];

        for cmd in &candidate_paths {
            if cmd.is_file() && Command::new(cmd).arg("-h").output().is_ok() {
                return cmd.to_string_lossy().to_string();
            }
        }
    }

    "piper".to_string()
}

/// Detects if spd-say is installed and available
fn is_spd_say_available() -> bool {
    Command::new("spd-say").arg("-v").output().is_ok()
}

/// Detects the available audio player command (pw-play, paplay, or aplay)
fn find_audio_player() -> (&'static str, Vec<&'static str>) {
    if Command::new("pw-play").arg("--version").output().is_ok() {
        ("pw-play", vec![])
    } else if Command::new("paplay").arg("--version").output().is_ok() {
        ("paplay", vec![])
    } else {
        ("aplay", vec!["-q"])
    }
}

/// Initializes the dedicated speech worker thread for sequential, non-overlapping playback
pub fn init_speech_worker() {
    let mut tx_lock = SPEECH_TX.lock().unwrap();
    if tx_lock.is_some() {
        return;
    }

    let (tx, rx) = channel::<SpeechCommand>();
    *tx_lock = Some(tx);

    std::thread::spawn(move || {
        let piper_bin = find_piper_binary();
        let model_path = find_piper_model();

        eprintln!(
            "[Speech Worker] Dedicated speech worker started. Piper model: {:?}, spd-say: {}",
            model_path,
            is_spd_say_available()
        );

        while let Ok(cmd) = rx.recv() {
            match cmd {
                SpeechCommand::Clear => {
                    kill_current_player();
                    crate::connectivities::auto_duck_music(false);
                    if let Ok(guard) = SPEECH_APP_HANDLE.lock() {
                        if let Some(ref handle) = *guard {
                            let _ = handle.emit("enigma-speaking-end", serde_json::json!({}));
                        }
                    }
                }
                SpeechCommand::Speak(sentence) => {
                    if !VOICE_ENABLED.load(Ordering::SeqCst) {
                        continue;
                    }
                    let trimmed = sentence.trim();
                    if trimmed.is_empty() {
                        continue;
                    }

                    // Check if a Clear command was queued while waiting
                    let mut cancelled = false;
                    while let Ok(pending) = rx.try_recv() {
                        if let SpeechCommand::Clear = pending {
                            cancelled = true;
                            break;
                        }
                    }
                    if cancelled {
                        continue;
                    }

                    // 1. Anti-solapamiento estricto: matar cualquier locución anterior
                    kill_current_player();

                    // 2. Notificar inicio visual a la Topbar Liquid Glass
                    if let Ok(guard) = SPEECH_APP_HANDLE.lock() {
                        if let Some(ref handle) = *guard {
                            let _ = handle.emit("enigma-speaking-start", serde_json::json!({
                                "text": trimmed
                            }));
                        }
                    }

                    // 3. Auto-ducking del volumen de medios de fondo
                    crate::connectivities::auto_duck_music(true);

                    // 4. Ejecución del motor TTS
                    if is_spd_say_available() {
                        eprintln!("[Speech] Ejecutando spd-say -C -l es: '{}'", trimmed);
                        if let Ok(mut child) = Command::new("spd-say")
                            .args(["-C", "-l", "es", trimmed])
                            .spawn()
                        {
                            if let Ok(mut pid_lock) = CURRENT_PLAYER_PID.lock() {
                                *pid_lock = Some(child.id());
                            }
                            let _ = child.wait();
                            if let Ok(mut pid_lock) = CURRENT_PLAYER_PID.lock() {
                                *pid_lock = None;
                            }
                        }
                    } else if let Some(ref m_path) = model_path {
                        let ts = std::time::SystemTime::now()
                            .duration_since(std::time::UNIX_EPOCH)
                            .unwrap_or_default()
                            .as_millis();
                        let wav_path = format!("/tmp/enigma_speech_{}.wav", ts);

                        eprintln!(
                            "[Piper TTS] Generando síntesis neuronal ({} caracteres)...",
                            trimmed.len()
                        );

                        let mut piper_child = match Command::new(&piper_bin)
                            .args([
                                "--model",
                                m_path.to_str().unwrap(),
                                "--output_file",
                                &wav_path,
                            ])
                            .stdin(Stdio::piped())
                            .stdout(Stdio::null())
                            .stderr(Stdio::null())
                            .spawn()
                        {
                            Ok(c) => c,
                            Err(e) => {
                                eprintln!("[Piper TTS] Error al ejecutar piper: {}", e);
                                crate::connectivities::auto_duck_music(false);
                                if let Ok(guard) = SPEECH_APP_HANDLE.lock() {
                                    if let Some(ref handle) = *guard {
                                        let _ = handle.emit("enigma-speaking-end", serde_json::json!({}));
                                    }
                                }
                                continue;
                            }
                        };

                        if let Some(mut stdin) = piper_child.stdin.take() {
                            let text_bytes = trimmed.as_bytes().to_vec();
                            let _ = stdin.write_all(&text_bytes);
                        }

                        let status = piper_child.wait();
                        if !status.map(|s| s.success()).unwrap_or(false) || !Path::new(&wav_path).exists() {
                            eprintln!("[Piper TTS] Síntesis de voz falló o archivo no creado.");
                            crate::connectivities::auto_duck_music(false);
                            if let Ok(guard) = SPEECH_APP_HANDLE.lock() {
                                if let Some(ref handle) = *guard {
                                    let _ = handle.emit("enigma-speaking-end", serde_json::json!({}));
                                }
                            }
                            continue;
                        }

                        // Emitir enigma-play-audio para visualización FFT en frontend si aplica
                        if let Ok(guard) = SPEECH_APP_HANDLE.lock() {
                            if let Some(ref handle) = *guard {
                                let _ = handle.emit("enigma-play-audio", serde_json::json!({
                                    "filePath": wav_path,
                                    "text": trimmed
                                }));
                            }
                        }

                        // Reproducción directa e infalible desde Rust con pw-play / paplay
                        let (player_cmd, player_args) = find_audio_player();
                        let mut args = player_args.clone();
                        args.push(&wav_path);

                        if let Ok(mut player_child) = Command::new(player_cmd).args(&args).spawn() {
                            if let Ok(mut pid_lock) = CURRENT_PLAYER_PID.lock() {
                                *pid_lock = Some(player_child.id());
                            }
                            let _ = player_child.wait();
                            if let Ok(mut pid_lock) = CURRENT_PLAYER_PID.lock() {
                                *pid_lock = None;
                            }
                        }

                        let _ = std::fs::remove_file(&wav_path);
                    } else {
                        eprintln!("[TTS] Ni spd-say ni el modelo de Piper están disponibles.");
                    }

                    // 5. Restaurar volumen de música y notificar fin de locución
                    crate::connectivities::auto_duck_music(false);
                    if let Ok(guard) = SPEECH_APP_HANDLE.lock() {
                        if let Some(ref handle) = *guard {
                            let _ = handle.emit("enigma-speaking-end", serde_json::json!({}));
                        }
                    }
                }
            }
        }
    });
}

fn kill_current_player() {
    if let Ok(mut pid_lock) = CURRENT_PLAYER_PID.lock() {
        if let Some(pid) = pid_lock.take() {
            let _ = Command::new("kill").arg("-9").arg(pid.to_string()).status();
        }
    }
}

pub fn stop_speaking() {
    init_speech_worker();
    if let Ok(lock) = SPEECH_TX.lock() {
        if let Some(tx) = lock.as_ref() {
            let _ = tx.send(SpeechCommand::Clear);
        }
    }
    kill_current_player();
}

pub fn clean_markdown_for_speech(raw: &str) -> String {
    let mut text = raw.to_string();

    // 1. Eliminar bloques <think>...</think> de DeepSeek
    while let Some(start) = text.find("<think>") {
        if let Some(end) = text[start..].find("</think>") {
            text.replace_range(start..start + end + 8, "");
        } else {
            text.truncate(start);
            break;
        }
    }

    // 2. Eliminar cualquier bloque JSON de Tool Calling {"tool": ...}
    while let Some(start) = text.find(r#"{"tool""#) {
        let mut depth = 0;
        let mut close_idx = None;
        for (idx, c) in text[start..].char_indices() {
            if c == '{' {
                depth += 1;
            } else if c == '}' {
                depth -= 1;
                if depth == 0 {
                    close_idx = Some(start + idx);
                    break;
                }
            }
        }
        if let Some(ci) = close_idx {
            text.replace_range(start..=ci, " ");
        } else if let Some(end) = text[start..].find('}') {
            text.replace_range(start..=start + end, " ");
        } else {
            break;
        }
    }

    // 3. Eliminar bloques de código ```...```
    while let Some(start) = text.find("```") {
        if let Some(end) = text[start + 3..].find("```") {
            text.replace_range(start..start + 3 + end + 3, " ");
        } else {
            text.truncate(start);
            break;
        }
    }

    // 4. Eliminar código en línea `...`
    while let Some(start) = text.find('`') {
        if let Some(end) = text[start + 1..].find('`') {
            let inner = text[start + 1..start + 1 + end].to_string();
            text.replace_range(start..start + 1 + end + 1, &inner);
        } else {
            text.remove(start);
        }
    }

    // 5. Limpiar caracteres de marcado
    let mut cleaned = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '*' | '#' | '_' | '~' | '>' | '|' | '[' | ']' | '{' | '}' | '\\' => {}
            '\n' => cleaned.push(' '),
            _ => cleaned.push(c),
        }
    }

    // Normalizar espacios
    cleaned.split_whitespace().collect::<Vec<_>>().join(" ")
}

pub fn queue_speech_sentence(sentence: String) {
    init_speech_worker();
    if let Ok(lock) = SPEECH_TX.lock() {
        if let Some(tx) = lock.as_ref() {
            let _ = tx.send(SpeechCommand::Speak(sentence));
        }
    }
}

pub fn speak_text_async(text: String) {
    let cleaned = clean_markdown_for_speech(&text);
    if !cleaned.trim().is_empty() {
        queue_speech_sentence(cleaned);
    }
}

/// Función requerida: Síntesis asíncrona directa con Piper
pub async fn speak_with_piper(text: &str) {
    let cleaned = clean_markdown_for_speech(text);
    if !cleaned.trim().is_empty() {
        queue_speech_sentence(cleaned);
    }
}

/// Tauri Command: Activar/Desactivar voz de Enigma bajo demanda
#[tauri::command]
pub fn toggle_enigma_voice(enabled: Option<bool>) -> Result<bool, String> {
    let new_val = match enabled {
        Some(val) => {
            VOICE_ENABLED.store(val, Ordering::SeqCst);
            val
        }
        None => {
            let curr = VOICE_ENABLED.load(Ordering::SeqCst);
            VOICE_ENABLED.store(!curr, Ordering::SeqCst);
            !curr
        }
    };
    if !new_val {
        stop_speaking();
    }
    eprintln!("[Piper TTS] Voice state changed to: {}", new_val);
    Ok(new_val)
}

/// Tauri Command: Consulta el estado de voz
#[tauri::command]
pub fn get_enigma_voice_enabled() -> Result<bool, String> {
    Ok(VOICE_ENABLED.load(Ordering::SeqCst))
}

#[tauri::command]
pub async fn speak_text(text: String) -> Result<(), String> {
    speak_with_piper(&text).await;
    Ok(())
}

#[tauri::command]
pub fn stop_speaking_cmd() -> Result<(), String> {
    stop_speaking();
    Ok(())
}

/// Busca el punto de división de una oración completa basada en puntuación
fn find_sentence_break(text: &str) -> Option<usize> {
    let bytes = text.as_bytes();
    for i in 15..bytes.len() {
        let b = bytes[i];
        if (b == b'.' || b == b'?' || b == b'!') && (i + 1 == bytes.len() || bytes[i + 1].is_ascii_whitespace()) {
            return Some(i);
        }
        if b == b'\n' && i >= 25 {
            return Some(i);
        }
    }
    None
}

fn is_tool_or_json_fragment(s: &str) -> bool {
    let lower = s.to_lowercase();
    lower.contains("\"tool\"")
        || lower.contains("\"args\"")
        || lower.contains("send_whatsapp")
        || lower.contains("add_event")
        || lower.contains("get_calendar_events")
        || lower.contains("\"parameters\"")
        || lower.contains("```")
        || lower.contains("\"contact_name\"")
        || lower.contains("\"message\"")
}

/// Procesa tokens en tiempo real detectando oraciones completas
fn process_token_for_speech(token: &str, acc: &mut String, in_think: &mut bool) {
    if !VOICE_ENABLED.load(Ordering::SeqCst) {
        return;
    }

    let mut t = token;
    if *in_think {
        if let Some(pos) = t.find("</think>") {
            *in_think = false;
            t = &t[pos + 8..];
        } else {
            return;
        }
    } else if let Some(pos) = t.find("<think>") {
        acc.push_str(&t[..pos]);
        *in_think = true;
        if let Some(end) = t[pos + 7..].find("</think>") {
            *in_think = false;
            t = &t[pos + 7 + end + 8..];
        } else {
            return;
        }
    }

    acc.push_str(t);

    // Cuando el acumulador tenga longitud suficiente, buscar corte de frase
    if acc.len() >= 25 {
        if let Some(split_idx) = find_sentence_break(acc) {
            let sentence = acc[..=split_idx].to_string();
            acc.drain(..=split_idx);
            if !is_tool_or_json_fragment(&sentence) {
                let cleaned = clean_markdown_for_speech(&sentence);
                if !cleaned.trim().is_empty() {
                    queue_speech_sentence(cleaned);
                }
            }
        }
    }
}

/// Vacía cualquier texto restante al terminar el stream
fn flush_remaining_speech(acc: &mut String, in_think: bool) {
    if in_think || !VOICE_ENABLED.load(Ordering::SeqCst) {
        acc.clear();
        return;
    }
    let remaining = acc.drain(..).collect::<String>();
    if !is_tool_or_json_fragment(&remaining) {
        let cleaned = clean_markdown_for_speech(&remaining);
        if !cleaned.trim().is_empty() {
            queue_speech_sentence(cleaned);
        }
    }
}

#[derive(Debug, serde::Deserialize)]
struct ToolCall {
    #[serde(default)]
    tool: Option<String>,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    args: Option<ToolArgs>,
    #[serde(default)]
    arguments: Option<ToolArgs>,
    #[serde(default)]
    evento: Option<EventoArgs>,
    #[serde(default)]
    contact_name: Option<String>,
    #[serde(default)]
    message: Option<String>,
    #[serde(default)]
    app_name: Option<String>,
    #[serde(default)]
    query: Option<String>,
    #[serde(default)]
    text: Option<String>,
    #[serde(default)]
    key: Option<String>,
    #[serde(default)]
    command: Option<String>,
}

#[derive(Debug, Default, serde::Deserialize)]
struct ToolArgs {
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    titulo: Option<String>,
    #[serde(default)]
    date: Option<String>,
    #[serde(default)]
    fecha: Option<String>,
    #[serde(default)]
    time: Option<String>,
    #[serde(default)]
    hora: Option<String>,
    #[serde(default)]
    notify_before: Option<i32>,

    // WhatsApp parameters
    #[serde(default)]
    contact_name: Option<String>,
    #[serde(default)]
    contact: Option<String>,
    #[serde(default)]
    contacto: Option<String>,
    #[serde(default)]
    destinatario: Option<String>,
    #[serde(default)]
    number: Option<String>,
    #[serde(default)]
    numero: Option<String>,
    #[serde(default)]
    message: Option<String>,
    #[serde(default)]
    mensaje: Option<String>,
    #[serde(default)]
    text: Option<String>,
    #[serde(default)]
    texto: Option<String>,

    // Gmail parameters
    #[serde(default)]
    max_results: Option<u32>,

    // System Control & Web search parameters
    #[serde(default)]
    app_name: Option<String>,
    #[serde(default)]
    app: Option<String>,
    #[serde(default)]
    aplicacion: Option<String>,
    #[serde(default)]
    query: Option<String>,
    #[serde(default)]
    busqueda: Option<String>,
    #[serde(default)]
    termino: Option<String>,
    #[serde(default)]
    key: Option<String>,
    #[serde(default)]
    tecla: Option<String>,
    #[serde(default)]
    button: Option<String>,
    #[serde(default)]
    boton: Option<String>,
    #[serde(default)]
    x: Option<i32>,
    #[serde(default)]
    y: Option<i32>,
    #[serde(default)]
    command: Option<String>,
    #[serde(default)]
    comando: Option<String>,
}

#[derive(Debug, Default, serde::Deserialize)]
struct EventoArgs {
    #[serde(default)]
    titulo: Option<String>,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    fecha: Option<String>,
    #[serde(default)]
    date: Option<String>,
    #[serde(default)]
    hora: Option<String>,
    #[serde(default)]
    time: Option<String>,
    #[serde(default)]
    notify_before: Option<i32>,
}

fn has_conversational_text(text: &str) -> bool {
    let mut clean = text.to_string();
    if let Some(start) = clean.find("<think>") {
        if let Some(end) = clean.find("</think>") {
            clean.replace_range(start..end + 8, " ");
        }
    }
    while let Some(start) = clean.find('{') {
        if let Some(end) = clean[start..].find('}') {
            clean.replace_range(start..=start + end, " ");
        } else {
            break;
        }
    }
    clean.retain(|c| c.is_alphabetic());
    clean.len() >= 6
}

fn is_read_agenda_intent(prompt: &str) -> bool {
    let lower = prompt.to_lowercase();
    let read_keywords = [
        "leer", "lee", "léeme", "leeme", "consulta", "consultar", "consúltame", "consultame",
        "ver", "muestra", "muéstrame", "muestrame", "qué tengo", "que tengo",
        "tengo algo", "hay algo", "revisa", "revisar", "comprueba", "comprobar",
        "agenda", "calendario", "citas de hoy", "eventos de hoy", "horario de hoy",
        "qué planes", "que planes", "planes para hoy"
    ];
    let create_keywords = [
        "añade", "añadir", "agrega", "agregar", "crea", "crear", "creame", "créame",
        "programa", "programar", "apunta", "apuntar", "agendar a las", "agenda una",
        "agenda un", "agenda cita", "agenda reunión", "agenda reunion", "guarda",
        "guardar evento", "recuérdame", "recuerdame", "pon en mi agenda", "apúntame", "apuntame"
    ];

    let has_read = read_keywords.iter().any(|k| lower.contains(k));
    let has_create = create_keywords.iter().any(|k| lower.contains(k));

    has_read && !has_create
}

fn is_explicit_create_intent(prompt: &str) -> bool {
    let lower = prompt.to_lowercase();
    let create_keywords = [
        "añade", "añadir", "agrega", "agregar", "crea", "crear", "creame", "créame",
        "programa", "programar", "apunta", "apuntar", "agenda para", "agenda una",
        "agenda un", "agenda reunión", "agenda reunion", "agenda cita", "guarda",
        "guardar evento", "recuérdame", "recuerdame", "pon en mi agenda", "apúntame", "apuntame"
    ];
    create_keywords.iter().any(|k| lower.contains(k))
}

fn is_read_gmail_intent(prompt: &str) -> bool {
    let lower = prompt.to_lowercase();
    let email_terms = [
        "correo", "correos", "email", "emails", "gmail", "bandeja de entrada",
        "inbox", "mensajes de correo", "mis correos", "mis emails"
    ];
    let action_terms = [
        "leer", "lee", "leeme", "léeme", "revisa", "revisar", "comprueba",
        "comprobar", "ver", "muestra", "muéstrame", "muestrame", "mira",
        "mirar", "qué hay en mi", "que hay en mi", "tengo", "hay", "puedes leer",
        "consulta", "consultar", "consúltame", "consultame", "dime", "cuenta",
        "cuéntame", "cuentame", "todos", "todos los", "últimos", "ultimos",
        "buscar", "cuáles", "cuales"
    ];

    let has_email = email_terms.iter().any(|t| lower.contains(t));
    if !has_email {
        return false;
    }

    // Excluir si la intención es ENVIAR o REDACTAR un correo
    let send_terms = [
        "envía", "envia", "enviar", "manda", "mandar", "escribe", "escribir", "redacta", "redactar"
    ];
    if send_terms.iter().any(|s| lower.contains(s)) {
        return false;
    }

    let has_action = action_terms.iter().any(|a| lower.contains(a));
    has_action
        || lower.contains("puedes leer")
        || lower.contains("mis correos")
        || lower.contains("mis emails")
        || lower.contains("dime los correos")
        || lower.contains("dime todos")
}

pub fn execute_gmail_read(app: &AppHandle, limit: u32) {
    let app_clone = app.clone();
    tauri::async_runtime::spawn(async move {
        match crate::google_auth::fetch_recent_emails(limit).await {
            Ok(emails) => {
                if emails.is_empty() {
                    let msg = "He consultado tu bandeja de entrada de Gmail y no tienes correos recientes.".to_string();
                    let ui_badge = "\n\n> ✉️ **Gmail**: Tu bandeja de entrada está al día, no hay correos recientes.\n".to_string();
                    let _ = app_clone.emit("enigma-token", ui_badge);
                    stop_speaking();
                    speak_text_async(msg);
                } else {
                    let mut md = format!(
                        "\n\nHe consultado tu bandeja de entrada de Gmail y he recuperado **{} correos recientes**:\n\n",
                        emails.len()
                    );
                    let mut spoken_parts = Vec::new();

                    for (idx, em) in emails.iter().enumerate() {
                        let sender_clean = em.from.replace('<', "(").replace('>', ")");
                        let email_json = serde_json::json!({
                            "remitente": sender_clean,
                            "asunto": em.subject,
                            "fecha": em.date,
                            "contenido": em.snippet
                        });
                        let json_str = serde_json::to_string_pretty(&email_json).unwrap_or_default();
                        md.push_str(&format!("```json\n{}\n```\n\n", json_str));

                        if idx < 3 {
                            let clean_name = sender_clean.split('(').next().unwrap_or(&sender_clean).trim();
                            spoken_parts.push(format!("de {} sobre '{}'", clean_name, em.subject));
                        }
                    }

                    let _ = app_clone.emit("enigma-token", md);
                    let _ = app_clone.emit("gmail-emails-fetched", &emails);
                    let spoken_summary = format!(
                        "Tienes {} correos recientes en Gmail. El más reciente es {}.",
                        emails.len(),
                        spoken_parts.join(", y otro ")
                    );
                    stop_speaking();
                    speak_text_async(spoken_summary);
                }
                let _ = app_clone.emit("enigma-done", ());
            }
            Err(e) => {
                eprintln!("[ToolCalling] Error leyendo Gmail: {}", e);
                let is_unauthed = e.contains("No hay cuenta de Google vinculada") || e.contains("401") || e.contains("re-autenticar");
                let (ui_msg, spoken) = if is_unauthed {
                    (
                        "\n\n> ⚠️ **Google Workspace no vinculado**: Para leer tus correos de Gmail, por favor conecta tu cuenta de Google en la pestaña **Extensiones** de Enigma introduciendo tu Client ID y Secret.\n".to_string(),
                        "No puedo leer tus correos porque aún no has vinculado tu cuenta de Google en Enigma. Puedes hacerlo fácilmente desde el menú de Extensiones.".to_string()
                    )
                } else {
                    (
                        format!("\n\n> ⚠️ **Error consultando Gmail**: {}\n", e),
                        format!("Ha ocurrido un error al consultar tu Gmail: {}", e)
                    )
                };
                let _ = app_clone.emit("enigma-token", ui_msg);
                let _ = app_clone.emit("enigma-done", ());
                stop_speaking();
                speak_text_async(spoken);
            }
        }
    });
}

pub fn execute_browser_search(query: &str) -> Result<(), String> {
    let encoded = url::form_urlencoded::byte_serialize(query.as_bytes()).collect::<String>();
    let search_url = format!("https://www.google.com/search?q={}", encoded);

    eprintln!("[execute_browser_search] Abriendo búsqueda en navegador para: '{}' ({})", query, search_url);

    // 1. Intentar con Opera (navegador predeterminado de Santi)
    if Command::new("opera")
        .arg(&search_url)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .is_ok()
    {
        // Traer al frente la ventana de Opera en KDE Plasma (inmediato y tras un breve retraso para garantizar el foco)
        let windows = crate::windows::get_open_windows();
        if let Some(win) = windows.iter().find(|w| w.app_name.to_lowercase().contains("opera") || w.title.to_lowercase().contains("opera")) {
            let _ = crate::windows::focus_window_by_id(&win.id);
        }
        std::thread::spawn(|| {
            std::thread::sleep(std::time::Duration::from_millis(350));
            let windows = crate::windows::get_open_windows();
            if let Some(win) = windows.iter().find(|w| w.app_name.to_lowercase().contains("opera") || w.title.to_lowercase().contains("opera") || w.window_class.contains("opera")) {
                let _ = crate::windows::focus_window_by_id(&win.id);
            }
        });
        return Ok(());
    }

    // 2. Fallback con open::that
    if open::that(&search_url).is_ok() {
        return Ok(());
    }

    // 3. Fallback con xdg-open
    Command::new("xdg-open")
        .arg(&search_url)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("Error abriendo navegador: {}", e))
}

fn extract_browser_search_intent(prompt: &str) -> Option<String> {
    let lower = prompt.to_lowercase();

    // Palabras clave de navegación/búsqueda
    let has_browser = lower.contains("navegador")
        || lower.contains("google")
        || lower.contains("barra de búsqueda")
        || lower.contains("barra de busqueda")
        || lower.contains("internet")
        || lower.contains("opera")
        || lower.contains("chrome")
        || lower.contains("firefox");

    let has_search = lower.contains("busca")
        || lower.contains("busques")
        || lower.contains("buscar")
        || lower.contains("pon")
        || lower.contains("encuentra");

    if !(has_browser && has_search) && !lower.starts_with("busca en google ") && !lower.starts_with("busca en internet ") {
        return None;
    }

    let clean = prompt.trim();
    let lower_clean = clean.to_lowercase();

    let split_markers = [
        "en la barra de búsqueda ",
        "en la barra de busqueda ",
        "barra de búsqueda ",
        "barra de busqueda ",
        "en el navegador y busca ",
        "en el navegador y busques ",
        "al navegador y busca ",
        "al navegador y busques ",
        "mi navegador y busca ",
        "mi navegador y busques ",
        "en el navegador ",
        "en google ",
        "en internet ",
        "y busques ",
        "y busca ",
        "busques ",
        "busca ",
        "buscar ",
    ];

    for marker in split_markers {
        if let Some(pos) = lower_clean.rfind(marker) {
            let candidate = clean[pos + marker.len()..].trim();
            let candidate_clean = candidate
                .trim_matches(|c| c == '"' || c == '\'' || c == '«' || c == '»' || c == '.')
                .trim_start_matches("que diga ")
                .trim_start_matches("la palabra ")
                .trim();
            if !candidate_clean.is_empty() && candidate_clean.len() <= 200 {
                return Some(candidate_clean.to_string());
            }
        }
    }

    None
}

fn extract_open_app_intent(prompt: &str) -> Option<String> {
    let lower = prompt.to_lowercase();
    let prefixes = [
        "abre la aplicación ", "abre la app ", "abre el programa ", "abre ", "abrir ", "ejecuta ", "lanzar ", "inicia "
    ];
    for p in prefixes {
        if lower.starts_with(p) {
            let target = prompt[p.len()..].trim().trim_matches(|c| c == '.' || c == '"' || c == '\'');
            if !target.is_empty()
                && target.split_whitespace().count() <= 3
                && !target.contains("correo")
                && !target.contains("calendario")
                && !target.contains("agenda")
                && !target.contains("whatsapp")
                && !target.contains("navegador")
            {
                return Some(target.to_string());
            }
        }
    }
    None
}

fn extract_close_app_intent(prompt: &str) -> Option<String> {
    let lower = prompt.to_lowercase();
    let prefixes = [
        "cierra la aplicación ", "cierra la app ", "cierra el programa ", "cierra ", "cerrar ", "mata el proceso ", "apaga "
    ];
    for p in prefixes {
        if lower.starts_with(p) {
            let target = prompt[p.len()..].trim().trim_matches(|c| c == '.' || c == '"' || c == '\'');
            if !target.is_empty()
                && target.split_whitespace().count() <= 3
                && !target.contains("correo")
                && !target.contains("calendario")
                && !target.contains("agenda")
                && !target.contains("whatsapp")
            {
                return Some(target.to_string());
            }
        }
    }
    None
}

pub fn execute_tool_calls_if_any(app: &AppHandle, user_prompt: &str, text: &str) -> bool {
    let mut search_idx = 0;
    while let Some(tool_pos) = text[search_idx..].find('{') {
        let start = search_idx + tool_pos;
        let mut depth = 0;
        let mut end_idx = None;
        for (offset, ch) in text[start..].char_indices() {
            if ch == '{' {
                depth += 1;
            } else if ch == '}' {
                depth -= 1;
                if depth == 0 {
                    end_idx = Some(start + offset);
                    break;
                }
            }
        }

        if let Some(end) = end_idx {
            let candidate = &text[start..=end];
            if let Ok(tool_call) = serde_json::from_str::<ToolCall>(candidate) {
                let tool_name = tool_call.tool.or(tool_call.name).unwrap_or_default();
                let is_add = tool_name == "add_event" || tool_call.evento.is_some();
                let is_get = tool_name == "get_calendar_events";

                if is_get {
                    eprintln!("[ToolCalling] SELECT: Tool 'get_calendar_events' invocada. Actualizando UI.");
                    let _ = app.emit("refresh-calendar", ());
                    let _ = app.emit_to("main", "refresh-calendar", ());

                    // Si el modelo no generó texto verbal (solo el JSON del tool call), sintetizar respuesta JARVIS
                    if !has_conversational_text(text) {
                        let now = chrono::Local::now();
                        let today_str = now.format("%Y-%m-%d").to_string();
                        let events = crate::db::db_get_calendar_events().unwrap_or_default();
                        let today_events: Vec<_> = events.iter().filter(|e| e.event_date == today_str).collect();
                        let response = if today_events.is_empty() {
                            "He consultado tu agenda en tiempo real. No tienes ningún evento programado para hoy, estás completamente libre.".to_string()
                        } else {
                            let list = today_events.iter().map(|e| format!("{} a las {}", e.title, e.event_time)).collect::<Vec<_>>().join(", ");
                            format!("Tienes los siguientes eventos programados para hoy: {}.", list)
                        };
                        let _ = app.emit("enigma-token", response.clone());
                        speak_text_async(response);
                    }
                    return true;
                } else if is_add {
                    // Si el usuario envió un comando ambiguo o de lectura, bloquear INSERT
                    if is_read_agenda_intent(user_prompt) || !is_explicit_create_intent(user_prompt) {
                        eprintln!(
                            "[ToolCalling] BLOQUEADO: Se rechazó 'add_event' espurio/alucinado. El usuario pidió consultar/leer ('{}'). Priorizando lectura (SELECT).",
                            user_prompt
                        );
                        let _ = app.emit("refresh-calendar", ());
                        search_idx = end + 1;
                        continue;
                    }

                    let (title, date, time, notify_before) = if let Some(ev) = tool_call.evento {
                        let t = ev.titulo.or(ev.title).unwrap_or_default().trim().to_string();
                        let d = ev.fecha.or(ev.date).unwrap_or_default().trim().to_string();
                        let h = ev.hora.or(ev.time).unwrap_or_else(|| "10:00".to_string()).trim().to_string();
                        let n = ev.notify_before.unwrap_or(15);
                        (t, d, h, n)
                    } else {
                        let args = tool_call.args.or(tool_call.arguments).unwrap_or_default();
                        let t = args.title.or(args.titulo).unwrap_or_default().trim().to_string();
                        let d = args.date.or(args.fecha).unwrap_or_default().trim().to_string();
                        let h = args.time.or(args.hora).unwrap_or_else(|| "10:00".to_string()).trim().to_string();
                        let n = args.notify_before.unwrap_or(15);
                        (t, d, h, n)
                    };

                    if title.is_empty() || date.is_empty() {
                        eprintln!("[ToolCalling] Rechazado add_event con título o fecha vacía.");
                        search_idx = end + 1;
                        continue;
                    }

                    eprintln!(
                        "[ToolCalling] Intención de creación validada al 100%. Insertando 'add_event': '{}' on {} at {} (notify {} mins)",
                        title, date, time, notify_before
                    );

                    match crate::db::db_add_calendar_event(&title, &date, &time, notify_before, None) {
                        Ok(id) => {
                            eprintln!("[ToolCalling] Evento #{} creado exitosamente en SQLite!", id);
                            let _ = app.emit("refresh-calendar", ());

                            if !has_conversational_text(text) {
                                let response = format!("He agendado '{}' en tu calendario para el {} a las {}.", title, date, time);
                                let _ = app.emit("enigma-token", response.clone());
                                speak_text_async(response);
                            }
                        }
                        Err(e) => {
                            eprintln!("[ToolCalling] Error al guardar en SQLite: {}", e);
                        }
                    }
                    return true;
                } else if tool_name == "send_whatsapp"
                    || tool_call.contact_name.is_some()
                    || tool_call.args.as_ref().map(|a| a.contact_name.is_some() || a.contact.is_some() || a.contacto.is_some()).unwrap_or(false)
                {
                    // Manejo de la herramienta send_whatsapp
                    let (contact_raw, message_raw) = if let Some(args) = tool_call.args.or(tool_call.arguments) {
                        let c = args.contact_name
                            .or(args.contact)
                            .or(args.contacto)
                            .or(args.destinatario)
                            .or(args.number)
                            .or(args.numero)
                            .unwrap_or_default();
                        let m = args.message
                            .or(args.mensaje)
                            .or(args.texto)
                            .unwrap_or_default();
                        (c, m)
                    } else {
                        (
                            tool_call.contact_name.unwrap_or_default(),
                            tool_call.message.unwrap_or_default(),
                        )
                    };

                    let contact_trimmed = contact_raw.trim().to_string();
                    let message_trimmed = message_raw.trim().to_string();

                    if contact_trimmed.is_empty() || message_trimmed.is_empty() {
                        eprintln!("[ToolCalling] Rechazado send_whatsapp con contacto o mensaje vacío.");
                        search_idx = end + 1;
                        continue;
                    }

                    eprintln!(
                        "[ToolCalling] Interceptada llamada send_whatsapp para: '{}' | Mensaje: '{}'",
                        contact_trimmed, message_trimmed
                    );

                    // Resolución Inteligente: SELECT id, name FROM whatsapp_contacts WHERE name LIKE '%Query%' LIMIT 1
                    let resolution = crate::db::db_find_whatsapp_contact_by_name(&contact_trimmed);
                    match resolution {
                        Some((jid, resolved_name)) => {
                            eprintln!(
                                "[ToolCalling] Contacto resuelto con éxito en SQLite: '{}' -> '{}' ({})",
                                contact_trimmed, resolved_name, jid
                            );

                            let app_clone = app.clone();
                            let contact_display = resolved_name.clone();
                            let msg_to_send = message_trimmed.clone();
                            let target_jid = jid.clone();

                            // Disparar envío HTTP asíncrono al microservicio local de Node.js (puerto 3030)
                            tauri::async_runtime::spawn(async move {
                                match crate::whatsapp_bridge::send_whatsapp_http(&target_jid, &msg_to_send).await {
                                    Ok(res) => {
                                        eprintln!(
                                            "[ToolCalling] Mensaje de WhatsApp entregado con éxito a {} (JID: {}) (ID: {:?})",
                                            contact_display, target_jid, res.message_id
                                        );
                                        let _ = app_clone.emit(
                                            "whatsapp-sent",
                                            serde_json::json!({
                                                "contact": contact_display,
                                                "jid": target_jid,
                                                "message": msg_to_send,
                                                "success": true
                                            }),
                                        );

                                        let confirmation_voice = format!(
                                            "Mensaje de WhatsApp enviado a {}: {}.",
                                            contact_display, msg_to_send
                                        );
                                        let ui_badge = format!(
                                            "\n\n> 📱 **WhatsApp enviado a {}** (`{}`): *\"{}\"*\n",
                                            contact_display, target_jid, msg_to_send
                                        );
                                        let _ = app_clone.emit("enigma-token", ui_badge);
                                        stop_speaking();
                                        speak_text_async(confirmation_voice);
                                    }
                                    Err(err) => {
                                        eprintln!("[ToolCalling] Error enviando WhatsApp: {}", err);
                                        let is_disconnected = err.contains("no está conectado") || err.contains("503") || err.contains("QR");
                                        let error_voice = if is_disconnected {
                                            "No he podido enviar el mensaje porque WhatsApp no está conectado. Por favor, abre el menú de Enigma y escanea el código QR.".to_string()
                                        } else {
                                            format!("No se pudo enviar el mensaje a {}: {}", contact_display, err)
                                        };

                                        let ui_badge = format!("\n\n> ⚠️ **Error al enviar WhatsApp a {}**: {}\n", contact_display, err);
                                        let _ = app_clone.emit("enigma-token", ui_badge);
                                        stop_speaking();
                                        speak_text_async(error_voice);
                                    }
                                }
                            });
                        }
                        None => {
                            eprintln!(
                                "[ToolCalling] Contacto no encontrado en SQLite: 'SELECT id FROM whatsapp_contacts WHERE name LIKE %{}%'",
                                contact_trimmed
                            );
                            let not_found_voice = "No encuentro a esa persona en tus contactos.".to_string();
                            let ui_badge = format!(
                                "\n\n> ⚠️ **No encuentro a esa persona en tus contactos**: '{}'\n",
                                contact_trimmed
                            );
                            let _ = app.emit("enigma-token", ui_badge);
                            stop_speaking();
                            speak_text_async(not_found_voice);
                        }
                    }
                    return true;
                } else if tool_name == "get_recent_emails"
                    || tool_name == "read_emails"
                    || tool_name == "get_emails"
                    || tool_name == "leer_correos"
                {
                    eprintln!("[ToolCalling] Interceptada llamada a Gmail '{}'", tool_name);
                    let limit = tool_call.args.and_then(|a| a.max_results).unwrap_or(5);
                    execute_gmail_read(app, limit);
                    return true;
                } else if tool_name == "search_web"
                    || tool_name == "browser_search"
                    || tool_name == "buscar_web"
                    || tool_name == "buscar_en_internet"
                {
                    let q = tool_call
                        .args
                        .as_ref()
                        .and_then(|a| a.query.as_ref().or(a.busqueda.as_ref()).or(a.termino.as_ref()))
                        .or(tool_call.query.as_ref())
                        .cloned()
                        .unwrap_or_else(|| "Google".to_string());
                    eprintln!("[ToolCalling] Interceptada llamada a search_web: '{}'", q);
                    let _ = execute_browser_search(&q);
                    let ui_badge = format!("\n\n> 🌐 **Navegador**: He abierto tu navegador y he buscado **\"{}\"** en Google.\n", q);
                    let _ = app.emit("enigma-token", ui_badge);
                    let voice = format!("Buscando {} en tu navegador.", q);
                    stop_speaking();
                    speak_text_async(voice);
                    return true;
                } else if tool_name == "open_app" || tool_name == "abrir_app" {
                    let target = tool_call
                        .args
                        .as_ref()
                        .and_then(|a| a.app_name.as_ref().or(a.app.as_ref()).or(a.aplicacion.as_ref()))
                        .or(tool_call.app_name.as_ref())
                        .cloned()
                        .unwrap_or_default();
                    if !target.is_empty() {
                        eprintln!("[ToolCalling] Interceptada llamada a open_app: '{}'", target);
                        let res = crate::system_control::open_app(target.clone());
                        let (badge, voice) = match res {
                            Ok(()) => (
                                format!("\n\n> 🚀 **Aplicación abierta**: **{}**\n", target),
                                format!("Abriendo {}.", target),
                            ),
                            Err(e) => (
                                format!("\n\n> ⚠️ **Error al abrir {}**: {}\n", target, e),
                                format!("No he podido abrir {}.", target),
                            ),
                        };
                        let _ = app.emit("enigma-token", badge);
                        stop_speaking();
                        speak_text_async(voice);
                        return true;
                    }
                } else if tool_name == "close_app" || tool_name == "cerrar_app" {
                    let target = tool_call
                        .args
                        .as_ref()
                        .and_then(|a| a.app_name.as_ref().or(a.app.as_ref()).or(a.aplicacion.as_ref()))
                        .or(tool_call.app_name.as_ref())
                        .cloned()
                        .unwrap_or_default();
                    if !target.is_empty() {
                        eprintln!("[ToolCalling] Interceptada llamada a close_app: '{}'", target);
                        let res = crate::system_control::close_app(target.clone());
                        let (badge, voice) = match res {
                            Ok(()) => (
                                format!("\n\n> 🛑 **Aplicación cerrada**: **{}**\n", target),
                                format!("He cerrado {}.", target),
                            ),
                            Err(e) => (
                                format!("\n\n> ⚠️ **Error al cerrar {}**: {}\n", target, e),
                                format!("No he encontrado el proceso para cerrar {}.", target),
                            ),
                        };
                        let _ = app.emit("enigma-token", badge);
                        stop_speaking();
                        speak_text_async(voice);
                        return true;
                    }
                } else if tool_name == "type_text" || tool_name == "escribir_texto" {
                    let txt = tool_call
                        .args
                        .as_ref()
                        .and_then(|a| a.text.as_ref().or(a.texto.as_ref()))
                        .or(tool_call.text.as_ref())
                        .cloned()
                        .unwrap_or_default();
                    if !txt.is_empty() {
                        eprintln!("[ToolCalling] Escribiendo texto con teclado virtual: '{}'", txt);
                        let _ = crate::system_control::type_text(txt.clone());
                        let ui_badge = format!("\n\n> ⌨️ **Texto escrito**: *\"{}\"*\n", txt);
                        let _ = app.emit("enigma-token", ui_badge);
                        return true;
                    }
                } else if tool_name == "press_key" || tool_name == "pulsar_tecla" {
                    let k = tool_call
                        .args
                        .as_ref()
                        .and_then(|a| a.key.as_ref().or(a.tecla.as_ref()))
                        .or(tool_call.key.as_ref())
                        .cloned()
                        .unwrap_or_default();
                    if !k.is_empty() {
                        eprintln!("[ToolCalling] Pulsando tecla virtual: '{}'", k);
                        let _ = crate::system_control::press_key(k.clone());
                        let ui_badge = format!("\n\n> ⌨️ **Tecla pulsada**: `{}`\n", k);
                        let _ = app.emit("enigma-token", ui_badge);
                        return true;
                    }
                } else if tool_name == "move_mouse" || tool_name == "mover_raton" {
                    let (x, y) = tool_call
                        .args
                        .as_ref()
                        .map(|a| (a.x.unwrap_or(0), a.y.unwrap_or(0)))
                        .unwrap_or((0, 0));
                    eprintln!("[ToolCalling] Moviendo ratón a: ({}, {})", x, y);
                    let _ = crate::system_control::move_mouse(x, y);
                    let ui_badge = format!("\n\n> 🖱️ **Ratón movido a**: `({}, {})`\n", x, y);
                    let _ = app.emit("enigma-token", ui_badge);
                    return true;
                } else if tool_name == "mouse_click" || tool_name == "click_raton" {
                    let btn = tool_call
                        .args
                        .as_ref()
                        .and_then(|a| a.button.as_ref().or(a.boton.as_ref()))
                        .cloned()
                        .unwrap_or_else(|| "left".to_string());
                    eprintln!("[ToolCalling] Clic de ratón: '{}'", btn);
                    let _ = crate::system_control::mouse_click(btn.clone());
                    let ui_badge = format!("\n\n> 🖱️ **Clic de ratón**: `{}`\n", btn);
                    let _ = app.emit("enigma-token", ui_badge);
                    return true;
                } else if tool_name == "run_terminal" || tool_name == "ejecutar_comando" || tool_name == "terminal" {
                    let cmd = tool_call
                        .args
                        .as_ref()
                        .and_then(|a| a.command.as_ref().or(a.comando.as_ref()))
                        .or(tool_call.command.as_ref())
                        .cloned()
                        .unwrap_or_default();
                    if !cmd.is_empty() {
                        eprintln!("[ToolCalling] Ejecutando comando en terminal: '{}'", cmd);
                        let res = crate::system_control::run_terminal(cmd.clone());
                        let (badge, voice) = match res {
                            Ok(output) => {
                                let preview = if output.chars().count() > 150 {
                                    let tr: String = output.chars().take(150).collect();
                                    format!("{}...", tr)
                                } else {
                                    output.clone()
                                };
                                (
                                    format!("\n\n> 💻 **Comando ejecutado**: `{}`\n```bash\n{}\n```\n", cmd, output.trim()),
                                    format!("Comando ejecutado con éxito. La salida es: {}", preview),
                                )
                            },
                            Err(err) => (
                                format!("\n\n> ⚠️ **Error en comando `{}`**:\n```\n{}\n```\n", cmd, err.trim()),
                                format!("Ha ocurrido un error al ejecutar el comando: {}", err),
                            ),
                        };
                        let _ = app.emit("enigma-token", badge);
                        stop_speaking();
                        speak_text_async(voice);
                        return true;
                    }
                }
            }
            search_idx = end + 1;
            continue;
        }
        search_idx = start + 1;
    }

    // Fallback: Si el modelo no generó el bloque JSON pero el usuario pidió explícitamente leer correos de Gmail
    if is_read_gmail_intent(user_prompt) {
        eprintln!("[ToolCalling] Intent de lectura de Gmail detectado en el prompt: '{}'", user_prompt);
        execute_gmail_read(app, 5);
        return true;
    }

    false
}

#[tauri::command]
pub async fn invoke_enigma(app: AppHandle, prompt: String) -> Result<(), String> {
    eprintln!("[invoke_enigma] Sending prompt to Ollama (deepseek-r1:14b)...");
    stop_speaking();

    // Guardar mensaje de Santiago en la memoria a corto plazo
    let _ = crate::memory::save_message("user", &prompt);

    let client = Client::new();

    let now = chrono::Local::now();
    let current_date = now.format("%Y-%m-%d").to_string();
    let current_time = now.format("%H:%M").to_string();
    let weekday_es = match now.format("%u").to_string().as_str() {
        "1" => "lunes",
        "2" => "martes",
        "3" => "miércoles",
        "4" => "jueves",
        "5" => "viernes",
        "6" => "sábado",
        "7" => "domingo",
        _ => "hoy",
    };

    // Consultar eventos reales en SQLite para proporcionar el estado exacto de la agenda
    let existing_events = crate::db::db_get_calendar_events().unwrap_or_default();
    let today_str = current_date.clone();
    let today_events: Vec<_> = existing_events
        .iter()
        .filter(|e| e.event_date == today_str)
        .map(|e| format!("- {} a las {} (aviso {}m antes)", e.title, e.event_time, e.notify_before_mins))
        .collect();

    let calendar_status_summary = if existing_events.is_empty() {
        "[] (Array vacío: no hay ningún evento programado en la base de datos SQLite)".to_string()
    } else if today_events.is_empty() {
        format!("[] para hoy {}. (Existen otros eventos en fechas futuras en la base de datos: {})", today_str, serde_json::to_string(&existing_events).unwrap_or_default())
    } else {
        format!("Eventos programados para hoy ({}):\n{}", today_str, today_events.join("\n"))
    };

    // Consultar estado de vinculación con Google Workspace
    let google_status = crate::google_auth::get_google_auth_status().unwrap_or(crate::google_auth::GoogleAuthStatus {
        connected: false,
        has_refresh_token: false,
        expires_at: 0,
        is_expired: true,
        scopes: vec![],
    });

    // Atajo Proactivo: Si el usuario pide explícitamente leer o consultar correos de Gmail,
    // respondemos de inmediato con datos reales de la API de Google sin retrasos ni alucinaciones de LLM
    if is_read_gmail_intent(&prompt) {
        eprintln!("[invoke_enigma] Atajo proactivo de lectura de Gmail para: '{}'", prompt);
        if !google_status.connected {
            let msg = "> ⚠️ **Google Workspace no vinculado**:\nPara consultar tus correos de Gmail en tiempo real, vincula tu cuenta de Google desde la pestaña **Extensiones** introduciendo tu Client ID y Client Secret de Google Cloud.\n".to_string();
            let _ = app.emit("enigma-token", msg);
            let _ = app.emit("enigma-done", ());
            speak_text_async("No puedo acceder a tus correos porque aún no has vinculado tu cuenta de Google en Enigma. Puedes hacerlo en la pestaña de Extensiones.".to_string());
            return Ok(());
        }

        let intro = "Revisando tu bandeja de entrada de Gmail en tiempo real...\n\n".to_string();
        let _ = app.emit("enigma-token", intro);

        match crate::google_auth::fetch_recent_emails(5).await {
            Ok(emails) => {
                if emails.is_empty() {
                    let msg = "> ✉️ **Gmail**: Tu bandeja de entrada está al día. No tienes correos recientes.\n".to_string();
                    let _ = app.emit("enigma-token", msg);
                    speak_text_async("He consultado tu bandeja de entrada de Gmail y no tienes correos recientes. Estás al día.".to_string());
                } else {
                    let mut md = format!(
                        "He recuperado los **{} correos más recientes** de tu bandeja de entrada:\n\n",
                        emails.len()
                    );
                    let mut spoken_parts = Vec::new();

                    for (idx, em) in emails.iter().enumerate() {
                        let sender_clean = em.from.replace('<', "(").replace('>', ")");
                        let email_json = serde_json::json!({
                            "remitente": sender_clean,
                            "asunto": em.subject,
                            "fecha": em.date,
                            "contenido": em.snippet
                        });
                        let json_str = serde_json::to_string_pretty(&email_json).unwrap_or_default();
                        md.push_str(&format!("```json\n{}\n```\n\n", json_str));

                        if idx < 3 {
                            let clean_name = sender_clean.split('(').next().unwrap_or(&sender_clean).trim();
                            spoken_parts.push(format!("de {} sobre '{}'", clean_name, em.subject));
                        }
                    }

                    let _ = app.emit("enigma-token", md);
                    let _ = app.emit("gmail-emails-fetched", &emails);
                    let spoken_summary = format!(
                        "Tienes {} correos recientes en Gmail. El más reciente es {}.",
                        emails.len(),
                        spoken_parts.join(", y otro ")
                    );
                    speak_text_async(spoken_summary);
                }
            }
            Err(e) => {
                let err_msg = format!("> ⚠️ **Error consultando Gmail**: {}\n", e);
                let _ = app.emit("enigma-token", err_msg);
                speak_text_async(format!("Ha ocurrido un error al consultar tu correo de Gmail: {}", e));
            }
        }

        let _ = app.emit("enigma-done", ());
        return Ok(());
    }

    // 1. Atajo Proactivo: Búsqueda en el Navegador Web (Opera / Google)
    if let Some(query) = extract_browser_search_intent(&prompt) {
        eprintln!("[invoke_enigma] Atajo proactivo de búsqueda en navegador para: '{}'", query);
        let _ = execute_browser_search(&query);
        let ui_msg = format!("> 🌐 **Navegador**: He abierto tu navegador y he buscado **\"{}\"** en Google.\n", query);
        let _ = app.emit("enigma-token", ui_msg);
        let _ = app.emit("enigma-done", ());
        stop_speaking();
        speak_text_async(format!("Abriendo tu navegador y buscando {} en Google.", query));
        return Ok(());
    }

    // 2. Atajo Proactivo: Abrir aplicación directamente ("abre spotify", "abre opera", "abre discord", "abre firefox")
    if let Some(app_target) = extract_open_app_intent(&prompt) {
        eprintln!("[invoke_enigma] Atajo proactivo de apertura de app: '{}'", app_target);
        let res = crate::system_control::open_app(app_target.clone());
        let (ui_msg, voice) = match res {
            Ok(()) => (
                format!("> 🚀 **Aplicación**: Abriendo **{}**...\n", app_target),
                format!("Abriendo {}.", app_target),
            ),
            Err(e) => (
                format!("> ⚠️ **Error al abrir {}**: {}\n", app_target, e),
                format!("No he podido abrir {}.", app_target),
            ),
        };
        let _ = app.emit("enigma-token", ui_msg);
        let _ = app.emit("enigma-done", ());
        stop_speaking();
        speak_text_async(voice);
        return Ok(());
    }

    // 3. Atajo Proactivo: Cerrar aplicación directamente ("cierra discord", "cierra spotify")
    if let Some(app_target) = extract_close_app_intent(&prompt) {
        eprintln!("[invoke_enigma] Atajo proactivo de cierre de app: '{}'", app_target);
        let res = crate::system_control::close_app(app_target.clone());
        let (ui_msg, voice) = match res {
            Ok(()) => (
                format!("> 🛑 **Aplicación**: He cerrado **{}** correctamente.\n", app_target),
                format!("He cerrado {}.", app_target),
            ),
            Err(e) => (
                format!("> ⚠️ **Error al cerrar {}**: {}\n", app_target, e),
                format!("No he encontrado el proceso {}.", app_target),
            ),
        };
        let _ = app.emit("enigma-token", ui_msg);
        let _ = app.emit("enigma-done", ());
        stop_speaking();
        speak_text_async(voice);
        return Ok(());
    }

    let google_workspace_summary = if google_status.connected {
        "CONECTADO Y VINCULADO. Tienes acceso completo a Gmail y Google Calendar. Si el usuario te pide leer, ver o consultar correos, UTILIZA SIEMPRE la herramienta `get_recent_emails` con {\"tool\": \"get_recent_emails\", \"args\": {\"max_results\": 5}}.".to_string()
    } else {
        "DESCONECTADO (Sin vincular). Si el usuario pide leer o consultar correos de Gmail, DEBES explicarle amablemente que para acceder a su correo primero debe vincular su cuenta de Google desde la pestaña de 'Extensiones' en el menú de Enigma introduciendo su Client ID y Client Secret de Google Cloud.".to_string()
    };

    let tools_schema = serde_json::json!([
        {
            "type": "function",
            "function": {
                "name": "search_web",
                "description": "UTILIZAR SIEMPRE que el usuario pida buscar algo en su navegador, en internet o en Google (ej: 'busca en el navegador hola', 'busca en google cómo programar', 've a mi navegador y busca X').",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "query": { "type": "string", "description": "El término, texto o pregunta que se va a buscar en Google" }
                    },
                    "required": ["query"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "open_app",
                "description": "UTILIZAR para abrir o ejecutar cualquier aplicación en el sistema (ej: 'opera', 'spotify', 'discord', 'code', 'firefox', 'dolphin').",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "app_name": { "type": "string", "description": "Nombre de la aplicación a abrir" }
                    },
                    "required": ["app_name"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "close_app",
                "description": "UTILIZAR para cerrar o finalizar procesos de una aplicación activa en el sistema por su nombre (ej: 'discord', 'spotify', 'opera').",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "app_name": { "type": "string", "description": "Nombre de la aplicación a cerrar" }
                    },
                    "required": ["app_name"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "type_text",
                "description": "UTILIZAR para escribir texto simulando el teclado físico en la ventana activa actual.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "text": { "type": "string", "description": "Texto exacto a escribir con el teclado" }
                    },
                    "required": ["text"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "press_key",
                "description": "UTILIZAR para pulsar una tecla especial en el sistema (ej: 'Return', 'Enter', 'Tab', 'Escape', 'Super', 'Space', 'Backspace', 'F1'-'F12').",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "key": { "type": "string", "description": "Nombre de la tecla" }
                    },
                    "required": ["key"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "add_event",
                "description": "SOLO UTILIZAR cuando el usuario pide explícitamente CREAR, AÑADIR o PROGRAMAR un nuevo evento. PROHIBIDO usar esta herramienta para consultar, leer o comprobar la agenda.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "title": { "type": "string", "description": "Título o nombre del evento" },
                        "date": { "type": "string", "description": "Fecha del evento en formato ISO 8601 (YYYY-MM-DD)" },
                        "time": { "type": "string", "description": "Hora del evento en formato HH:MM" },
                        "notify_before": { "type": "integer", "description": "Minutos de antelación para notificar (ej: 15)" }
                    },
                    "required": ["title", "date"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "get_calendar_events",
                "description": "UTILIZAR SIEMPRE que el usuario pida leer, consultar, ver o saber qué hay en su agenda hoy. No requiere argumentos.",
                "parameters": {
                    "type": "object",
                    "properties": {}
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "send_whatsapp",
                "description": "UTILIZAR SIEMPRE que el usuario te pida explícitamente enviar, mandar o escribir un mensaje de WhatsApp a una persona o contacto. Requiere contact_name y message.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "contact_name": {
                            "type": "string",
                            "description": "Nombre de la persona o contacto (ej: 'Grigorii', 'Mamá', 'Papá') o número de teléfono"
                        },
                        "message": {
                            "type": "string",
                            "description": "El texto o contenido exacto del mensaje que se va a enviar por WhatsApp"
                        }
                    },
                    "required": ["contact_name", "message"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "get_recent_emails",
                "description": "UTILIZAR SIEMPRE que el usuario pida leer, consultar, revisar o ver sus correos electrónicos o emails de Gmail. Admite max_results opcional.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "max_results": { "type": "integer", "description": "Número máximo de correos a consultar (por defecto 5)" }
                    }
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "run_terminal",
                "description": "UTILIZAR para ejecutar comandos de bash/terminal en el sistema Linux (ej: 'ls -la', 'uname -a', 'df -h', 'uptime', etc.) y obtener la salida real de la consola.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "command": { "type": "string", "description": "Comando exacto de shell/terminal a ejecutar" }
                    },
                    "required": ["command"]
                }
            }
        }
    ]);

    let recent_chat_context = crate::memory::get_recent_context(8);

    let system_prompt = format!(
        r#"{core_identity}

{recent_context}

CONTEXTO TEMPORAL DEL SISTEMA: Hoy es {weekday}, {date} y son las {time}.

TOOL REGISTRY (DEFINICIONES ESTRICTAS DE HERRAMIENTAS):
- Herramienta `search_web`: UTILIZAR SIEMPRE que el usuario te pida buscar algo en su navegador, en internet o en Google (ej: 've a mi navegador y busca hola', 'busca en la barra de búsqueda X', 'busca en google X').
  Formato JSON: {{"tool": "search_web", "args": {{"query": "texto a buscar"}}}}
- Herramienta `run_terminal`: UTILIZAR para ejecutar comandos de shell o terminal en el sistema Linux de Santi (ej: 'ls', 'df -h', 'uptime', etc.).
  Formato JSON: {{"tool": "run_terminal", "args": {{"command": "comando bash"}}}}
- Herramienta `open_app`: UTILIZAR para abrir aplicaciones del sistema (ej: 'spotify', 'opera', 'discord', 'code', 'firefox').
  Formato JSON: {{"tool": "open_app", "args": {{"app_name": "spotify"}}}}
- Herramienta `close_app`: UTILIZAR para cerrar aplicaciones activas del sistema (ej: 'discord', 'spotify', 'opera').
  Formato JSON: {{"tool": "close_app", "args": {{"app_name": "discord"}}}}
- Herramienta `type_text`: UTILIZAR para escribir texto en la ventana activa con el teclado virtual.
  Formato JSON: {{"tool": "type_text", "args": {{"text": "hola mundo"}}}}
- Herramienta `press_key`: UTILIZAR para pulsar teclas especiales ('Return', 'Tab', 'Escape', 'Super', 'Space').
  Formato JSON: {{"tool": "press_key", "args": {{"key": "Return"}}}}
- Herramienta `add_event`: SOLO UTILIZAR cuando el usuario pide explícitamente CREAR, AÑADIR o PROGRAMAR un nuevo evento. PROHIBIDO usar esta herramienta para consultar, leer o comprobar la agenda.
  Formato JSON: {{"tool": "add_event", "args": {{"title": "Nombre", "date": "YYYY-MM-DD", "time": "HH:MM", "notify_before": 15}}}}
- Herramienta `get_calendar_events`: UTILIZAR SIEMPRE que el usuario pida leer, consultar, ver o saber qué hay en su agenda hoy. No requiere argumentos.
  Formato JSON: {{"tool": "get_calendar_events", "args": {{}}}}
- Herramienta `send_whatsapp`: UTILIZAR SIEMPRE que el usuario te pida enviar, mandar o escribir un mensaje de WhatsApp a alguien.
  Argumentos requeridos: `contact_name` (nombre del contacto o número telefónico) y `message` (el texto exacto del mensaje).
  Formato JSON: {{"tool": "send_whatsapp", "args": {{"contact_name": "Grigorii", "message": "Texto del mensaje"}}}}
- Herramienta `get_recent_emails`: UTILIZAR SIEMPRE que el usuario te pida leer, consultar, revisar o ver sus correos electrónicos o emails de Gmail.
  Formato JSON: {{"tool": "get_recent_emails", "args": {{"max_results": 5}}}}

ESTADO DE INTEGRACIONES EXTERNAS (GOOGLE WORKSPACE):
{google_status}

ESTADO ACTUAL DE LA BASE DE DATOS LOCAL (Resultado de get_calendar_events):
{calendar_status}

DIRECTIVAS ESTRICTAS DE SISTEMA OPERATIVO, NAVEGADOR, WHATSAPP Y COMUNICACIÓN (MODO JARVIS):
1. REGLA CRÍTICA DE CONTROL DEL SISTEMA Y NAVEGADOR: Enigma SÍ TIENE control total sobre el sistema operativo Linux de Santi, su terminal y su navegador web Opera. NUNCA digas que no puedes acceder a la terminal, a su navegador o al sistema. Si el usuario te pide ejecutar algo en la terminal, invoca `run_terminal`. Si te pide buscar en su navegador, invoca `search_web`. Si te pide abrir una app, invoca `open_app`. Si te pide cerrar una app, invoca `close_app`.
2. REGLA CRÍTICA DE GMAIL: Enigma SÍ TIENE integración oficial con Gmail API mediante Google OAuth 2.0. NUNCA digas que no puedes leer correos, que es imposible o que eres un asistente sin acceso. Si Google Workspace está CONECTADO y el usuario pide ver o leer correos ("lee mis correos", "tengo emails"), invoca la herramienta `get_recent_emails`.
3. REGLA CRÍTICA DE AGENDA: Si el usuario te pide leer su agenda y la herramienta `get_calendar_events` devuelve un array vacío ([]), DEBES responder exactamente que no tiene nada programado. BAJO NINGÚN CONCEPTO puedes invocar `add_event` para inventar datos falsos.
4. COMUNICACIÓN VERBAL OBLIGATORIA: Toda respuesta tuya DEBE incluir una explicación hablada completa y directa para Santi. NUNCA devuelvas únicamente un bloque JSON sin texto explicativo.
5. WHATSAPP TOOL CALLING: Cuando el usuario te pida enviar un mensaje de WhatsApp (ej: "envía un whatsapp a Grigorii que voy en camino"), DEBES generar el bloque JSON de la herramienta `send_whatsapp`.

REGLAS DE ORO:
1. Nunca respondas con frases vacías, cortantes o inconexas.
2. Si el usuario te saluda ('hola'), respóndele con una pulla sarcástica pero coherente.
3. Habla SIEMPRE en español de España de forma natural y fluida. Nunca reveles que eres un modelo de lenguaje."#,
        core_identity = crate::memory::ENIGMA_SYSTEM_PROMPT,
        recent_context = recent_chat_context,
        weekday = weekday_es,
        date = current_date,
        time = current_time,
        google_status = google_workspace_summary,
        calendar_status = calendar_status_summary
    );

    let body = serde_json::json!({
        "model": "deepseek-r1:14b",
        "system": system_prompt,
        "prompt": prompt,
        "stream": true,
        "tools": tools_schema
    });

    let res = client
        .post("http://localhost:11434/api/generate")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Failed to connect to Ollama (http://localhost:11434): {}", e))?;

    if !res.status().is_success() {
        let status = res.status();
        let body = res.text().await.unwrap_or_default();
        return Err(format!("Ollama HTTP {}: {}", status, body));
    }

    let mut stream = res.bytes_stream();
    let mut buffer = String::new();
    let mut sentence_accumulator = String::new();
    let mut full_response = String::new();
    let mut in_think = false;
    let mut tool_called = false;

    while let Some(chunk_result) = stream.next().await {
        match chunk_result {
            Ok(bytes) => {
                if let Ok(text) = std::str::from_utf8(&bytes) {
                    buffer.push_str(text);
                    while let Some(newline_pos) = buffer.find('\n') {
                        let line = buffer[..newline_pos].trim().to_string();
                        buffer.drain(..=newline_pos);
                        if !line.is_empty() {
                            if let Ok(val) = serde_json::from_str::<Value>(&line) {
                                if let Some(token) = val.get("response").and_then(|r| r.as_str()) {
                                    if !token.is_empty() {
                                        full_response.push_str(token);
                                        let _ = app.emit("enigma-token", token.to_string());
                                        // Acumula y procesa frases en paralelo con Piper TTS
                                        process_token_for_speech(token, &mut sentence_accumulator, &mut in_think);

                                        // Si ya se ha recibido el bloque JSON completo de una herramienta, ejecutarla al vuelo
                                        if !tool_called && full_response.contains('}') && (
                                            full_response.contains("send_whatsapp")
                                            || full_response.contains("add_event")
                                            || full_response.contains("get_calendar_events")
                                            || full_response.contains("get_recent_emails")
                                        ) {
                                            if execute_tool_calls_if_any(&app, &prompt, &full_response) {
                                                tool_called = true;
                                            }
                                        }
                                    }
                                }
                                if val.get("done").and_then(|d| d.as_bool()).unwrap_or(false) {
                                    flush_remaining_speech(&mut sentence_accumulator, in_think);
                                    if !tool_called {
                                        execute_tool_calls_if_any(&app, &prompt, &full_response);
                                        tool_called = true;
                                    }
                                    eprintln!("[invoke_enigma] Stream finished. full_response: {}", full_response);
                                    let _ = app.emit("enigma-done", ());
                                }
                            }
                        }
                    }
                }
            }
            Err(e) => {
                let err_msg = format!("Streaming error: {}", e);
                let _ = app.emit("enigma-error", err_msg.clone());
                return Err(err_msg);
            }
        }
    }

    // Drain any remaining buffer
    let remaining = buffer.trim();
    if !remaining.is_empty() {
        if let Ok(val) = serde_json::from_str::<Value>(remaining) {
            if let Some(token) = val.get("response").and_then(|r| r.as_str()) {
                if !token.is_empty() {
                    full_response.push_str(token);
                    let _ = app.emit("enigma-token", token.to_string());
                    process_token_for_speech(token, &mut sentence_accumulator, &mut in_think);
                }
            }
        }
    }

    flush_remaining_speech(&mut sentence_accumulator, in_think);
    if !tool_called {
        execute_tool_calls_if_any(&app, &prompt, &full_response);
    }

    // Guardar respuesta de Enigma en la memoria a corto plazo
    let clean_assistant_response = full_response
        .split("</think>")
        .last()
        .unwrap_or(&full_response)
        .trim();
    if !clean_assistant_response.is_empty() {
        let _ = crate::memory::save_message("assistant", clean_assistant_response);
    }

    let _ = app.emit("enigma-done", ());
    Ok(())
}


