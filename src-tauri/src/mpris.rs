//! Native MPRIS / Spotify Integration via systemd user D-Bus
//!
//! Provides two-way communication with Spotify and any MPRIS media player on Linux:
//! - Track metadata: Title, Artist, Album, Cover Art URL, Length
//! - Playback state: Playing, Paused, Position
//! - Media controls: PlayPause, Next, Previous, Seek

use serde::{Deserialize, Serialize};
use std::process::Command;
use tauri::{AppHandle, Emitter};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MediaInfo {
    pub player: String,
    pub status: String,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub art_url: String,
    pub position_secs: i64,
    pub duration_secs: i64,
}

impl Default for MediaInfo {
    fn default() -> Self {
        Self {
            player: "spotify".to_string(),
            status: "Paused".to_string(),
            title: "Fantasia & Fugue in G Minor, BWV 542".to_string(),
            artist: "Johann Sebastian Bach".to_string(),
            album: "Bach: Organ Works".to_string(),
            art_url: "".to_string(),
            position_secs: 216,
            duration_secs: 357,
        }
    }
}

/// Finds the active MPRIS player, preferring Spotify
pub fn find_active_player() -> Option<String> {
    let output = Command::new("busctl")
        .args(["--user", "list", "--no-legend"])
        .output()
        .ok()?;

    let text = String::from_utf8_lossy(&output.stdout);
    let mut players = Vec::new();

    for line in text.lines() {
        let parts: Vec<&str> = line.split_whitespace().collect();
        if let Some(&service) = parts.first() {
            if service.starts_with("org.mpris.MediaPlayer2") {
                if service.contains("spotify") {
                    return Some(service.to_string());
                }
                players.push(service.to_string());
            }
        }
    }

    players.into_iter().next()
}

fn extract_busctl_string(input: &str) -> Option<String> {
    let mut bytes = Vec::new();
    let mut chars = input.chars().peekable();

    while let Some(c) = chars.next() {
        if c == '"' {
            // Unescaped quote ends the busctl string value
            return Some(String::from_utf8_lossy(&bytes).to_string().replace("\\'", "'").replace("\\\"", "\""));
        } else if c == '\\' {
            if let Some(&next_c) = chars.peek() {
                if next_c.is_digit(8) {
                    // Octal byte escape from busctl (e.g. \342\200\231 -> ’ or \303\251 -> é)
                    let mut oct = String::new();
                    for _ in 0..3 {
                        if let Some(&oct_c) = chars.peek() {
                            if oct_c.is_digit(8) {
                                oct.push(chars.next().unwrap());
                            } else {
                                break;
                            }
                        }
                    }
                    if let Ok(b) = u8::from_str_radix(&oct, 8) {
                        bytes.push(b);
                        continue;
                    }
                } else {
                    let esc = chars.next().unwrap();
                    match esc {
                        'n' => bytes.push(b'\n'),
                        'r' => bytes.push(b'\r'),
                        't' => bytes.push(b'\t'),
                        '\\' => bytes.push(b'\\'),
                        '"' => bytes.push(b'"'),
                        '\'' => bytes.push(b'\''),
                        other => {
                            let mut buf = [0; 4];
                            let s = other.encode_utf8(&mut buf);
                            bytes.extend_from_slice(s.as_bytes());
                        }
                    }
                }
            }
        } else {
            let mut buf = [0; 4];
            let s = c.encode_utf8(&mut buf);
            bytes.extend_from_slice(s.as_bytes());
        }
    }

    Some(String::from_utf8_lossy(&bytes).to_string().replace("\\'", "'").replace("\\\"", "\""))
}

/// Queries metadata and playback position from D-Bus
pub fn get_media_status_internal() -> MediaInfo {
    let player = match find_active_player() {
        Some(p) => p,
        None => return MediaInfo::default(),
    };

    // 1. PlaybackStatus
    let status_output = Command::new("busctl")
        .args(["--user", "get-property", &player, "/org/mpris/MediaPlayer2", "org.mpris.MediaPlayer2.Player", "PlaybackStatus"])
        .output()
        .ok();

    let mut status = "Stopped".to_string();
    if let Some(out) = status_output {
        let text = String::from_utf8_lossy(&out.stdout);
        if text.contains("Playing") {
            status = "Playing".to_string();
        } else if text.contains("Paused") {
            status = "Paused".to_string();
        }
    }

    // 2. Position
    let pos_output = Command::new("busctl")
        .args(["--user", "get-property", &player, "/org/mpris/MediaPlayer2", "org.mpris.MediaPlayer2.Player", "Position"])
        .output()
        .ok();

    let mut position_secs = 0i64;
    if let Some(out) = pos_output {
        let text = String::from_utf8_lossy(&out.stdout);
        for word in text.split_whitespace() {
            if let Ok(micro) = word.parse::<i64>() {
                position_secs = micro / 1_000_000;
                break;
            }
        }
    }

    // 3. Metadata
    let meta_output = Command::new("busctl")
        .args(["--user", "get-property", &player, "/org/mpris/MediaPlayer2", "org.mpris.MediaPlayer2.Player", "Metadata"])
        .output()
        .ok();

    let mut title = "Unknown Title".to_string();
    let mut artist = "Unknown Artist".to_string();
    let mut album = "".to_string();
    let mut art_url = "".to_string();
    let mut duration_secs = 0i64;

    if let Some(out) = meta_output {
        let text = String::from_utf8_lossy(&out.stdout);

        // Title
        if let Some(start) = text.find("\"xesam:title\" s \"") {
            let rem = &text[start + 17..];
            if let Some(val) = extract_busctl_string(rem) {
                title = val;
            }
        }

        // Artist
        if let Some(start) = text.find("\"xesam:artist\" as") {
            let rem = &text[start + 16..];
            if let Some(quote_start) = rem.find('"') {
                let rem2 = &rem[quote_start + 1..];
                if let Some(val) = extract_busctl_string(rem2) {
                    artist = val;
                }
            }
        }

        // Album
        if let Some(start) = text.find("\"xesam:album\" s \"") {
            let rem = &text[start + 17..];
            if let Some(val) = extract_busctl_string(rem) {
                album = val;
            }
        }

        // Art URL
        if let Some(start) = text.find("\"mpris:artUrl\" s \"") {
            let rem = &text[start + 18..];
            if let Some(end) = rem.find('"') {
                art_url = rem[..end].to_string();
            }
        }

        // Duration length
        if let Some(start) = text.find("\"mpris:length\" t ") {
            let rem = &text[start + 17..];
            let num_str: String = rem.chars().take_while(|c| c.is_digit(10)).collect();
            if let Ok(micro) = num_str.parse::<i64>() {
                duration_secs = micro / 1_000_000;
            }
        }
    }

    MediaInfo {
        player,
        status,
        title,
        artist,
        album,
        art_url,
        position_secs,
        duration_secs,
    }
}

/// Tauri command to get the current media status
#[tauri::command]
pub fn get_media_status() -> MediaInfo {
    get_media_status_internal()
}

/// Tauri command to send playback control commands
#[tauri::command]
pub fn media_control(action: String, value: Option<i64>) -> Result<(), String> {
    let player = find_active_player().unwrap_or_else(|| "org.mpris.MediaPlayer2.spotify".to_string());
    match action.as_str() {
        "play_pause" => {
            let _ = Command::new("busctl")
                .args(["--user", "call", &player, "/org/mpris/MediaPlayer2", "org.mpris.MediaPlayer2.Player", "PlayPause"])
                .status();
        }
        "next" => {
            let _ = Command::new("busctl")
                .args(["--user", "call", &player, "/org/mpris/MediaPlayer2", "org.mpris.MediaPlayer2.Player", "Next"])
                .status();
        }
        "previous" => {
            let _ = Command::new("busctl")
                .args(["--user", "call", &player, "/org/mpris/MediaPlayer2", "org.mpris.MediaPlayer2.Player", "Previous"])
                .status();
        }
        "seek" => {
            if let Some(pos_secs) = value {
                let pos_micro = pos_secs * 1_000_000;
                let _ = Command::new("busctl")
                    .args(["--user", "call", &player, "/org/mpris/MediaPlayer2", "org.mpris.MediaPlayer2.Player", "Seek", "x", &pos_micro.to_string()])
                    .status();
            }
        }
        _ => {}
    }
    Ok(())
}

/// Spawns a background worker thread that polls Spotify / MPRIS every 800ms
/// and pushes live state updates to the frontend via Tauri event 'media_update'
pub fn start_media_poller(app_handle: AppHandle) {
    std::thread::spawn(move || {
        loop {
            let info = get_media_status_internal();
            let _ = app_handle.emit("media_update", info);
            std::thread::sleep(std::time::Duration::from_millis(2000));
        }
    });
}
