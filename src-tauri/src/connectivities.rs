//! Enigma Connectivities Module (`enigma_connect`)
//!
//! Linux system environment and hardware bridge:
//! - Multimedia control via MPRIS DBus (`org.mpris.MediaPlayer2.*`)
//! - PulseAudio / PipeWire audio volume control & auto-ducking (`pactl` / `wpctl`)
//! - Live Web Search using DuckDuckGo HTML Lite (asynchronous `reqwest`)
//! - Desktop bridge (native notifications, power status)

use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::process::Command;
use std::sync::Mutex;
use std::time::Duration;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MediaPlaybackStatus {
    pub player: String,
    pub status: String,
    pub title: Option<String>,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub art_url: Option<String>,
}

impl std::fmt::Display for MediaPlaybackStatus {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "- **Reproductor**: {}\n- **Estado**: {}\n- **Título**: {}\n- **Artista**: {}\n- **Álbum**: {}",
            self.player,
            self.status,
            self.title.as_deref().unwrap_or("Desconocido"),
            self.artist.as_deref().unwrap_or("Desconocido"),
            self.album.as_deref().unwrap_or("Desconocido")
        )
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WebSearchResult {
    pub title: String,
    pub snippet: String,
    pub url: String,
}

static SAVED_VOLUME_BEFORE_DUCK: Mutex<Option<u32>> = Mutex::new(None);

/// Obtiene la lista de nombres de servicios MPRIS activos en el bus de sesión del usuario.
fn list_mpris_players() -> Vec<String> {
    let output = match Command::new("busctl")
        .args(["--user", "list"])
        .output()
    {
        Ok(out) => out,
        Err(_) => return Vec::new(),
    };

    let text = String::from_utf8_lossy(&output.stdout);
    let mut players = Vec::new();

    for line in text.lines() {
        let trimmed = line.trim();
        if let Some(service) = trimmed.split_whitespace().next() {
            if service.starts_with("org.mpris.MediaPlayer2.") {
                players.push(service.to_string());
            }
        }
    }

    players
}

/// Consulta el estado de reproducción y metadatos del reproductor multimedia activo (ej. Spotify, VLC, navegadores).
pub fn get_active_media_status() -> Result<MediaPlaybackStatus, String> {
    let players = list_mpris_players();
    if players.is_empty() {
        return Err("No se encontró ningún reproductor multimedia activo (MPRIS).".to_string());
    }

    // Priorizar Spotify si está en ejecución, sino usar el primer reproductor encontrado
    let target_player = players
        .iter()
        .find(|p| p.to_lowercase().contains("spotify"))
        .unwrap_or(&players[0])
        .clone();

    // 1. Obtener estado de reproducción (PlaybackStatus)
    let status_out = Command::new("qdbus6")
        .args([
            &target_player,
            "/org/mpris/MediaPlayer2",
            "org.mpris.MediaPlayer2.Player.PlaybackStatus",
        ])
        .output();

    let playback_status = match status_out {
        Ok(out) if out.status.success() => String::from_utf8_lossy(&out.stdout).trim().to_string(),
        _ => "Desconocido".to_string(),
    };

    // 2. Obtener metadatos (Metadata)
    let meta_out = Command::new("qdbus6")
        .args([
            &target_player,
            "/org/mpris/MediaPlayer2",
            "org.mpris.MediaPlayer2.Player.Metadata",
        ])
        .output();

    let mut title = None;
    let mut artist = None;
    let mut album = None;
    let mut art_url = None;

    if let Ok(out) = meta_out {
        if out.status.success() {
            let meta_text = String::from_utf8_lossy(&out.stdout);
            for line in meta_text.lines() {
                let trimmed = line.trim();
                if let Some(val) = trimmed.strip_prefix("xesam:title: ") {
                    title = Some(val.trim().to_string());
                } else if let Some(val) = trimmed.strip_prefix("xesam:artist: ") {
                    artist = Some(val.trim().to_string());
                } else if let Some(val) = trimmed.strip_prefix("xesam:album: ") {
                    album = Some(val.trim().to_string());
                } else if let Some(val) = trimmed.strip_prefix("mpris:artUrl: ") {
                    art_url = Some(val.trim().to_string());
                }
            }
        }
    }

    let clean_player_name = target_player
        .trim_start_matches("org.mpris.MediaPlayer2.")
        .to_string();

    Ok(MediaPlaybackStatus {
        player: clean_player_name,
        status: playback_status,
        title,
        artist,
        album,
        art_url,
    })
}

/// Envía comandos de control de reproducción multimedia a través de MPRIS.
pub fn control_media_player(action: &str, player: Option<&str>) -> Result<String, String> {
    let players = list_mpris_players();
    if players.is_empty() {
        return Err("No hay reproductores multimedia disponibles en ejecución.".to_string());
    }

    let target_player = if let Some(target) = player {
        let clean_t = target.to_lowercase();
        players
            .iter()
            .find(|p| p.to_lowercase().contains(&clean_t))
            .unwrap_or(&players[0])
    } else {
        players
            .iter()
            .find(|p| p.to_lowercase().contains("spotify"))
            .unwrap_or(&players[0])
    };

    let method = match action.to_lowercase().as_str() {
        "play" => "org.mpris.MediaPlayer2.Player.Play",
        "pause" => "org.mpris.MediaPlayer2.Player.Pause",
        "play_pause" | "playpause" | "toggle" => "org.mpris.MediaPlayer2.Player.PlayPause",
        "next" | "siguiente" => "org.mpris.MediaPlayer2.Player.Next",
        "prev" | "previous" | "anterior" => "org.mpris.MediaPlayer2.Player.Previous",
        "stop" | "detener" => "org.mpris.MediaPlayer2.Player.Stop",
        _ => {
            return Err(format!(
                "Acción '{}' no reconocida. Usa: play, pause, play_pause, next, previous o stop.",
                action
            ))
        }
    };

    let status = Command::new("qdbus6")
        .args([target_player, "/org/mpris/MediaPlayer2", method])
        .status()
        .map_err(|e| format!("Error invocando qdbus6: {}", e))?;

    if status.success() {
        Ok(format!(
            "Comando multimedia '{}' ejecutado correctamente en {}",
            action, target_player
        ))
    } else {
        Err(format!("El comando '{}' en {} no respondió con éxito.", action, target_player))
    }
}

/// Lee el volumen maestro actual del sistema (en porcentaje de 0 a 100).
pub fn get_system_volume() -> Result<u32, String> {
    let output = Command::new("pactl")
        .args(["get-sink-volume", "@DEFAULT_SINK@"])
        .output()
        .map_err(|e| format!("Error ejecutando pactl: {}", e))?;

    if !output.status.success() {
        return Err("pactl falló al consultar el volumen del sink por defecto.".to_string());
    }

    let text = String::from_utf8_lossy(&output.stdout);
    for part in text.split_whitespace() {
        if part.ends_with('%') {
            let digits: String = part.chars().filter(|c| c.is_ascii_digit()).collect();
            if let Ok(val) = digits.parse::<u32>() {
                return Ok(val);
            }
        }
    }

    Ok(100)
}

/// Ajusta el volumen del sistema de forma relativa ('+5%', '-10%'), absoluta ('50%') o conmuta silencio ('mute').
pub fn adjust_system_volume(change: &str) -> Result<String, String> {
    let trimmed = change.trim().to_lowercase();
    if trimmed == "mute" || trimmed == "silenciar" || trimmed == "toggle_mute" {
        let status = Command::new("pactl")
            .args(["set-sink-mute", "@DEFAULT_SINK@", "toggle"])
            .status()
            .map_err(|e| format!("Error ejecutando pactl mute: {}", e))?;
        if status.success() {
            return Ok("Silencio de audio alternado (toggle mute).".to_string());
        }
    } else if trimmed == "unmute" {
        let status = Command::new("pactl")
            .args(["set-sink-mute", "@DEFAULT_SINK@", "0"])
            .status()
            .map_err(|e| format!("Error ejecutando pactl unmute: {}", e))?;
        if status.success() {
            return Ok("Audio reactivado (unmute).".to_string());
        }
    } else if trimmed.starts_with('+') || trimmed.starts_with('-') {
        let arg = if trimmed.ends_with('%') { trimmed } else { format!("{}%", trimmed) };
        let status = Command::new("pactl")
            .args(["set-sink-volume", "@DEFAULT_SINK@", &arg])
            .status()
            .map_err(|e| format!("Error ejecutando pactl: {}", e))?;
        if status.success() {
            let current = get_system_volume().unwrap_or(0);
            return Ok(format!("Volumen ajustado a {}% ({})", current, arg));
        }
    } else {
        let clean_digits: String = trimmed.chars().filter(|c| c.is_ascii_digit()).collect();
        if let Ok(pct) = clean_digits.parse::<u32>() {
            set_system_volume(pct)?;
            return Ok(format!("Volumen establecido al {}%", pct));
        }
    }
    Err("Formato de cambio de volumen no válido. Usa ej: '+5%', '-10%', '50%', 'mute'.".to_string())
}

/// Ajusta el volumen del sistema al porcentaje especificado (ej. 50 para 50%).
pub fn set_system_volume(percent: u32) -> Result<(), String> {
    let clamped = percent.min(150);
    let status = Command::new("pactl")
        .args(["set-sink-volume", "@DEFAULT_SINK@", &format!("{}%", clamped)])
        .status()
        .map_err(|e| format!("Error ejecutando pactl: {}", e))?;

    if status.success() {
        Ok(())
    } else {
        Err("No se pudo ajustar el volumen del sistema.".to_string())
    }
}

/// Auto-Ducking: reduce el volumen mientras Enigma habla y lo restaura al terminar.
pub fn auto_duck_music(duck: bool) {
    if duck {
        if let Ok(current_vol) = get_system_volume() {
            if current_vol > 35 {
                let mut guard = SAVED_VOLUME_BEFORE_DUCK.lock().unwrap();
                *guard = Some(current_vol);
                let _ = set_system_volume(25);
            }
        }
    } else {
        let mut guard = SAVED_VOLUME_BEFORE_DUCK.lock().unwrap();
        if let Some(prev_vol) = guard.take() {
            let _ = set_system_volume(prev_vol);
        }
    }
}

/// Búsqueda web en vivo usando DuckDuckGo HTML Lite (sin necesidad de API keys).
pub async fn search_web_duckduckgo(query: &str) -> Result<Vec<WebSearchResult>, String> {
    let trimmed = query.trim();
    if trimmed.is_empty() {
        return Err("La consulta de búsqueda no puede estar vacía.".to_string());
    }

    let client = Client::builder()
        .timeout(Duration::from_secs(6))
        .user_agent("Mozilla/5.0 (X11; Linux x86_64; rv:120.0) Gecko/20100101 Firefox/120.0")
        .build()
        .map_err(|e| format!("Error creando cliente HTTP: {}", e))?;

    let encoded_query = url::form_urlencoded::byte_serialize(trimmed.as_bytes()).collect::<String>();
    let url = format!("https://html.duckduckgo.com/html/?q={}", encoded_query);

    let response = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("Error en conexión con DuckDuckGo: {}", e))?;

    if !response.status().is_success() {
        return Err(format!("DuckDuckGo devolvió estado HTTP {}", response.status()));
    }

    let html = response
        .text()
        .await
        .map_err(|e| format!("Error leyendo HTML de búsqueda: {}", e))?;

    let mut results = Vec::new();

    // Parseo ligero y tolerante de títulos, enlaces y snippets de DuckDuckGo HTML
    let mut search_pos = 0;
    while let Some(link_start) = html[search_pos..].find("class=\"result__a\"") {
        let abs_start = search_pos + link_start;
        search_pos = abs_start + 18;

        // Extraer URL si está en href
        let snippet_area = &html[abs_start..];
        let href_val = if let Some(href_pos) = snippet_area.find("href=\"") {
            if let Some(href_end) = snippet_area[href_pos + 6..].find('"') {
                snippet_area[href_pos + 6..href_pos + 6 + href_end].to_string()
            } else {
                String::new()
            }
        } else {
            String::new()
        };

        // Extraer título
        let title_text = if let Some(tag_end) = snippet_area.find('>') {
            if let Some(close_tag) = snippet_area[tag_end..].find("</a>") {
                let raw_title = &snippet_area[tag_end + 1..tag_end + close_tag];
                strip_html_tags(raw_title)
            } else {
                String::new()
            }
        } else {
            String::new()
        };

        // Extraer snippet
        let snippet_text = if let Some(snip_start) = snippet_area.find("class=\"result__snippet") {
            let snip_part = &snippet_area[snip_start..];
            if let Some(snip_tag_end) = snip_part.find('>') {
                let close_tag = snip_part[snip_tag_end..]
                    .find("</a>")
                    .or_else(|| snip_part[snip_tag_end..].find("</td>"))
                    .unwrap_or(200.min(snip_part.len() - snip_tag_end));
                let raw_snip = &snip_part[snip_tag_end + 1..snip_tag_end + close_tag];
                strip_html_tags(raw_snip)
            } else {
                String::new()
            }
        } else {
            String::new()
        };

        if !title_text.is_empty() && (!snippet_text.is_empty() || !href_val.is_empty()) {
            results.push(WebSearchResult {
                title: title_text,
                snippet: snippet_text,
                url: href_val,
            });
        }

        if results.len() >= 4 {
            break;
        }
    }

    if results.is_empty() {
        Err(format!("No se encontraron resultados en internet para '{}'", trimmed))
    } else {
        Ok(results)
    }
}

/// Envía una notificación nativa al escritorio Linux usando `notify-rust` y fallback `notify-send`.
pub fn send_desktop_notification(title: &str, body: &str, urgency: Option<&str>) -> Result<(), String> {
    let clean_title = if title.trim().is_empty() { "Enigma" } else { title.trim() };
    let clean_body = body.trim();

    // Intentar con notify-rust nativo
    let mut notif = notify_rust::Notification::new();
    notif
        .appname("Enigma")
        .summary(clean_title)
        .body(clean_body)
        .icon("dialog-information");

    if let Some(u) = urgency {
        match u.to_lowercase().as_str() {
            "critical" | "urgente" => {
                notif.urgency(notify_rust::Urgency::Critical);
            }
            "low" | "baja" => {
                notif.urgency(notify_rust::Urgency::Low);
            }
            _ => {
                notif.urgency(notify_rust::Urgency::Normal);
            }
        }
    }

    if notif.show().is_ok() {
        return Ok(());
    }

    // Fallback CLI con notify-send
    let _ = Command::new("notify-send")
        .args(["-a", "Enigma", clean_title, clean_body])
        .status();

    Ok(())
}

/// Elimina etiquetas HTML y decodifica entidades comunes.
fn strip_html_tags(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut in_tag = false;

    for c in input.chars() {
        if c == '<' {
            in_tag = true;
        } else if c == '>' {
            in_tag = false;
        } else if !in_tag {
            out.push(c);
        }
    }

    out.replace("&quot;", "\"")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&#39;", "'")
        .replace("&nbsp;", " ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}
