//! Clipboard Intelligence Module for Enigma & Dynamic Notch (`clipboard.rs`)
//!
//! Provides native read, write, and real-time monitoring of the system clipboard
//! using pure Wayland protocols (`arboard` with `wayland-data-control`) and fallbacks:
//! 1. Smart Heuristic Classifier: Color, Code, URL, Image, Text
//! 2. Persistent storage in SQLite `clipboard_history`
//! 3. Real-time background watcher thread emitting `clipboard_copied` to the Notch
//! 4. Tauri commands for UI interaction

use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::io::Write;
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

static IN_MEMORY_CLIPBOARD: Mutex<String> = Mutex::new(String::new());

/// Clasifica el contenido del portapapeles según su sintaxis y estructura
pub fn classify_content(text: &str) -> (String, String, String) {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return ("text".to_string(), "".to_string(), "0 caracteres".to_string());
    }

    // Limpieza preliminar de comillas circundantes o signos de puntuación de código
    let stripped = trimmed
        .trim_matches(|c| c == '\'' || c == '"' || c == '`' || c == ';' || c == ',' || c == '<' || c == '>');

    // 1. Color Hexadecimal o Funcional (RGB, RGBA, HSL, HSLA)
    let is_hex_with_hash = stripped.starts_with('#')
        && (stripped.len() == 4 || stripped.len() == 5 || stripped.len() == 7 || stripped.len() == 9)
        && stripped[1..].chars().all(|c| c.is_ascii_hexdigit());

    let is_hex_no_hash = (stripped.len() == 6 || stripped.len() == 8)
        && stripped.chars().all(|c| c.is_ascii_hexdigit())
        && !stripped.chars().all(|c| c.is_ascii_digit()); // Evitar números puros como 123456

    let is_func_color = (stripped.starts_with("rgb(") && stripped.ends_with(')'))
        || (stripped.starts_with("rgba(") && stripped.ends_with(')'))
        || (stripped.starts_with("hsl(") && stripped.ends_with(')'))
        || (stripped.starts_with("hsla(") && stripped.ends_with(')'));

    if is_hex_with_hash || is_func_color {
        return ("color".to_string(), stripped.to_string(), "Color".to_string());
    }
    if is_hex_no_hash {
        return ("color".to_string(), format!("#{}", stripped), "Color Hex".to_string());
    }

    // 2. Enlaces Web (URLs con o sin protocolo http/https)
    if stripped.starts_with("http://") || stripped.starts_with("https://") || stripped.starts_with("ftp://") {
        let clean_proto = stripped.split("://").nth(1).unwrap_or(stripped);
        let domain = clean_proto.split('/').next().unwrap_or(clean_proto).split('?').next().unwrap_or(clean_proto);
        let preview = if stripped.chars().count() > 50 {
            let tr: String = stripped.chars().take(47).collect();
            format!("{}...", tr)
        } else {
            stripped.to_string()
        };
        return ("url".to_string(), preview, domain.to_string());
    }

    let host_candidate = stripped.split('/').next().unwrap_or(stripped).split('?').next().unwrap_or(stripped);
    let common_tlds = [
        ".com", ".org", ".net", ".io", ".dev", ".es", ".app", ".ai", ".co", ".me",
        ".info", ".xyz", ".cc", ".to", ".sh", ".so", ".tech", ".store", ".online", ".site", ".cloud"
    ];
    let host_has_tld = common_tlds.iter().any(|tld| host_candidate.ends_with(tld));
    if stripped.starts_with("www.") || (host_candidate.contains('.') && !stripped.contains(' ') && host_has_tld) {
        let domain = host_candidate;
        let preview = if stripped.chars().count() > 50 {
            let tr: String = stripped.chars().take(47).collect();
            format!("{}...", tr)
        } else {
            stripped.to_string()
        };
        return ("url".to_string(), preview, domain.to_string());
    }

    // 3. Código y Sintaxis de Programación (Detecta fn, const, function, SQL, llaves, etc.)
    let lines: Vec<&str> = text.lines().collect();
    let lower_text = text.to_lowercase();
    let code_tokens = [
        "fn ", "function", "const ", "let ", "var ", "def ", "class ", "import ", "export ",
        "return ", "public ", "private ", "console.", "println!", "<div", "<span", "</",
        "=>", "->", "curl ", "docker ", "npm ", "cargo ", "git ",
        "sudo ", "interface ", "type ", "struct ", "impl ", "enum ", "async ", "await ",
        "#[", "//", "/*", "*/", "package ", "use ", "system.out", "echo ",
        "printf", "grep ", "cat ", "chmod ", "chown ", "kill ", "ssh ",
    ];
    let sql_tokens = [
        "select ", "from ", "where ", "insert into", "update ", "delete from",
        "create table", "alter table", "drop table", "group by", "order by"
    ];
    let has_code_token = code_tokens.iter().any(|k| lower_text.contains(k));
    let has_sql_token = sql_tokens.iter().any(|k| lower_text.contains(k));
    let has_code_symbols = (text.contains('{') && text.contains('}'))
        || text.contains("();")
        || text.contains("=>")
        || text.contains("==")
        || text.contains("!=");
    let is_json = (stripped.starts_with('{') && stripped.ends_with('}'))
        || (stripped.starts_with('[') && stripped.ends_with(']'));

    if has_code_token || has_sql_token || has_code_symbols || is_json {
        let first_meaningful = lines.iter().find(|l| !l.trim().is_empty()).unwrap_or(&"");
        let first_trim = first_meaningful.trim();
        let preview = if first_trim.chars().count() > 50 {
            let tr: String = first_trim.chars().take(47).collect();
            format!("{}...", tr)
        } else {
            first_trim.to_string()
        };
        let line_count = lines.len();
        let meta = if line_count <= 1 {
            "1 línea".to_string()
        } else {
            format!("{} líneas", line_count)
        };
        return ("code".to_string(), preview, meta);
    }

    // 4. Texto General
    let char_count = text.chars().count();
    let first_line = text.lines().next().unwrap_or(text).trim();
    let preview = if first_line.chars().count() > 45 {
        let tr: String = first_line.chars().take(42).collect();
        format!("{}...", tr)
    } else {
        first_line.to_string()
    };
    let meta = if char_count == 1 {
        "1 caracter".to_string()
    } else {
        format!("{} caracteres", char_count)
    };
    ("text".to_string(), preview, meta)
}

/// Reads the current text content from the system clipboard
#[tauri::command]
pub fn get_clipboard_content() -> Result<String, String> {
    // 1. Primary: arboard nativo Wayland / X11
    if let Ok(mut clip) = arboard::Clipboard::new() {
        if let Ok(text) = clip.get_text() {
            if !text.is_empty() {
                if let Ok(mut lock) = IN_MEMORY_CLIPBOARD.lock() {
                    *lock = text.clone();
                }
                return Ok(text);
            }
        }
    }

    // 2. KDE Plasma 6 Klipper via qdbus6
    if let Ok(output) = Command::new("qdbus6")
        .args(["org.kde.klipper", "/klipper", "org.kde.klipper.klipper.getClipboardContents"])
        .output()
    {
        if output.status.success() {
            let text = String::from_utf8_lossy(&output.stdout).to_string();
            if !text.is_empty() {
                if let Ok(mut lock) = IN_MEMORY_CLIPBOARD.lock() {
                    *lock = text.clone();
                }
                return Ok(text);
            }
        }
    }

    // 3. In-memory fallback
    if let Ok(lock) = IN_MEMORY_CLIPBOARD.lock() {
        if !lock.is_empty() {
            return Ok(lock.clone());
        }
    }

    Err("No se pudo leer el portapapeles del sistema.".to_string())
}

pub fn copy_raw_png_to_clipboard(raw_png: &[u8]) -> Result<(), String> {
    let mut clip_success = false;

    // 1. arboard set_image
    if let Ok(dyn_img) = image::load_from_memory(raw_png) {
        let rgba = dyn_img.to_rgba8();
        if let Ok(mut clip) = arboard::Clipboard::new() {
            let img_data = arboard::ImageData {
                width: rgba.width() as usize,
                height: rgba.height() as usize,
                bytes: std::borrow::Cow::Borrowed(rgba.as_raw()),
            };
            if clip.set_image(img_data).is_ok() {
                clip_success = true;
            }
        }
    }

    // 2. wl-copy fallback para Wayland
    if let Ok(mut child) = Command::new("wl-copy")
        .arg("-t")
        .arg("image/png")
        .stdin(Stdio::piped())
        .spawn()
    {
        if let Some(mut stdin) = child.stdin.take() {
            let _ = stdin.write_all(raw_png);
        }
        let _ = child.wait();
        clip_success = true;
    }

    if clip_success {
        Ok(())
    } else {
        Err("No se pudo copiar la imagen al portapapeles".to_string())
    }
}

/// Sets text or image into the system clipboard
#[tauri::command]
pub fn copy_to_clipboard(text: String) -> Result<String, String> {
    if text.is_empty() {
        return Err("El contenido para copiar no puede estar vacío.".to_string());
    }

    // 0. Si el contenido es una imagen en base64 data URI
    if let Some(b64_part) = text.strip_prefix("data:image/png;base64,") {
        use base64::Engine;
        if let Ok(raw_png) = base64::engine::general_purpose::STANDARD.decode(b64_part) {
            copy_raw_png_to_clipboard(&raw_png)?;
            return Ok("Imagen copiada al portapapeles del sistema".to_string());
        }
    }
    if let Some(b64_part) = text.strip_prefix("data:image/jpeg;base64,") {
        use base64::Engine;
        if let Ok(raw_jpeg) = base64::engine::general_purpose::STANDARD.decode(b64_part) {
            copy_raw_png_to_clipboard(&raw_jpeg)?;
            return Ok("Imagen copiada al portapapeles del sistema".to_string());
        }
    }

    let mut success = false;

    // 1. Primary: arboard nativo
    if let Ok(mut clip) = arboard::Clipboard::new() {
        if clip.set_text(text.clone()).is_ok() {
            success = true;
        }
    }

    // 2. Secondary: Klipper via qdbus6
    if let Ok(output) = Command::new("qdbus6")
        .args(["org.kde.klipper", "/klipper", "org.kde.klipper.klipper.setClipboardContents", &text])
        .output()
    {
        if output.status.success() {
            success = true;
        }
    }

    // 3. Fallback: wl-copy si está disponible
    if let Ok(mut child) = Command::new("wl-copy")
        .stdin(Stdio::piped())
        .spawn()
    {
        if let Some(mut stdin) = child.stdin.take() {
            let _ = stdin.write_all(text.as_bytes());
        }
        let _ = child.wait();
        success = true;
    }

    // Always update in-memory
    if let Ok(mut lock) = IN_MEMORY_CLIPBOARD.lock() {
        *lock = text.clone();
        success = true;
    }

    if success {
        Ok(format!("Texto copiado al portapapeles ({} caracteres)", text.chars().count()))
    } else {
        Err("No se pudo copiar al portapapeles del sistema.".to_string())
    }
}

/// Copies an existing item from the clipboard history directly by ID without IPC payload overhead
#[tauri::command]
pub fn copy_clipboard_item(id: i64) -> Result<String, String> {
    let record = crate::db::db_get_clipboard_item(id).map_err(|e| e.to_string())?;

    if record.content_type == "image" {
        let mut cache_path = crate::db::get_db_path();
        cache_path.pop();
        cache_path.push("clipboard_cache");
        cache_path.push(format!("{}.png", id));

        if cache_path.exists() {
            if let Ok(raw_png) = std::fs::read(&cache_path) {
                copy_raw_png_to_clipboard(&raw_png)?;
                return Ok("Imagen copiada al portapapeles".to_string());
            }
        }

        if let Some(b64_part) = record.full_content.strip_prefix("data:image/png;base64,") {
            use base64::Engine;
            if let Ok(raw_png) = base64::engine::general_purpose::STANDARD.decode(b64_part) {
                copy_raw_png_to_clipboard(&raw_png)?;
                return Ok("Imagen copiada al portapapeles".to_string());
            }
        }
        if let Some(b64_part) = record.full_content.strip_prefix("data:image/jpeg;base64,") {
            use base64::Engine;
            if let Ok(raw_jpeg) = base64::engine::general_purpose::STANDARD.decode(b64_part) {
                copy_raw_png_to_clipboard(&raw_jpeg)?;
                return Ok("Imagen copiada al portapapeles".to_string());
            }
        }
    }

    copy_to_clipboard(record.full_content)
}

/// Starts the real-time background clipboard monitoring thread
pub fn start_clipboard_monitor(app_handle: AppHandle) {
    std::thread::spawn(move || {
        let mut clip = match arboard::Clipboard::new() {
            Ok(c) => c,
            Err(e) => {
                eprintln!("[ClipboardMonitor] No se pudo inicializar arboard: {:?}", e);
                return;
            }
        };

        eprintln!("[ClipboardMonitor] Monitor de portapapeles Wayland iniciado.");

        let mut last_text_hash: u64 = 0;
        let mut last_image_hash: u64 = 0;

        // Inicializar últimos hashes con el contenido actual para no disparar al arrancar
        if let Ok(initial_text) = clip.get_text() {
            let mut hasher = DefaultHasher::new();
            initial_text.hash(&mut hasher);
            last_text_hash = hasher.finish();
        }
        if let Ok(initial_img) = clip.get_image() {
            let mut hasher = DefaultHasher::new();
            (initial_img.width, initial_img.height, initial_img.bytes.len()).hash(&mut hasher);
            if !initial_img.bytes.is_empty() {
                let sample_size = initial_img.bytes.len().min(256);
                initial_img.bytes[..sample_size].hash(&mut hasher);
            }
            last_image_hash = hasher.finish();
        }

        let mut loop_tick: u32 = 0;
        loop {
            std::thread::sleep(Duration::from_millis(400));
            loop_tick = loop_tick.wrapping_add(1);

            // 1. Monitorear texto
            let mut text_changed = false;
            if let Ok(text) = clip.get_text() {
                if !text.is_empty() {
                    let mut hasher = DefaultHasher::new();
                    text.hash(&mut hasher);
                    let current_hash = hasher.finish();

                    if current_hash != last_text_hash {
                        last_text_hash = current_hash;
                        last_image_hash = 0; // Reset imagen para permitir re-detección
                        text_changed = true;
                        let (content_type, preview, meta_info) = classify_content(&text);

                        // Guardar en SQLite
                        if let Ok(record) = crate::db::db_insert_clipboard(
                            &content_type,
                            &preview,
                            &text,
                            &meta_info,
                        ) {
                            eprintln!(
                                "[ClipboardMonitor] 📋 Nuevo item copiado [{}]: '{}' ({})",
                                content_type, preview, meta_info
                            );
                            let _ = app_handle.emit("clipboard_copied", &record);
                        }
                    }
                }
            }

            // 2. Monitorear imágenes cada 3 ticks (~1.2s) para no saturar el canal Wayland IPC de KWin/Klipper
            if !text_changed && (loop_tick % 3 == 0) {
                if let Ok(img) = clip.get_image() {
                    let mut hasher = DefaultHasher::new();
                    (img.width, img.height, img.bytes.len()).hash(&mut hasher);
                    if !img.bytes.is_empty() {
                        let sample_size = img.bytes.len().min(256);
                        img.bytes[..sample_size].hash(&mut hasher);
                    }
                    let current_img_hash = hasher.finish();

                    if current_img_hash != last_image_hash {
                        last_image_hash = current_img_hash;
                        last_text_hash = 0; // Reset texto para permitir re-detección
                        let meta_info = format!("{}×{} px", img.width, img.height);
                        let preview = format!("Imagen {}", meta_info);

                        if let Some(rgba) = image::RgbaImage::from_raw(img.width as u32, img.height as u32, img.bytes.to_vec()) {
                            use base64::Engine;
                            // Generar thumbnail compacto de máximo 280x200 para la base de datos y UI fluida
                            let thumb = if img.width > 280 || img.height > 200 {
                                let (w, h) = if img.width as f32 / 280.0 > img.height as f32 / 200.0 {
                                    (280, ((280.0 * img.height as f32 / img.width as f32) as u32).max(1))
                                } else {
                                    (((200.0 * img.width as f32 / img.height as f32) as u32).max(1), 200)
                                };
                                image::imageops::resize(&rgba, w, h, image::imageops::FilterType::Triangle)
                            } else {
                                rgba.clone()
                            };

                            let mut thumb_bytes: Vec<u8> = Vec::new();
                            let mut cursor = std::io::Cursor::new(&mut thumb_bytes);
                            let data_uri = if thumb.write_to(&mut cursor, image::ImageFormat::Png).is_ok() {
                                let b64 = base64::engine::general_purpose::STANDARD.encode(&thumb_bytes);
                                format!("data:image/png;base64,{}", b64)
                            } else {
                                format!("[Imagen: {}]", meta_info)
                            };

                            if let Ok(record) = crate::db::db_insert_clipboard(
                                "image",
                                &preview,
                                &data_uri,
                                &meta_info,
                            ) {
                                // Guardar el archivo PNG original en alta resolución en ~/.local/share/enigma/clipboard_cache/<id>.png
                                let mut cache_dir = crate::db::get_db_path();
                                cache_dir.pop();
                                cache_dir.push("clipboard_cache");
                                let _ = std::fs::create_dir_all(&cache_dir);
                                let file_path = cache_dir.join(format!("{}.png", record.id));
                                let _ = rgba.save(&file_path);

                                eprintln!("[ClipboardMonitor] 🖼️ Nueva imagen capturada (thumb: {} KB): {}", thumb_bytes.len() / 1024, meta_info);
                                let _ = app_handle.emit("clipboard_copied", &record);
                            }
                        }
                    }
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_classify_content_color() {
        let (typ, prev, meta) = classify_content("#b82a2a");
        assert_eq!(typ, "color");
        assert_eq!(prev, "#b82a2a");
        assert_eq!(meta, "Color");

        let (typ_no_hash, prev_no_hash, _) = classify_content("b82a2a;");
        assert_eq!(typ_no_hash, "color");
        assert_eq!(prev_no_hash, "#b82a2a");

        let (typ_rgba, prev_rgba, _) = classify_content("rgba(184, 42, 42, 0.8)");
        assert_eq!(typ_rgba, "color");
        assert_eq!(prev_rgba, "rgba(184, 42, 42, 0.8)");
    }

    #[test]
    fn test_classify_content_url() {
        let (typ, _, domain) = classify_content("https://github.com/tauri-apps/tauri");
        assert_eq!(typ, "url");
        assert_eq!(domain, "github.com");

        let (typ_plain, _, domain_plain) = classify_content("github.com/tauri-apps/tauri");
        assert_eq!(typ_plain, "url");
        assert_eq!(domain_plain, "github.com");
    }

    #[test]
    fn test_classify_content_code() {
        let code_sample = "fn main() {\n    println!(\"Hello\");\n}";
        let (typ, _, meta) = classify_content(code_sample);
        assert_eq!(typ, "code");
        assert_eq!(meta, "3 líneas");

        let single_line = "const activeIndex = 0;";
        let (typ_single, _, meta_single) = classify_content(single_line);
        assert_eq!(typ_single, "code");
        assert_eq!(meta_single, "1 línea");

        let sql_sample = "select id, name from users where active = 1;";
        let (typ_sql, _, _) = classify_content(sql_sample);
        assert_eq!(typ_sql, "code");
    }

    #[test]
    fn test_classify_content_text() {
        let text_sample = "Hola esto es un texto simple de prueba.";
        let (typ, _, meta) = classify_content(text_sample);
        assert_eq!(typ, "text");
        assert!(meta.contains("39 caracteres"));
    }
}
