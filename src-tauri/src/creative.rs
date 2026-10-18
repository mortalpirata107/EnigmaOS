//! Creative Module for Enigma
//!
//! Local Image Generation via Stable Diffusion WebUI API (Automatic1111 / Comfy / SD.Next).
//! Performs asynchronous POST requests to `http://localhost:7860/sdapi/v1/txt2img`,
//! decodes the Base64 output, saves the image as a .png in the OS temporary directory,
//! and returns the absolute file path.

use base64::prelude::*;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Serialize)]
pub struct Txt2ImgRequest {
    pub prompt: String,
    pub steps: u32,
    pub width: u32,
    pub height: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub negative_prompt: Option<String>,
}

#[derive(Deserialize)]
struct Txt2ImgResponse {
    #[serde(default)]
    images: Vec<String>,
}

/// Helper to decode a base64 string (with optional data:image/png prefix) and save it to a temp png file.
pub fn save_base64_to_temp_png(raw_b64: &str, prefix: &str) -> Result<String, String> {
    let clean_b64 = if let Some(comma_idx) = raw_b64.find(',') {
        &raw_b64[comma_idx + 1..]
    } else {
        raw_b64
    };

    let image_bytes = BASE64_STANDARD
        .decode(clean_b64.trim())
        .map_err(|e| format!("Error al decodificar la imagen Base64: {}", e))?;

    if image_bytes.is_empty() {
        return Err("Los bytes de la imagen generada están vacíos.".to_string());
    }

    let timestamp = chrono::Local::now().format("%Y%m%d_%H%M%S_%3f");
    let filename = format!("{}_{}.png", prefix, timestamp);
    let temp_dir = std::env::temp_dir();
    let file_path: PathBuf = temp_dir.join(&filename);

    std::fs::write(&file_path, &image_bytes)
        .map_err(|e| format!("Error guardando la imagen en '{}': {}", file_path.display(), e))?;

    let abs_path = file_path
        .canonicalize()
        .unwrap_or(file_path)
        .to_string_lossy()
        .to_string();

    Ok(abs_path)
}

/// Tauri command to generate an image from a descriptive prompt using the local Stable Diffusion API.
///
/// Returns the absolute path of the generated .png file saved in a safe temporary directory.
#[tauri::command]
pub async fn generate_image(prompt: String) -> Result<String, String> {
    let clean_prompt = prompt.trim();
    if clean_prompt.is_empty() {
        return Err("La descripción (prompt) para generar la imagen no puede estar vacía.".to_string());
    }

    let payload = Txt2ImgRequest {
        prompt: clean_prompt.to_string(),
        steps: 25,
        width: 512,
        height: 512,
        negative_prompt: Some("blurry, low quality, distorted, extra limbs, artifacts, watermark".to_string()),
    };

    let client = Client::builder()
        .timeout(std::time::Duration::from_secs(180))
        .build()
        .map_err(|e| format!("Error creando cliente HTTP para Stable Diffusion: {}", e))?;

    let res = client
        .post("http://localhost:7860/sdapi/v1/txt2img")
        .json(&payload)
        .send()
        .await
        .map_err(|e| {
            format!(
                "Error conectando con la API local de Stable Diffusion (http://localhost:7860/sdapi/v1/txt2img): {}. Asegúrate de que Stable Diffusion WebUI esté iniciado con el parámetro --api.",
                e
            )
        })?;

    if !res.status().is_success() {
        let status = res.status();
        let err_text = res.text().await.unwrap_or_default();
        return Err(format!(
            "La API de Stable Diffusion devolvió error HTTP {}: {}",
            status, err_text
        ));
    }

    let response_data: Txt2ImgResponse = res
        .json()
        .await
        .map_err(|e| format!("Error al deserializar la respuesta de Stable Diffusion: {}", e))?;

    if response_data.images.is_empty() {
        return Err("Stable Diffusion no devolvió ninguna imagen en la respuesta.".to_string());
    }

    let abs_path = save_base64_to_temp_png(&response_data.images[0], "enigma_creative")?;
    eprintln!("[Creative] 🎨 Imagen generada y guardada con éxito en: {}", abs_path);

    Ok(abs_path)
}

/// Helper Tauri command to load a local image as a Base64 data URL for webview rendering
#[tauri::command]
pub async fn load_image_asset(file_path: String) -> Result<String, String> {
    let path = std::path::Path::new(&file_path);
    if !path.exists() {
        return Err(format!("El archivo no existe: {}", file_path));
    }

    let bytes = tokio::fs::read(path)
        .await
        .map_err(|e| format!("Error leyendo archivo de imagen: {}", e))?;

    let b64 = BASE64_STANDARD.encode(&bytes);
    Ok(format!("data:image/png;base64,{}", b64))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_save_base64_to_temp_png() {
        let dummy_png_bytes = b"fake-png-image-binary-stream";
        let b64 = BASE64_STANDARD.encode(dummy_png_bytes);
        let saved_path = save_base64_to_temp_png(&b64, "test_creative").expect("should save temp image");
        
        let path = std::path::Path::new(&saved_path);
        assert!(path.exists());
        let read_bytes = std::fs::read(path).unwrap();
        assert_eq!(read_bytes, dummy_png_bytes);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn test_txt2img_request_serialization() {
        let req = Txt2ImgRequest {
            prompt: "a majestic golden eagle".to_string(),
            steps: 20,
            width: 512,
            height: 512,
            negative_prompt: None,
        };
        let val = serde_json::to_value(&req).unwrap();
        assert_eq!(val["prompt"], "a majestic golden eagle");
        assert_eq!(val["steps"], 20);
        assert_eq!(val["width"], 512);
        assert_eq!(val["height"], 512);
        assert!(val.get("negative_prompt").is_none());
    }
}
