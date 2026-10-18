//! Vision Module for Enigma
//!
//! Real-time multimodal screen & active window perception via Ollama's vision models
//! (`gemma4:e4b`, `llava`, `llama3.2-vision`) and KDE Spectacle (Wayland/X11).

use base64::prelude::*;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::Path;
use std::process::Command;
use tauri::{Emitter, Manager};

/// Directiva de sistema estricta para el núcleo de visión de Enigma
#[allow(dead_code)]
pub const VISION_SYSTEM_PROMPT: &str = "Eres Enigma Vision, el núcleo de percepción visual y asistente de escritorio inteligente para Linux (KDE Plasma 6 Wayland). Tienes autorización para leer, analizar e interpretar la pantalla y ventanas del usuario. Describe lo que ves y responde directamente en español.";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VisionAnalysisResult {
    pub analysis: String,
    pub model_used: String,
    pub thumbnail_data_url: String,
    pub image_path: String,
    pub target_mode: String,
    pub window_title: String,
    pub window_class: String,
}

/// Oculta temporalmente todas las capas y ventanas de Enigma (Topbar, Launcher, Dock)
pub fn hide_enigma_windows() {
    if let Some(app) = crate::enigma::get_app_handle() {
        if let Some(main_win) = app.get_webview_window("main") {
            let _ = main_win.hide();
        }
        if let Some(dock_win) = app.get_webview_window("dock") {
            let _ = dock_win.hide();
        }
        let _ = app.emit("enigma-hide-overlay", ());
    }
}

/// Restaura la visibilidad de las capas y ventanas de Enigma tras la captura
pub fn show_enigma_windows() {
    if let Some(app) = crate::enigma::get_app_handle() {
        if let Some(main_win) = app.get_webview_window("main") {
            let _ = main_win.show();
        }
        if let Some(dock_win) = app.get_webview_window("dock") {
            let _ = dock_win.show();
        }
        let _ = app.emit("enigma-show-overlay", ());
    }
}

/// Takes a screenshot of either the active window or the full screen using KDE Spectacle.
/// Oculta automáticamente las ventanas de Enigma durante la captura para no salir en la foto.
pub fn capture_and_process_screen(mode: &str) -> Result<(String, String), String> {
    // 1. Ocultar temporalmente las ventanas de Enigma (Topbar, Launcher, Dock)
    hide_enigma_windows();

    // 2. Esperar 180ms para que el compositor Wayland limpie y renderice el frame limpio
    std::thread::sleep(std::time::Duration::from_millis(180));

    // 3. Tomar la captura limpia
    let res = capture_and_process_screen_inner(mode);

    // 4. Restaurar la visibilidad de las ventanas
    show_enigma_windows();

    res
}

fn capture_and_process_screen_inner(mode: &str) -> Result<(String, String), String> {
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let raw_png = format!("/tmp/enigma_vision_raw_{}.png", ts);
    let optimized_jpg = format!("/tmp/enigma_vision_{}.jpg", ts);
    let thumb_jpg = format!("/tmp/enigma_vision_thumb_{}.jpg", ts);
    let last_jpg = "/tmp/enigma_vision_last.jpg";

    let raw_png_path = Path::new(&raw_png);
    let optimized_jpg_path = Path::new(&optimized_jpg);
    let thumb_jpg_path = Path::new(&thumb_jpg);

    // 1. Ejecutar spectacle según el modo seleccionado
    let is_region = mode == "region" || mode == "area" || mode == "rect" || mode == "recorte";
    let is_window = mode == "active_window" || mode == "window" || mode == "ventana";
    let mut success = false;

    if is_region {
        eprintln!("[Vision] 📐 Capturando región rectangular interactiva con spectacle -r -b -k -n -o...");
        let status = Command::new("spectacle")
            .args(["-r", "-b", "-k", "-n", "-o", &raw_png])
            .status();

        if let Ok(st) = status {
            if st.success() && raw_png_path.exists() {
                if let Ok(meta) = std::fs::metadata(raw_png_path) {
                    if meta.len() > 0 {
                        success = true;
                    }
                }
            }
        }
    } else if is_window {
        eprintln!("[Vision] 🪟 Enfocando ventana del usuario antes de capturar...");
        let _ = crate::windows::focus_target_user_window();
        std::thread::sleep(std::time::Duration::from_millis(180));

        eprintln!("[Vision] 📸 Capturando ventana activa con spectacle -i -a...");
        let status = Command::new("spectacle")
            .args(["-i", "-a", "-b", "-n", "-o", &raw_png])
            .status();

        if let Ok(st) = status {
            if st.success() && raw_png_path.exists() {
                if let Ok(meta) = std::fs::metadata(raw_png_path) {
                    if meta.len() > 0 {
                        success = true;
                    }
                }
            }
        }
    }

    // Fallback al monitor actual si no se pudo capturar ventana activa o si el modo es pantalla completa
    if !success {
        eprintln!("[Vision] 📸 Capturando pantalla actual con spectacle -i -m...");
        let status = Command::new("spectacle")
            .args(["-i", "-m", "-b", "-n", "-o", &raw_png])
            .status()
            .map_err(|e| format!("Error al ejecutar spectacle: {}", e))?;

        if !status.success() {
            return Err(format!(
                "spectacle finalizó con código de error {:?}",
                status.code()
            ));
        }

        if !raw_png_path.exists() {
            return Err("No se encontró el archivo de captura tras ejecutar spectacle.".to_string());
        }
    }

    let raw_meta = std::fs::metadata(raw_png_path)
        .map_err(|e| format!("Error obteniendo metadatos de captura: {}", e))?;

    if raw_meta.len() == 0 {
        let _ = std::fs::remove_file(raw_png_path);
        return Err("La captura generada está vacía (0 bytes).".to_string());
    }

    // 2. Optimizar tamaño con ImageMagick si está disponible (resize 2048x para OCR nítido)
    let opt_status = Command::new("magick")
        .args([
            &raw_png,
            "-resize",
            "2048x>",
            "-quality",
            "90",
            &optimized_jpg,
        ])
        .status();

    let final_image_path = if opt_status.map(|s| s.success()).unwrap_or(false) && optimized_jpg_path.exists() {
        let _ = std::fs::copy(&optimized_jpg, last_jpg);
        optimized_jpg
    } else {
        // Fallback: renombrar raw_png si magick no está disponible
        let _ = std::fs::copy(raw_png_path, &optimized_jpg);
        let _ = std::fs::copy(raw_png_path, last_jpg);
        optimized_jpg
    };

    // 3. Crear miniatura ligera para la UI (640x max, quality 75)
    let _ = Command::new("magick")
        .args([
            &final_image_path,
            "-resize",
            "640x",
            "-quality",
            "75",
            &thumb_jpg,
        ])
        .status();

    let thumb_bytes = if thumb_jpg_path.exists() {
        std::fs::read(thumb_jpg_path).unwrap_or_default()
    } else {
        std::fs::read(&final_image_path).unwrap_or_default()
    };

    let thumbnail_data_url = if !thumb_bytes.is_empty() {
        format!("data:image/jpeg;base64,{}", BASE64_STANDARD.encode(&thumb_bytes))
    } else {
        String::new()
    };

    // Limpieza de temporales auxiliares
    let _ = std::fs::remove_file(raw_png_path);
    if thumb_jpg_path.exists() {
        let _ = std::fs::remove_file(thumb_jpg_path);
    }

    eprintln!(
        "[Vision] ✅ Captura procesada y guardada en {} (thumbnail data url length: {})",
        final_image_path,
        thumbnail_data_url.len()
    );

    Ok((final_image_path, thumbnail_data_url))
}

/// Resolves home directory paths (`~/...`) and URL schemes (`file://...`)
pub fn resolve_image_path(raw_path: &str) -> String {
    let clean = raw_path.trim();
    let without_scheme = clean.strip_prefix("file://").unwrap_or(clean);

    if without_scheme.starts_with("~/") {
        if let Some(home) = std::env::var_os("HOME") {
            let mut path = std::path::PathBuf::from(home);
            path.push(&without_scheme[2..]);
            return path.to_string_lossy().to_string();
        }
    }

    without_scheme.to_string()
}

async fn query_ollama_vision(
    client: &Client,
    model: &str,
    formatted_prompt: &str,
    base64_image: &str,
) -> Result<String, String> {
    let payload = serde_json::json!({
        "model": model,
        "prompt": formatted_prompt,
        "images": [base64_image],
        "stream": false,
        "options": {
            "temperature": 0.2,
            "num_predict": 4096
        }
    });

    let res = client
        .post("http://localhost:11434/api/generate")
        .json(&payload)
        .send()
        .await
        .map_err(|e| format!("Error conectando con Ollama ({}): {}", model, e))?;

    if !res.status().is_success() {
        let status = res.status();
        let err_text = res.text().await.unwrap_or_default();
        return Err(format!("Ollama HTTP {}: {}", status, err_text));
    }

    let json_resp: Value = res
        .json()
        .await
        .map_err(|e| format!("Error deserializando JSON de Ollama ({}): {}", model, e))?;

    // 1. Extraer campo principal 'response'
    if let Some(answer) = json_resp.get("response").and_then(|r| r.as_str()) {
        let trimmed = answer.trim();
        if !trimmed.is_empty() {
            return Ok(trimmed.to_string());
        }
    }

    // 2. Extraer campo alternativo 'thinking' si el modelo (ej. gemma4/deepseek) redactó en modo pensamiento
    if let Some(thinking) = json_resp.get("thinking").and_then(|t| t.as_str()) {
        let trimmed = thinking.trim();
        if !trimmed.is_empty() {
            return Ok(trimmed.to_string());
        }
    }

    Err(format!("Respuesta vacía de Ollama con modelo '{}'", model))
}

/// Ejecuta la inferencia de visión probando modelos en orden de precisión:
/// 1. `gemma4:e4b` (modelo de percepción y razonamiento multimodal de alta fidelidad)
/// 2. `llava` (fallback estándar ligero)
pub async fn execute_vision_inference(
    base64_image: &str,
    formatted_prompt: &str,
) -> Result<(String, String), String> {
    let client = Client::builder()
        .timeout(std::time::Duration::from_secs(90))
        .build()
        .map_err(|e| format!("Error configurando cliente HTTP: {}", e))?;

    let cfg = crate::models_config::load_model_config();
    let configured_vision = crate::models_config::resolve_or_fallback_model(&cfg.vision_model, "llava").await;
    let candidate_models = [
        configured_vision.as_str(),
        "llava:7b",
        "llava",
        "llama3.2-vision",
        "moondream",
    ];
    let mut last_err = String::new();

    for model in candidate_models {
        eprintln!("[Vision] Intentando inferencia multimodal con modelo '{}'...", model);
        match query_ollama_vision(&client, model, formatted_prompt, base64_image).await {
            Ok(ans) => {
                eprintln!("[Vision] Inferencia completada con éxito por '{}'", model);
                return Ok((ans, model.to_string()));
            }
            Err(err) => {
                eprintln!("[Vision] Falló modelo '{}': {}. Probando siguiente...", model, err);
                last_err = err;
            }
        }
    }

    Err(format!(
        "No se pudo completar el análisis visual con ningún modelo de Ollama. Último error: {}",
        last_err
    ))
}

/// Tauri command to capture the active screen or window and analyze it with vision models.
#[tauri::command]
pub async fn analyze_current_screen(
    prompt: Option<String>,
    mode: Option<String>,
) -> Result<VisionAnalysisResult, String> {
    let target_mode = mode.unwrap_or_else(|| "screen".to_string());
    let prompt_usuario = prompt
        .map(|p| p.trim().to_string())
        .filter(|p| !p.is_empty())
        .unwrap_or_else(|| {
            if target_mode == "active_window" {
                "Analiza la ventana activa en foco, dime qué código, aplicación o contenido muestra y cómo me asistes.".to_string()
            } else if target_mode == "region" || target_mode == "area" {
                "Analiza con detalle el contenido de este recorte de pantalla y dime qué contiene y cómo me asistes.".to_string()
            } else {
                "¿Qué ves en la pantalla actualmente y qué elementos o ventanas destacan?".to_string()
            }
        });

    // 1. Obtener contexto del escritorio y ventana activa de KDE Plasma
    let active_win = crate::windows::get_current_active_window();
    let desktop_ctx = crate::windows::get_active_desktop_context();

    // 2. Captura bloqueante con spectacle y optimización
    let mode_clone = target_mode.clone();
    let (image_path, thumbnail_data_url) = tokio::task::spawn_blocking(move || {
        capture_and_process_screen(&mode_clone)
    })
    .await
    .map_err(|e| format!("Error en el hilo de captura de pantalla: {}", e))??;

    // 3. Leer la imagen optimizada y convertir a Base64 para Ollama
    let image_bytes = tokio::fs::read(&image_path)
        .await
        .map_err(|e| format!("Error leyendo imagen optimizada: {}", e))?;

    if image_bytes.is_empty() {
        return Err("El archivo de imagen optimizada está vacío.".to_string());
    }

    let base64_image = BASE64_STANDARD.encode(&image_bytes);

    // 4. Formatear prompt especializado según el modo de captura
    let formatted_prompt = if target_mode == "active_window" {
        format!(
            "Eres Enigma Vision, el núcleo de percepción visual de escritorio para Linux KDE Plasma 6.\n\
            La imagen adjunta es una captura directa de la VENTANA ACTIVA en foco del usuario: '{}' (Clase: '{}').\n\n\
            Petición del usuario: {}\n\n\
            Instrucciones obligatorias:\n\
            1. Analiza con precisión EXCLUSIVAMENTE lo que se ve en la imagen adjunta.\n\
            2. Si es un editor de código o IDE (ej. Antigravity IDE / VS Code), identifica la aplicación, el archivo abierto, las pestañas y el lenguaje real (TypeScript, TSX, Rust, Python, etc.).\n\
            3. Lee las funciones, variables o código visible con exactitud y explica qué hace.\n\
            4. Si hay errores, terminales o registros visibles, explícalos de forma concisa y práctica en español.",
            if active_win.title.is_empty() { "Ventana de aplicación" } else { &active_win.title },
            if active_win.class.is_empty() { "app" } else { &active_win.class },
            prompt_usuario
        )
    } else {
        format!(
            "Eres Enigma Vision, el núcleo de percepción visual de escritorio para Linux KDE Plasma 6.\n\
            La imagen adjunta es una captura de la PANTALLA COMPLETA del usuario.\n\
            Ventana en foco principal: '{}' (Clase: '{}').\n\n\
            Contexto del escritorio:\n{}\n\n\
            Petición del usuario: {}\n\n\
            Instrucciones:\n\
            1. Describe con precisión las ventanas y aplicaciones visibles en la pantalla.\n\
            2. Si hay código o texto en pantalla, léelo y asiste al usuario.\n\
            3. Responde de forma clara y directa en español.",
            if active_win.title.is_empty() { "Escritorio" } else { &active_win.title },
            if active_win.class.is_empty() { "escritorio" } else { &active_win.class },
            desktop_ctx,
            prompt_usuario
        )
    };

    // 5. Inferencia multimodal con fallback
    let (analysis, model_used) = execute_vision_inference(&base64_image, &formatted_prompt).await?;

    Ok(VisionAnalysisResult {
        analysis,
        model_used,
        thumbnail_data_url,
        image_path,
        target_mode,
        window_title: active_win.title,
        window_class: active_win.class,
    })
}

/// Tauri command to take an on-demand screen or active window capture preview without LLM inference
#[tauri::command]
pub async fn capture_screen_preview(mode: Option<String>) -> Result<VisionAnalysisResult, String> {
    let target_mode = mode.unwrap_or_else(|| "screen".to_string());
    let active_win = crate::windows::get_current_active_window();

    let mode_clone = target_mode.clone();
    let (image_path, thumbnail_data_url) = tokio::task::spawn_blocking(move || {
        capture_and_process_screen(&mode_clone)
    })
    .await
    .map_err(|e| format!("Error en captura de vista previa: {}", e))??;

    Ok(VisionAnalysisResult {
        analysis: "Captura realizada con éxito.".to_string(),
        model_used: "KDE Spectacle".to_string(),
        thumbnail_data_url,
        image_path,
        target_mode,
        window_title: active_win.title,
        window_class: active_win.class,
    })
}

/// Tauri command to analyze an existing local image file using Ollama vision models
#[tauri::command]
pub async fn analyze_image(image_path: String, prompt: String) -> Result<String, String> {
    let resolved_path_str = resolve_image_path(&image_path);
    if resolved_path_str.is_empty() {
        return Err("La ruta de la imagen no puede estar vacía.".to_string());
    }

    let path = Path::new(&resolved_path_str);
    if !path.exists() {
        return Err(format!("El archivo de imagen no existe en la ruta: '{}'", resolved_path_str));
    }

    let metadata = std::fs::metadata(path)
        .map_err(|e| format!("Error obteniendo metadatos del archivo de imagen '{}': {}", resolved_path_str, e))?;

    if metadata.len() == 0 {
        return Err(format!("El archivo de imagen '{}' está vacío (0 bytes).", resolved_path_str));
    }

    let image_bytes = tokio::fs::read(&path)
        .await
        .map_err(|e| format!("Error leyendo el archivo de imagen '{}': {}", resolved_path_str, e))?;

    if image_bytes.is_empty() {
        return Err(format!("El archivo de imagen '{}' está vacío.", resolved_path_str));
    }

    let base64_image = BASE64_STANDARD.encode(&image_bytes);

    let prompt_usuario = if prompt.trim().is_empty() {
        "¿Qué ves en esta imagen?".to_string()
    } else {
        prompt.trim().to_string()
    };

    let formatted_prompt = format!(
        "Eres Enigma Vision. Analiza con precisión esta imagen y responde a la petición del usuario en español:\n\nPetición: {}",
        prompt_usuario
    );

    let (res, _) = execute_vision_inference(&base64_image, &formatted_prompt).await?;
    Ok(res)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_resolve_image_path() {
        assert_eq!(resolve_image_path("file:///tmp/screenshot.png"), "/tmp/screenshot.png");
        assert_eq!(resolve_image_path("/home/user/test.jpg"), "/home/user/test.jpg");
    }

    #[test]
    fn test_base64_payload_format() {
        let dummy_bytes = b"fake-png-data";
        let b64 = BASE64_STANDARD.encode(dummy_bytes);
        assert_eq!(b64, "ZmFrZS1wbmctZGF0YQ==");
    }
}
