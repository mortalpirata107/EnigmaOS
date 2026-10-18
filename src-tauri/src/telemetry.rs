//! Telemetry Module for Enigma
//!
//! Tracks active user application usage on Linux (Wayland/KDE Plasma)
//! using `sysinfo` process analysis and logs active user sessions to SQLite (`usage_logs`).
//! Provides historical usage pattern summaries for the last 24 hours.

use std::collections::HashSet;
use std::path::Path;
use std::time::Duration;
use rusqlite::{params, Connection, Result};
use sysinfo::System;

/// Initializes the `usage_logs` table in SQLite
pub fn init_telemetry_table() -> Result<(), String> {
    let conn = get_telemetry_connection()?;
    conn.execute(
        "CREATE TABLE IF NOT EXISTS usage_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            process_name TEXT NOT NULL,
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
        );",
        [],
    )
    .map_err(|e| format!("Error creando tabla usage_logs: {}", e))?;

    // Create index on timestamp for fast 24h pattern queries
    let _ = conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_usage_logs_timestamp ON usage_logs(timestamp);",
        [],
    );

    Ok(())
}

/// Returns a connection to the SQLite database
fn get_telemetry_connection() -> Result<Connection, String> {
    let path = crate::db::get_db_path();
    Connection::open(&path).map_err(|e| format!("Error conectando a SQLite ({:?}): {}", path, e))
}

/// Checks if a process is a relevant user-facing application
fn is_relevant_user_app(process_name: &str, exe_path: Option<&Path>) -> bool {
    let name = process_name.to_lowercase();

    // Whitelist of user apps explicitly highlighted and common desktop productivity apps
    let user_whitelist = [
        "code",         // Visual Studio Code
        "kwrite",       // KWrite editor
        "kate",         // Kate advanced editor
        "unity",        // Unity Editor / UnityHub
        "firefox",      // Firefox browser
        "clashroyale",  // Clash Royale / Emulators
        "opera",        // Opera browser
        "chrome",       // Google Chrome
        "chromium",     // Chromium browser
        "discord",      // Discord
        "spotify",      // Spotify
        "steam",        // Steam client / games
        "blender",      // Blender 3D
        "gimp",         // GIMP
        "inkscape",     // Inkscape
        "vlc",          // VLC Media Player
        "obs",          // OBS Studio
        "telegram",     // Telegram Desktop
        "kitty",        // Kitty Terminal
        "alacritty",    // Alacritty Terminal
        "konsole",      // Konsole Terminal
        "dolphin",      // Dolphin File Manager
        "thunderbird",  // Thunderbird Email
        "rider",        // JetBrains Rider
        "rustrover",    // JetBrains RustRover
    ];

    if user_whitelist.iter().any(|&app| name == app || name.starts_with(app)) {
        return true;
    }

    // Blacklist of system/kernel daemons and background services to exclude
    let system_blacklist = [
        "systemd", "dbus", "kwin", "plasmashell", "xwayland", "pipewire",
        "wireplumber", "pulseaudio", "polkit", "udisks", "upower",
        "networkmanager", "kernel", "kworker", "dynamictopbar", "enigmaos", "ollama",
        "piper", "node", "sh", "bash", "zsh", "cargo", "rustc", "sshd",
        "systemd-", "gvfs", "dconf", "at-spi", "agent", "daemon",
    ];

    if system_blacklist.iter().any(|&sys| name.contains(sys)) {
        return false;
    }

    // If it has an executable path in user-facing locations (/usr/bin, /opt, /home, /var/lib/flatpak, /snap)
    if let Some(path) = exe_path {
        let path_str = path.to_string_lossy().to_lowercase();
        if path_str.starts_with("/home/")
            || path_str.starts_with("/opt/")
            || path_str.starts_with("/var/lib/flatpak/")
            || path_str.starts_with("/snap/")
            || (path_str.starts_with("/usr/bin/") && !path_str.contains("systemd"))
        {
            return true;
        }
    }

    false
}

/// Normalizes process names to clean canonical names
fn canonicalize_name(name: &str) -> String {
    let lower = name.trim().to_lowercase();
    if lower.starts_with("code") {
        "code".to_string()
    } else if lower.starts_with("firefox") {
        "firefox".to_string()
    } else if lower.starts_with("opera") {
        "opera".to_string()
    } else if lower.starts_with("unity") {
        "unity".to_string()
    } else if lower.starts_with("kwrite") {
        "kwrite".to_string()
    } else if lower.starts_with("clashroyale") {
        "clashroyale".to_string()
    } else if lower.starts_with("spotify") {
        "spotify".to_string()
    } else if lower.starts_with("discord") {
        "discord".to_string()
    } else {
        lower
    }
}

/// Inserts an active process usage entry into `usage_logs`
fn log_process_usage(conn: &Connection, process_name: &str) -> Result<(), rusqlite::Error> {
    conn.execute(
        "INSERT INTO usage_logs (process_name) VALUES (?1)",
        params![process_name],
    )?;
    Ok(())
}

/// Starts the background telemetry tracker thread running every 60 seconds
pub fn start_telemetry_daemon() {
    if let Err(e) = init_telemetry_table() {
        eprintln!("[Telemetry] Error inicializando tabla usage_logs: {}", e);
    }

    tauri::async_runtime::spawn(async move {
        eprintln!("[Telemetry] Iniciando daemon de telemetría de procesos (intervalo: 60s)...");
        let mut sys = System::new_all();
        // Initial warm-up for CPU usage calculations
        sys.refresh_processes();

        let mut interval = tokio::time::interval(Duration::from_secs(60));
        loop {
            interval.tick().await;

            sys.refresh_processes();

            let mut active_apps = HashSet::new();

            for (_pid, process) in sys.processes() {
                let name = process.name();
                let cpu = process.cpu_usage();

                // Detect processes consuming active CPU (> 0.2%)
                if cpu > 0.2 && is_relevant_user_app(name, process.exe()) {
                    let canon = canonicalize_name(name);
                    active_apps.insert(canon);
                }
            }

            if !active_apps.is_empty() {
                if let Ok(conn) = get_telemetry_connection() {
                    for app in &active_apps {
                        if let Err(e) = log_process_usage(&conn, app) {
                            eprintln!("[Telemetry] Error guardando uso de '{}': {}", app, e);
                        }
                    }
                    eprintln!(
                        "[Telemetry] {} proceso(s) activo(s) registrados en usage_logs: {:?}",
                        active_apps.len(),
                        active_apps
                    );
                }
            }
        }
    });
}

/// Reads the last 24 hours of process usage logs and summarizes application activity
pub fn get_user_patterns() -> String {
    let conn = match get_telemetry_connection() {
        Ok(c) => c,
        Err(e) => return format!("No se pudo consultar la telemetría: {}", e),
    };

    let mut stmt = match conn.prepare(
        "SELECT process_name, COUNT(*) as minutes_used 
         FROM usage_logs 
         WHERE timestamp >= datetime('now', '-24 hours') 
         GROUP BY process_name 
         ORDER BY minutes_used DESC 
         LIMIT 10;",
    ) {
        Ok(s) => s,
        Err(e) => return format!("Error preparando consulta de telemetría: {}", e),
    };

    let rows = stmt.query_map([], |row| {
        let name: String = row.get(0)?;
        let minutes: i64 = row.get(1)?;
        Ok((name, minutes))
    });

    let mut entries = Vec::new();
    if let Ok(iter) = rows {
        for item in iter.flatten() {
            entries.push(item);
        }
    }

    if entries.is_empty() {
        return "No hay suficiente historial de telemetría registrado en las últimas 24 horas.".to_string();
    }

    let mut summary = String::from("Patrones de uso del sistema (últimas 24 horas):\n");
    for (name, minutes) in entries {
        let duration_formatted = if minutes >= 60 {
            let hours = minutes / 60;
            let rem_mins = minutes % 60;
            if rem_mins == 0 {
                format!("{}h", hours)
            } else {
                format!("{}h {}m", hours, rem_mins)
            }
        } else {
            format!("{}m", minutes)
        };

        summary.push_str(&format!("- {}: {} muestras (~{})\n", name, minutes, duration_formatted));
    }

    summary.trim_end().to_string()
}

/// Returns the current active window or user app on Wayland / KWin
#[allow(dead_code)]
pub fn get_current_active_app() -> String {
    // 1. Try KWin active window from windows.rs
    let open_wins = crate::windows::get_open_windows();
    if let Some(active) = open_wins.into_iter().find(|w| w.is_active) {
        if !active.app_name.is_empty() {
            return format!("{} ({})", active.app_name, active.title);
        } else if !active.title.is_empty() {
            return active.title;
        }
    }
    // 2. Fallback: check last active process in SQLite usage_logs
    if let Ok(conn) = get_telemetry_connection() {
        if let Ok(mut stmt) = conn.prepare("SELECT process_name FROM usage_logs ORDER BY id DESC LIMIT 1;") {
            if let Ok(mut rows) = stmt.query([]) {
                if let Ok(Some(row)) = rows.next() {
                    if let Ok(name) = row.get::<_, String>(0) {
                        return name;
                    }
                }
            }
        }
    }
    "Escritorio / Navegador".to_string()
}

/// Tauri command to expose user patterns to the frontend or extensions
#[tauri::command]
pub fn get_user_usage_patterns() -> Result<String, String> {
    Ok(get_user_patterns())
}


#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_is_relevant_user_app() {
        assert!(is_relevant_user_app("code", None));
        assert!(is_relevant_user_app("firefox", None));
        assert!(is_relevant_user_app("kwrite", None));
        assert!(is_relevant_user_app("unity", None));
        assert!(is_relevant_user_app("clashroyale", None));
        assert!(!is_relevant_user_app("systemd", None));
        assert!(!is_relevant_user_app("kworker/0:1", None));
    }

    #[test]
    fn test_canonicalize_name() {
        assert_eq!(canonicalize_name("code-oss"), "code");
        assert_eq!(canonicalize_name("firefox-bin"), "firefox");
        assert_eq!(canonicalize_name("kwrite"), "kwrite");
    }

    #[test]
    fn test_init_and_get_user_patterns() {
        let _ = init_telemetry_table();
        let conn = get_telemetry_connection().unwrap();
        let _ = log_process_usage(&conn, "test_app");
        let patterns = get_user_patterns();
        assert!(patterns.contains("Patrones de uso") || patterns.contains("historial"));
    }
}
