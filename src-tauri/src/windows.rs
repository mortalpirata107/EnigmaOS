//! Native Window Management for KDE Plasma 6 (Wayland)
//!
//! Provides native Wayland window queries and focusing via KWin D-Bus interfaces:
//! - Queries open windows using `org.kde.KWin /WindowsRunner org.kde.krunner1.Match`
//! - Tracks active/focused window in real-time via KWin Scripting + zbus D-Bus service
//! - Focuses/activates windows using `org.kde.KWin /WindowsRunner org.kde.krunner1.Run`

use base64::prelude::*;
use serde::{Deserialize, Serialize};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{OnceLock, RwLock};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct OpenWindowItem {
    pub id: String,
    pub uuid: String,
    pub title: String,
    pub app_name: String,
    pub window_class: String,
    pub icon: String,
    pub is_active: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ActiveWindowInfo {
    pub uuid: String,
    pub title: String,
    pub class: String,
}

static CURRENT_ACTIVE_WINDOW: RwLock<Option<ActiveWindowInfo>> = RwLock::new(None);
static LAST_USER_WINDOW: RwLock<Option<ActiveWindowInfo>> = RwLock::new(None);

pub fn get_last_user_window() -> Option<ActiveWindowInfo> {
    LAST_USER_WINDOW.read().ok().and_then(|guard| guard.clone())
}

pub fn get_current_active_window() -> ActiveWindowInfo {
    let curr = CURRENT_ACTIVE_WINDOW
        .read()
        .ok()
        .and_then(|guard| guard.clone())
        .unwrap_or_default();

    let is_self = curr.class.eq_ignore_ascii_case("dynamictopbar")
        || curr.class.eq_ignore_ascii_case("enigmaos")
        || curr.title.eq_ignore_ascii_case("DynamicTopBar")
        || curr.title.eq_ignore_ascii_case("EnigmaOS")
        || curr.title.eq_ignore_ascii_case("BottomDock")
        || curr.title.eq_ignore_ascii_case("EnigmaDock");

    if is_self || (curr.uuid.is_empty() && curr.class.is_empty()) {
        if let Some(last) = get_last_user_window() {
            return last;
        }
    }
    curr
}

pub fn update_current_active_window(uuid: String, title: String, class: String) {
    let clean_uuid = uuid.trim().to_string();
    let clean_title = title.trim().to_string();
    let clean_class = class.trim().to_string();

    let is_self = clean_class.eq_ignore_ascii_case("dynamictopbar")
        || clean_class.eq_ignore_ascii_case("enigmaos")
        || clean_title.eq_ignore_ascii_case("DynamicTopBar")
        || clean_title.eq_ignore_ascii_case("EnigmaOS")
        || clean_title.eq_ignore_ascii_case("BottomDock")
        || clean_title.eq_ignore_ascii_case("EnigmaDock");

    if !is_self && (!clean_uuid.is_empty() || !clean_title.is_empty() || !clean_class.is_empty()) {
        if let Ok(mut guard) = LAST_USER_WINDOW.write() {
            *guard = Some(ActiveWindowInfo {
                uuid: clean_uuid.clone(),
                title: clean_title.clone(),
                class: clean_class.clone(),
            });
        }
    }

    if let Ok(mut guard) = CURRENT_ACTIVE_WINDOW.write() {
        *guard = Some(ActiveWindowInfo {
            uuid: clean_uuid,
            title: clean_title,
            class: clean_class,
        });
    }
}

struct ActiveTrackerService {
    app_handle: AppHandle,
}

#[zbus::interface(name = "org.dynamictopbar.ActiveWindowTracker")]
impl ActiveTrackerService {
    async fn notify_active(&self, uuid: String, title: String, class: String) {
        let clean_uuid = uuid.trim().to_string();
        let clean_title = title.trim().to_string();
        let clean_class = class.trim().to_string();

        eprintln!(
            "[ActiveWindowTracker] Focused window event: uuid='{}', title='{}', class='{}'",
            clean_uuid, clean_title, clean_class
        );

        update_current_active_window(clean_uuid.clone(), clean_title.clone(), clean_class.clone());

        let updated_windows = get_open_windows();
        let _ = self.app_handle.emit("open_windows_changed", updated_windows);
        let _ = self.app_handle.emit("active_window_changed", serde_json::json!({
            "uuid": clean_uuid,
            "title": clean_title,
            "class": clean_class,
        }));
        // Window snapshots are generated on-demand when hovering over dock previews,
        // preventing invasive spectacle compositor flashes during regular window switching.
    }
}

fn dirs_fallback_data_dir() -> std::path::PathBuf {
    if let Ok(data_home) = std::env::var("XDG_DATA_HOME") {
        std::path::PathBuf::from(data_home)
    } else if let Ok(home) = std::env::var("HOME") {
        std::path::PathBuf::from(home).join(".local").join("share")
    } else {
        std::path::PathBuf::from("/tmp")
    }
}

fn deploy_kwin_script() {
    let script_dir = dirs_fallback_data_dir().join("dynamictopbar");
    let _ = std::fs::create_dir_all(&script_dir);
    let script_path = script_dir.join("kwin_active_tracker.js");

    let script_content = r#"// DynamicTopBar Active Window Tracker for KDE Plasma 6 (Wayland)
function notifyActive(w) {
    try {
        var win = w || workspace.activeWindow;
        if (win) {
            var uuid = win.internalId ? win.internalId.toString() : "";
            var title = win.caption ? win.caption.toString() : "";
            var cls = win.resourceClass ? win.resourceClass.toString() : "";
            callDBus(
                "org.dynamictopbar.ActiveWindowTracker",
                "/Tracker",
                "org.dynamictopbar.ActiveWindowTracker",
                "NotifyActive",
                uuid,
                title,
                cls
            );
        } else {
            callDBus(
                "org.dynamictopbar.ActiveWindowTracker",
                "/Tracker",
                "org.dynamictopbar.ActiveWindowTracker",
                "NotifyActive",
                "",
                "",
                ""
            );
        }
    } catch (e) {
        // Silently ignore
    }
}

workspace.windowActivated.connect(notifyActive);
notifyActive(workspace.activeWindow);
"#;

    if let Err(e) = std::fs::write(&script_path, script_content) {
        eprintln!("[ActiveWindowTracker] Error writing KWin tracker script: {}", e);
        return;
    }

    let qdbus = get_qdbus_bin();
    let script_path_str = script_path.to_string_lossy().to_string();

    // Unload any previously loaded instance
    let _ = Command::new(qdbus)
        .args([
            "org.kde.KWin",
            "/Scripting",
            "org.kde.kwin.Scripting.unloadScript",
            "dynamictopbar_active_tracker",
        ])
        .output();

    // Load script
    let load_res = Command::new(qdbus)
        .args([
            "org.kde.KWin",
            "/Scripting",
            "org.kde.kwin.Scripting.loadScript",
            &script_path_str,
            "dynamictopbar_active_tracker",
        ])
        .output();

    if let Ok(res) = load_res {
        let out = String::from_utf8_lossy(&res.stdout);
        eprintln!("[ActiveWindowTracker] KWin script loaded: {}", out.trim());
        let _ = Command::new(qdbus)
            .args(["org.kde.KWin", "/Scripting", "org.kde.kwin.Scripting.start"])
            .output();
    }
}

/// Initializes the real-time active window listener via session D-Bus and KWin script
pub fn init_active_window_tracker(app_handle: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let service = ActiveTrackerService {
            app_handle: app_handle.clone(),
        };

        match zbus::connection::Builder::session() {
            Ok(builder) => {
                match builder
                    .name("org.dynamictopbar.ActiveWindowTracker")
                    .and_then(|b| b.serve_at("/Tracker", service))
                {
                    Ok(b) => match b.build().await {
                        Ok(conn) => {
                            eprintln!("[ActiveWindowTracker] D-Bus service 'org.dynamictopbar.ActiveWindowTracker' online.");
                            deploy_kwin_script();
                            // Keep connection alive
                            let _held = conn;
                            loop {
                                tokio::time::sleep(Duration::from_secs(3600)).await;
                            }
                        }
                        Err(e) => eprintln!("[ActiveWindowTracker] Failed to build D-Bus connection: {}", e),
                    },
                    Err(e) => eprintln!("[ActiveWindowTracker] Failed to configure D-Bus service: {}", e),
                }
            }
            Err(e) => eprintln!("[ActiveWindowTracker] Failed to create D-Bus session builder: {}", e),
        }
    });
}

static QDBUS_BIN: OnceLock<&'static str> = OnceLock::new();

fn get_qdbus_bin() -> &'static str {
    *QDBUS_BIN.get_or_init(|| {
        if Command::new("which").arg("qdbus6").output().map(|o| o.status.success()).unwrap_or(false) {
            "qdbus6"
        } else {
            "qdbus"
        }
    })
}

fn infer_window_class(title: &str, app_name: &str) -> String {
    let lower = format!("{} {}", title.to_lowercase(), app_name.to_lowercase());
    if lower.contains("spotify") {
        return "spotify".to_string();
    }
    if lower.contains("discord") {
        return "discord".to_string();
    }
    if lower.contains("opera") {
        return "opera".to_string();
    }
    if lower.contains("antigravity") || lower.contains("visual studio code") || lower.contains("code") {
        return "antigravity-ide".to_string();
    }
    if lower.contains("dolphin") || lower.contains("archivos") {
        return "dolphin".to_string();
    }
    if lower.contains("kitty") || lower.contains("terminal") || lower.contains("konsole") || lower.contains("bash") {
        return "kitty".to_string();
    }
    if lower.contains("zen") {
        return "zen-browser".to_string();
    }
    if lower.contains("firefox") {
        return "firefox".to_string();
    }
    if lower.contains("chrome") {
        return "google-chrome".to_string();
    }
    if lower.contains("settings") || lower.contains("preferencias") || lower.contains("ajustes") {
        return "systemsettings".to_string();
    }
    "app".to_string()
}

fn infer_app_name(title: &str, icon: &str) -> String {
    if !icon.is_empty() {
        let clean = icon.replace("org.kde.", "").replace(".desktop", "");
        if clean.eq_ignore_ascii_case("antigravity-ide") || clean.eq_ignore_ascii_case("code") {
            return "Antigravity IDE".to_string();
        }
        if clean.eq_ignore_ascii_case("spotify") {
            return "Spotify".to_string();
        }
        if clean.eq_ignore_ascii_case("discord") {
            return "Discord".to_string();
        }
        if clean.eq_ignore_ascii_case("opera") {
            return "Opera".to_string();
        }
        if clean.eq_ignore_ascii_case("dolphin") {
            return "Dolphin".to_string();
        }
        if clean.eq_ignore_ascii_case("kitty") || clean.eq_ignore_ascii_case("konsole") {
            return "Terminal".to_string();
        }
    }

    if let Some(pos) = title.rfind(" - ") {
        let candidate = title[pos + 3..].trim();
        if !candidate.is_empty() {
            return candidate.to_string();
        }
    }
    if let Some(pos) = title.rfind(" — ") {
        let candidate = title[pos + 4..].trim();
        if !candidate.is_empty() {
            return candidate.to_string();
        }
    }

    if title.to_lowercase().contains("antigravity") {
        return "Antigravity IDE".to_string();
    }
    if title.to_lowercase().contains("spotify") {
        return "Spotify".to_string();
    }
    if title.to_lowercase().contains("discord") {
        return "Discord".to_string();
    }
    if title.to_lowercase().contains("opera") {
        return "Opera".to_string();
    }

    title.to_string()
}

fn infer_icon(app_name: &str, title: &str) -> String {
    let lower_name = app_name.to_lowercase();
    let lower_title = title.to_lowercase();

    if lower_name.contains("antigravity") || lower_title.contains("antigravity") || lower_name.contains("code") {
        return "antigravity-ide".to_string();
    }
    if lower_name.contains("spotify") || lower_title.contains("spotify") {
        return "spotify".to_string();
    }
    if lower_name.contains("discord") || lower_title.contains("discord") {
        return "discord".to_string();
    }
    if lower_name.contains("opera") || lower_title.contains("opera") {
        return "opera".to_string();
    }
    if lower_name.contains("dolphin") || lower_title.contains("dolphin") || lower_name.contains("gestor") {
        return "folder".to_string();
    }
    if lower_name.contains("zen") || lower_title.contains("zen") || lower_name.contains("browser") || lower_name.contains("firefox") || lower_name.contains("chrome") {
        return "globe".to_string();
    }
    if lower_name.contains("terminal") || lower_name.contains("kitty") || lower_name.contains("konsole") || lower_title.contains("terminal") {
        return "terminal".to_string();
    }
    if lower_name.contains("settings") || lower_name.contains("preferencias") || lower_name.contains("ajustes") {
        return "settings".to_string();
    }

    "app-window".to_string()
}

/// Returns the list of currently open windows in KDE Plasma 6 Wayland with real active status
#[tauri::command]
pub fn get_open_windows() -> Vec<OpenWindowItem> {
    let qdbus = get_qdbus_bin();

    // 1. Query WindowsRunner match for all open windows (completely non-interactive, zero pointer grabs)
    let match_output = Command::new(qdbus)
        .args(["--literal", "org.kde.KWin", "/WindowsRunner", "org.kde.krunner1.Match", ""])
        .output()
        .ok()
        .map(|out| String::from_utf8_lossy(&out.stdout).to_string())
        .unwrap_or_default();

    let mut windows = Vec::new();
    let mut seen_ids = std::collections::HashSet::new();

    let active_info = get_current_active_window();
    let clean_active_uuid = active_info.uuid.trim_matches('{').trim_matches('}').to_lowercase();

    for chunk in match_output.split("[Argument: (sssida{sv})") {
        if chunk.is_empty() {
            continue;
        }

        let mut parts = Vec::new();
        let mut in_quote = false;
        let mut cur = String::new();
        let mut chars = chunk.chars().peekable();

        while let Some(c) = chars.next() {
            if c == '\\' {
                if let Some(next) = chars.next() {
                    cur.push(next);
                }
            } else if c == '"' {
                if in_quote {
                    parts.push(cur.clone());
                    cur.clear();
                    in_quote = false;
                    if parts.len() >= 3 {
                        break;
                    }
                } else {
                    in_quote = true;
                }
            } else if in_quote {
                cur.push(c);
            }
        }

        if parts.len() >= 3 {
            let id = parts[0].clone();
            let title = parts[1].clone();
            let mut icon = parts[2].clone();

            // Only capture real user application windows with "0_{" prefix and valid title
            if id.starts_with("0_{") && !title.trim().is_empty() && !seen_ids.contains(&id) {
                seen_ids.insert(id.clone());
                let uuid = id.trim_start_matches("0_").to_string();
                let clean_uuid = uuid.trim_matches('{').trim_matches('}').to_lowercase();

static WINDOW_CLASS_CACHE: RwLock<Option<std::collections::HashMap<String, String>>> = RwLock::new(None);

                let mut window_class = {
                    let r = WINDOW_CLASS_CACHE.read().unwrap();
                    r.as_ref().and_then(|m| m.get(&uuid).cloned()).unwrap_or_default()
                };

                if window_class.is_empty() {
                    // Non-interactive passive D-Bus query to KWin getWindowInfo for real class/desktopFile
                    if let Ok(info_out) = Command::new(qdbus).args(["org.kde.KWin", "/KWin", "getWindowInfo", &uuid]).output() {
                        let s = String::from_utf8_lossy(&info_out.stdout);
                        for line in s.lines() {
                            if let Some(rest) = line.strip_prefix("resourceClass:") {
                                window_class = rest.trim().to_lowercase();
                                break;
                            } else if let Some(rest) = line.strip_prefix("desktopFile:") {
                                if window_class.is_empty() {
                                    window_class = rest.trim().to_lowercase();
                                }
                            }
                        }
                    }
                    if !window_class.is_empty() {
                        let mut w = WINDOW_CLASS_CACHE.write().unwrap();
                        w.get_or_insert_with(std::collections::HashMap::new).insert(uuid.clone(), window_class.clone());
                    }
                }

                let app_name = infer_app_name(&title, &icon);
                if icon.is_empty() {
                    icon = infer_icon(&app_name, &title);
                }
                if window_class.is_empty() {
                    window_class = infer_window_class(&title, &app_name);
                }

                // Accurate active window determination
                let is_active = if !clean_active_uuid.is_empty() {
                    clean_uuid == clean_active_uuid || id.to_lowercase().contains(&clean_active_uuid)
                } else if !active_info.title.is_empty() {
                    title.trim().eq_ignore_ascii_case(active_info.title.trim())
                } else if !active_info.class.is_empty() && !window_class.is_empty() {
                    window_class.trim().eq_ignore_ascii_case(active_info.class.trim())
                } else {
                    false
                };

                windows.push(OpenWindowItem {
                    id,
                    uuid,
                    title,
                    app_name,
                    window_class,
                    icon,
                    is_active,
                });
            }
        }
    }

    windows
}

/// Natively focuses and raises an open window in KDE Plasma 6 Wayland
pub fn focus_window_by_id(id: &str) -> Result<(), String> {
    let qdbus = get_qdbus_bin();
    let status = Command::new(qdbus)
        .args(["org.kde.KWin", "/WindowsRunner", "org.kde.krunner1.Run", id, ""])
        .status()
        .map_err(|e| format!("Failed to focus window: {}", e))?;

    if status.success() {
        // Optimistically set active window
        let clean_uuid = id.trim_start_matches("0_").to_string();
        update_current_active_window(clean_uuid, String::new(), String::new());
        Ok(())
    } else {
        Err(format!("qdbus command exited with error status {:?}", status))
    }
}

/// Focuses an open application window by fuzzy name, title, or class
#[tauri::command]
pub fn focus_app_or_window(query: &str) -> Result<String, String> {
    let clean = query.trim();
    if clean.is_empty() {
        return Err("Nombre de ventana o aplicación no especificado.".to_string());
    }
    let lower_target = clean.to_lowercase();

    // 1. Check open windows
    let windows = get_open_windows();
    if let Some(win) = windows.iter().find(|w| {
        w.id == clean
            || w.app_name.to_lowercase() == lower_target
            || w.app_name.to_lowercase().contains(&lower_target)
            || lower_target.contains(&w.app_name.to_lowercase())
            || w.window_class.to_lowercase().contains(&lower_target)
            || lower_target.contains(&w.window_class.to_lowercase())
            || w.title.to_lowercase().contains(&lower_target)
    }) {
        focus_window_by_id(&win.id)?;
        return Ok(format!("Enfocada la ventana '{}' ({})", win.app_name, win.title));
    }

    // 2. Fallback: try wmctrl -a
    if let Ok(status) = Command::new("wmctrl").arg("-a").arg(clean).status() {
        if status.success() {
            return Ok(format!("Enfocada la aplicación '{}' vía wmctrl", clean));
        }
    }

    Err(format!("No se encontró ninguna ventana abierta que coincida con '{}'.", clean))
}

fn run_kwin_window_action(uuid_or_id: &str, action: &str) -> Result<(), String> {
    let clean_target = uuid_or_id
        .trim_start_matches("0_")
        .trim_matches('{')
        .trim_matches('}')
        .trim()
        .to_lowercase();

    if clean_target.is_empty() {
        return Err("Identificador de ventana vacío.".to_string());
    }

    let qdbus = get_qdbus_bin();
    let script_content = match action {
        "minimize" => format!(r#"
var target = "{clean_target}";
var wins = workspace.windowList();
for (var i = 0; i < wins.length; ++i) {{
    var id = wins[i].internalId ? wins[i].internalId.toString().toLowerCase() : "";
    var cls = wins[i].resourceClass ? wins[i].resourceClass.toString().toLowerCase() : "";
    var cap = wins[i].caption ? wins[i].caption.toString().toLowerCase() : "";
    if ((target.length > 5 && id.indexOf(target) !== -1) || cls === target || cls.indexOf(target) !== -1 || cap.indexOf(target) !== -1) {{
        wins[i].minimized = !wins[i].minimized;
        break;
    }}
}}
"#),
        "maximize" => format!(r#"
var target = "{clean_target}";
var wins = workspace.windowList();
for (var i = 0; i < wins.length; ++i) {{
    var id = wins[i].internalId ? wins[i].internalId.toString().toLowerCase() : "";
    var cls = wins[i].resourceClass ? wins[i].resourceClass.toString().toLowerCase() : "";
    var cap = wins[i].caption ? wins[i].caption.toString().toLowerCase() : "";
    if ((target.length > 5 && id.indexOf(target) !== -1) || cls === target || cls.indexOf(target) !== -1 || cap.indexOf(target) !== -1) {{
        var isMax = (wins[i].maximizeHorizontal === 2 || wins[i].maximizeHorizontal === 1) && (wins[i].maximizeVertical === 2 || wins[i].maximizeVertical === 1);
        wins[i].setMaximize(!isMax, !isMax);
        break;
    }}
}}
"#),
        "close" => format!(r#"
var target = "{clean_target}";
var wins = workspace.windowList();
for (var i = 0; i < wins.length; ++i) {{
    var id = wins[i].internalId ? wins[i].internalId.toString().toLowerCase() : "";
    var cls = wins[i].resourceClass ? wins[i].resourceClass.toString().toLowerCase() : "";
    var cap = wins[i].caption ? wins[i].caption.toString().toLowerCase() : "";
    if ((target.length > 5 && id.indexOf(target) !== -1) || cls === target || cls.indexOf(target) !== -1 || cap.indexOf(target) !== -1) {{
        wins[i].closeWindow();
        break;
    }}
}}
"#),
        _ => return Err("Acción de ventana no soportada.".to_string()),
    };

    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let script_path = format!("/tmp/kwin_action_{}_{}.js", std::process::id(), ts);
    if let Err(e) = std::fs::write(&script_path, script_content) {
        return Err(format!("Error escribiendo script KWin: {}", e));
    }

    let script_name = format!("dynamictopbar_action_{}_{}", action, ts);
    let _ = Command::new(qdbus)
        .args(["org.kde.KWin", "/Scripting", "org.kde.kwin.Scripting.unloadScript", &script_name])
        .output();

    let load = Command::new(qdbus)
        .args(["org.kde.KWin", "/Scripting", "org.kde.kwin.Scripting.loadScript", &script_path, &script_name])
        .output();

    if let Ok(res) = load {
        if res.status.success() {
            let _ = Command::new(qdbus)
                .args(["org.kde.KWin", "/Scripting", "org.kde.kwin.Scripting.start"])
                .output();
            let _ = Command::new(qdbus)
                .args(["org.kde.KWin", "/Scripting", "org.kde.kwin.Scripting.unloadScript", &script_name])
                .output();
            let _ = std::fs::remove_file(&script_path);
            return Ok(());
        }
    }

    let _ = std::fs::remove_file(&script_path);
    Err("Fallo al ejecutar acción de ventana en KWin vía D-Bus.".to_string())
}

/// Natively toggles window minimized state in KDE Plasma 6 Wayland
#[tauri::command]
pub fn minimize_window(id: String) -> Result<(), String> {
    run_kwin_window_action(&id, "minimize")
}

/// Natively toggles window maximized state in KDE Plasma 6 Wayland
#[tauri::command]
pub fn maximize_window(id: String) -> Result<(), String> {
    run_kwin_window_action(&id, "maximize")
}

/// Gracefully closes a window in KDE Plasma 6 Wayland using standard closeWindow event
#[tauri::command]
pub fn close_window_cleanly(id: String) -> Result<(), String> {
    run_kwin_window_action(&id, "close")
}

/// Focuses the last active user application window (Antigravity IDE, browser, terminal, etc.),
/// never focusing dynamictopbar itself. Used prior to screen captures.
pub fn focus_target_user_window() -> Result<(), String> {
    if let Some(target) = get_last_user_window() {
        if !target.uuid.is_empty() {
            let runner_id = format!("0_{}", target.uuid);
            if focus_window_by_id(&runner_id).is_ok() {
                eprintln!("[Windows] Successfully focused last user window by UUID: {}", runner_id);
                return Ok(());
            }
        }
        if !target.title.is_empty() {
            if focus_app_or_window(&target.title).is_ok() {
                eprintln!("[Windows] Successfully focused last user window by title: {}", target.title);
                return Ok(());
            }
        }
    }

    // Fallback: Query open windows and pick the first non-dynamictopbar window
    let open_wins = get_open_windows();
    if let Some(w) = open_wins.iter().find(|w| {
        !w.window_class.eq_ignore_ascii_case("dynamictopbar")
            && !w.window_class.eq_ignore_ascii_case("enigmaos")
            && !w.title.eq_ignore_ascii_case("DynamicTopBar")
            && !w.title.eq_ignore_ascii_case("EnigmaOS")
            && !w.title.eq_ignore_ascii_case("BottomDock")
            && !w.title.eq_ignore_ascii_case("EnigmaDock")
            && !w.title.trim().is_empty()
    }) {
        if focus_window_by_id(&w.id).is_ok() {
            eprintln!("[Windows] Fallback focused open window: {} ({})", w.app_name, w.id);
            return Ok(());
        }
    }

    Err("No se encontró ventana de usuario válida para enfocar.".to_string())
}

/// Generates a human-readable active desktop context summary
#[tauri::command]
pub fn get_active_desktop_context() -> String {
    let windows = get_open_windows();
    let active_win = windows.iter().find(|w| w.is_active);
    let active_info = get_current_active_window();

    let mut out = String::new();
    if let Some(win) = active_win {
        out.push_str(&format!(
            "🪟 **Ventana activa en foco**: **{}**\n- Título: *{}*\n- Clase: `{}`\n\n",
            win.app_name, win.title, win.window_class
        ));
    } else if !active_info.title.is_empty() || !active_info.class.is_empty() {
        let app_name = if !active_info.class.is_empty() {
            infer_app_name(&active_info.title, &active_info.class)
        } else {
            infer_app_name(&active_info.title, "")
        };
        out.push_str(&format!(
            "🪟 **Ventana activa en foco**: **{}**\n- Título: *{}*\n- Clase: `{}`\n\n",
            app_name, active_info.title, active_info.class
        ));
    } else {
        out.push_str("🪟 **Ventana activa en foco**: Escritorio / Sin ventana activa identificada\n\n");
    }

    let background_wins: Vec<_> = windows.iter().filter(|w| !w.is_active).collect();
    if !background_wins.is_empty() {
        out.push_str("📑 **Otras ventanas abiertas**:\n");
        for w in background_wins {
            out.push_str(&format!("- **{}**: *{}*\n", w.app_name, w.title));
        }
        out.push('\n');
    }

    let active_proc = crate::telemetry::get_current_active_app();
    if !active_proc.is_empty() {
        out.push_str(&format!("⚙️ **Actividad reciente registrada**: {}\n", active_proc));
    }

    out.trim().to_string()
}

/// Spawns a background thread that polls for window changes every 1.5 seconds
/// and emits `open_windows_changed` to keep all docks synchronized
pub fn start_window_poller(app_handle: AppHandle) {
    std::thread::spawn(move || {
        let mut last_windows: Vec<OpenWindowItem> = Vec::new();

        loop {
            std::thread::sleep(Duration::from_millis(1500));
            let current = get_open_windows();

            if current != last_windows {
                last_windows = current.clone();
                let _ = app_handle.emit("open_windows_changed", current);
            }
        }
    });
}

#[allow(dead_code)]
static LAST_SNAPSHOT_REQUEST: AtomicU64 = AtomicU64::new(0);

#[allow(dead_code)]
fn trigger_background_window_snapshot(uuid: String) {
    if uuid.is_empty() {
        return;
    }
    let clean_uuid = uuid.trim_matches('{').trim_matches('}').trim().to_string();
    if clean_uuid.is_empty() {
        return;
    }

    let now_ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;

    LAST_SNAPSHOT_REQUEST.store(now_ts, Ordering::SeqCst);

    std::thread::spawn(move || {
        // Debounce delay de 900ms para capturar rápidamente en cuanto el usuario se posa en la ventana
        std::thread::sleep(Duration::from_millis(900));

        let current_ts = LAST_SNAPSHOT_REQUEST.load(Ordering::SeqCst);
        if current_ts != now_ts {
            return;
        }

        let current_active = get_current_active_window();
        let curr_clean = current_active.uuid.trim_matches('{').trim_matches('}').trim();
        if curr_clean != clean_uuid {
            return;
        }

        let is_self = current_active.class.eq_ignore_ascii_case("dynamictopbar")
            || current_active.class.eq_ignore_ascii_case("enigmaos")
            || current_active.title.eq_ignore_ascii_case("DynamicTopBar")
            || current_active.title.eq_ignore_ascii_case("EnigmaOS")
            || current_active.title.eq_ignore_ascii_case("BottomDock")
            || current_active.title.eq_ignore_ascii_case("EnigmaDock");
        if is_self {
            return;
        }

        let _ = capture_window_thumbnail_to_disk(&clean_uuid);
    });
}

pub fn capture_window_thumbnail_to_disk(clean_uuid: &str) -> Result<String, String> {
    let tmp_dir = std::path::Path::new("/tmp/dock_previews");
    let _ = std::fs::create_dir_all(tmp_dir);

    let persistent_dir = dirs_fallback_data_dir().join("dynamictopbar").join("previews");
    let _ = std::fs::create_dir_all(&persistent_dir);

    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();

    let temp_png = format!("/tmp/dock_previews/temp_{}_{}.png", clean_uuid, ts);
    let target_jpg = format!("/tmp/dock_previews/{}.jpg", clean_uuid);
    let persistent_jpg = persistent_dir.join(format!("{}.jpg", clean_uuid));

    let status = Command::new("spectacle")
        .args(["-i", "-a", "-b", "-n", "-o", &temp_png])
        .status()
        .map_err(|e| format!("Spectacle error: {}", e))?;

    if !status.success() || !std::path::Path::new(&temp_png).exists() {
        return Err("Spectacle capture failed".to_string());
    }

    let opt_status = Command::new("magick")
        .args([
            &temp_png,
            "-resize",
            "400x",
            "-quality",
            "80",
            &target_jpg,
        ])
        .status();

    let _ = std::fs::remove_file(&temp_png);

    if opt_status.map(|s| s.success()).unwrap_or(false) && std::path::Path::new(&target_jpg).exists() {
        let _ = std::fs::copy(&target_jpg, &persistent_jpg);
        eprintln!("[Windows] 📸 Generated window thumbnail for uuid={}", clean_uuid);
        Ok(target_jpg)
    } else {
        Err("Failed to resize thumbnail with magick".to_string())
    }
}

/// Retrieves the base64-encoded thumbnail for a window ID or UUID if cached in /tmp or ~/.local/share
#[tauri::command]
pub fn get_window_thumbnail(id: String) -> Result<Option<String>, String> {
    let clean_uuid = id
        .trim_start_matches("0_")
        .trim_matches('{')
        .trim_matches('}')
        .trim()
        .to_string();

    if clean_uuid.is_empty() {
        return Ok(None);
    }

    // 1. Probar en /tmp/dock_previews
    let target_jpg = format!("/tmp/dock_previews/{}.jpg", clean_uuid);
    let path = std::path::Path::new(&target_jpg);

    if path.exists() {
        if let Ok(bytes) = std::fs::read(path) {
            if !bytes.is_empty() {
                let data_url = format!("data:image/jpeg;base64,{}", BASE64_STANDARD.encode(&bytes));
                return Ok(Some(data_url));
            }
        }
    }

    // 2. Probar en caché persistente
    let persistent_jpg = dirs_fallback_data_dir().join("dynamictopbar").join("previews").join(format!("{}.jpg", clean_uuid));
    if persistent_jpg.exists() {
        if let Ok(bytes) = std::fs::read(&persistent_jpg) {
            if !bytes.is_empty() {
                let data_url = format!("data:image/jpeg;base64,{}", BASE64_STANDARD.encode(&bytes));
                return Ok(Some(data_url));
            }
        }
    }

    Ok(None)
}

/// Asynchronously attempts to capture a thumbnail for a window if active, or returns the cached version
#[tauri::command]
pub fn capture_window_thumbnail_now(id: String) -> Result<Option<String>, String> {
    let clean_uuid = id
        .trim_start_matches("0_")
        .trim_matches('{')
        .trim_matches('}')
        .trim()
        .to_string();

    if clean_uuid.is_empty() {
        return Ok(None);
    }

    let active = get_current_active_window();
    let curr_clean = active.uuid.trim_matches('{').trim_matches('}').trim();

    if curr_clean == clean_uuid {
        if let Ok(path) = capture_window_thumbnail_to_disk(&clean_uuid) {
            if let Ok(bytes) = std::fs::read(&path) {
                let data_url = format!("data:image/jpeg;base64,{}", BASE64_STANDARD.encode(&bytes));
                return Ok(Some(data_url));
            }
        }
    }

    let target_jpg = format!("/tmp/dock_previews/{}.jpg", clean_uuid);
    if std::path::Path::new(&target_jpg).exists() {
        if let Ok(bytes) = std::fs::read(&target_jpg) {
            let data_url = format!("data:image/jpeg;base64,{}", BASE64_STANDARD.encode(&bytes));
            return Ok(Some(data_url));
        }
    }

    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_infer_window_class() {
        assert_eq!(infer_window_class("Spotify Free", "Spotify"), "spotify");
        assert_eq!(infer_window_class("Amigos - Discord", "Discord"), "discord");
        assert_eq!(infer_window_class("vision.rs - Antigravity IDE", "Code"), "antigravity-ide");
    }

    #[test]
    fn test_infer_app_name() {
        assert_eq!(infer_app_name("Spotify Free", "spotify.desktop"), "Spotify");
        assert_eq!(infer_app_name("Amigos - Discord", "discord.desktop"), "Discord");
    }

    #[test]
    fn test_get_active_desktop_context_does_not_panic() {
        let ctx = get_active_desktop_context();
        assert!(!ctx.is_empty(), "Context should return non-empty string");
    }

    #[test]
    fn test_active_window_matching() {
        update_current_active_window(
            "{4e0e583d-9000-4c70-becb-ea8a3dd85e2d}".to_string(),
            "Antigravity IDE".to_string(),
            "antigravity-ide".to_string(),
        );
        let active = get_current_active_window();
        assert_eq!(active.class, "antigravity-ide");
    }
}
