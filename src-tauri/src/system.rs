//! Native System Integrations for KDE Plasma 6 (Wayland)
//!
//! Provides real OS-level controls:
//! - Virtual Desktops switching via KWin D-Bus (`qdbus6`)
//! - Bluetooth power & device discovery via `bluetoothctl`
//! - Real-time CPU, RAM and Temperature telemetry via `sysinfo`
//! - Audio & Microphone hardware mute/volume via `wpctl`

use serde::{Deserialize, Serialize};
use std::process::Command;
use std::sync::{Mutex, OnceLock};
use sysinfo::{System, Components};
use tauri::{AppHandle, Emitter};

// =========================================================================
// 1. VIRTUAL DESKTOPS (KDE Plasma 6 KWin)
// =========================================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VirtualDesktopItem {
    pub id: String,
    pub index: u32,
    pub name: String,
    pub is_current: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DesktopsState {
    pub current_id: String,
    pub current_index: u32,
    pub desktops: Vec<VirtualDesktopItem>,
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

fn query_qdbus(args: &[&str]) -> Option<String> {
    let output = Command::new(get_qdbus_bin()).args(args).output().ok()?;
    if output.status.success() {
        Some(String::from_utf8_lossy(&output.stdout).trim().to_string())
    } else {
        None
    }
}

#[tauri::command]
pub fn get_virtual_desktops() -> DesktopsState {
    let current_id = query_qdbus(&[
        "org.kde.KWin",
        "/VirtualDesktopManager",
        "org.kde.KWin.VirtualDesktopManager.current",
    ])
    .unwrap_or_default();

    let literal_out = query_qdbus(&[
        "--literal",
        "org.kde.KWin",
        "/VirtualDesktopManager",
        "org.kde.KWin.VirtualDesktopManager.desktops",
    ])
    .unwrap_or_default();

    let mut desktops = Vec::new();
    let mut current_index = 0;

    // Parse literal output like:
    // [Argument: (uss) 0, "7d26539f-e556-416f-aa61-c5ebb0ffe107", "Escritorio 1"], [Argument: (uss) 1, "0188cb6a-12e1-4d83-a052-49e7a1f5595e", "Escritorio 2"]
    for part in literal_out.split("[Argument: (uss)") {
        if part.trim().is_empty() {
            continue;
        }
        let clean = part.split(']').next().unwrap_or("");
        let tokens: Vec<&str> = clean.split(',').map(|s| s.trim().trim_matches('"')).collect();
        if tokens.len() >= 3 {
            let idx = tokens[0].trim().parse::<u32>().unwrap_or(0);
            let id = tokens[1].trim().to_string();
            let name = tokens[2].trim().to_string();
            let is_cur = id == current_id;
            if is_cur {
                current_index = idx;
            }
            desktops.push(VirtualDesktopItem {
                id,
                index: idx,
                name,
                is_current: is_cur,
            });
        }
    }

    if desktops.is_empty() {
        // Fallback representation if D-Bus returned empty
        for i in 0..4 {
            desktops.push(VirtualDesktopItem {
                id: format!("desktop-{}", i),
                index: i,
                name: format!("Escritorio {}", i + 1),
                is_current: i == 0,
            });
        }
    }

    DesktopsState {
        current_id,
        current_index,
        desktops,
    }
}

#[tauri::command]
pub fn switch_virtual_desktop(target: String) -> Result<DesktopsState, String> {
    let state = get_virtual_desktops();
    let target_id = if let Ok(idx) = target.parse::<u32>() {
        // Match by index (0-based or 1-based)
        if let Some(d) = state.desktops.iter().find(|d| d.index == idx || d.index + 1 == idx) {
            d.id.clone()
        } else {
            target.clone()
        }
    } else {
        target.clone()
    };

    let qdbus_bin = if Command::new("which").arg("qdbus6").output().map(|o| o.status.success()).unwrap_or(false) {
        "qdbus6"
    } else {
        "qdbus"
    };

    let _ = Command::new(qdbus_bin)
        .args([
            "org.kde.KWin",
            "/VirtualDesktopManager",
            "org.kde.KWin.VirtualDesktopManager.current",
            &target_id,
        ])
        .status();

    Ok(get_virtual_desktops())
}

// =========================================================================
// 2. BLUETOOTH CONTROL (`bluetoothctl`)
// =========================================================================

pub fn is_bluetooth_available() -> bool {
    std::path::Path::new("/sys/class/bluetooth").exists()
        && std::fs::read_dir("/sys/class/bluetooth")
            .map(|mut it| it.next().is_some())
            .unwrap_or(false)
}

fn run_bluetoothctl(args: &[&str]) -> Option<String> {
    if !is_bluetooth_available() {
        return None;
    }
    Command::new("timeout")
        .arg("1.5s")
        .arg("bluetoothctl")
        .args(args)
        .output()
        .ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BluetoothDevice {
    pub mac: String,
    pub name: String,
    pub connected: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BluetoothState {
    pub powered: bool,
    pub controller_name: String,
    pub devices: Vec<BluetoothDevice>,
}

#[tauri::command]
pub fn get_bluetooth_status() -> BluetoothState {
    if !is_bluetooth_available() {
        return BluetoothState {
            powered: false,
            controller_name: "Sin adaptador Bluetooth".to_string(),
            devices: Vec::new(),
        };
    }

    let show_out = run_bluetoothctl(&["show"]).unwrap_or_default();
    let powered = show_out.contains("Powered: yes");
    let mut controller_name = "Controlador Bluetooth".to_string();
    for line in show_out.lines() {
        if line.trim().starts_with("Alias:") {
            controller_name = line.replace("Alias:", "").trim().to_string();
            break;
        } else if line.trim().starts_with("Name:") {
            controller_name = line.replace("Name:", "").trim().to_string();
        }
    }

    let dev_out = run_bluetoothctl(&["devices"]).unwrap_or_default();
    let conn_out = run_bluetoothctl(&["devices", "Connected"]).unwrap_or_default();

    let mut devices = Vec::new();
    for line in dev_out.lines() {
        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.len() >= 3 && parts[0] == "Device" {
            let mac = parts[1].to_string();
            let name = parts[2..].join(" ");
            let connected = conn_out.contains(&mac);
            devices.push(BluetoothDevice {
                mac,
                name,
                connected,
            });
        }
    }

    BluetoothState {
        powered,
        controller_name,
        devices,
    }
}

#[tauri::command]
pub fn toggle_bluetooth(power: bool) -> Result<BluetoothState, String> {
    if !is_bluetooth_available() {
        return Err("No hay adaptador Bluetooth disponible en el sistema".to_string());
    }
    let arg = if power { "on" } else { "off" };
    let _ = Command::new("timeout")
        .args(["1.5s", "bluetoothctl", "power", arg])
        .status();
    std::thread::sleep(std::time::Duration::from_millis(150));
    Ok(get_bluetooth_status())
}

#[tauri::command]
pub fn connect_bluetooth_device(mac: String) -> Result<bool, String> {
    if !is_bluetooth_available() {
        return Err("No hay adaptador Bluetooth disponible en el sistema".to_string());
    }
    let status = Command::new("timeout")
        .args(["3s", "bluetoothctl", "connect", &mac])
        .status()
        .map(|s| s.success())
        .unwrap_or(false);
    Ok(status)
}

// =========================================================================
// 3. SYSTEM TELEMETRY (CPU, RAM, TEMPS via sysinfo)
// =========================================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TelemetryData {
    pub cpu_usage: f32,
    pub cpu_temp: f32,
    pub cpu_brand: String,
    pub cpu_cores: usize,
    pub ram_used_gb: f32,
    pub ram_total_gb: f32,
    pub ram_usage: f32,
    pub wifi_ssid: String,
    pub wifi_enabled: bool,
}

static SYSTEM_MUTEX: Mutex<Option<System>> = Mutex::new(None);

#[tauri::command]
pub fn get_system_telemetry() -> TelemetryData {
    let mut lock = SYSTEM_MUTEX.lock().unwrap();
    if lock.is_none() {
        let mut sys = System::new_all();
        sys.refresh_all();
        *lock = Some(sys);
    }

    let sys = lock.as_mut().unwrap();
    sys.refresh_cpu();
    sys.refresh_memory();

    let cpu_usage = sys.global_cpu_info().cpu_usage();
    let cpu_brand = sys.cpus().first().map(|c| c.brand().to_string()).unwrap_or_else(|| "AMD Ryzen".to_string());
    let cpu_cores = sys.cpus().len();

    let total_ram_bytes = sys.total_memory();
    let used_ram_bytes = sys.used_memory();
    let ram_total_gb = total_ram_bytes as f32 / (1024.0 * 1024.0 * 1024.0);
    let ram_used_gb = used_ram_bytes as f32 / (1024.0 * 1024.0 * 1024.0);
    let ram_usage = if ram_total_gb > 0.0 { (ram_used_gb / ram_total_gb) * 100.0 } else { 0.0 };

    // Temperature from components or /sys/class/thermal
    let components = Components::new_with_refreshed_list();
    let mut cpu_temp: f32 = 42.0;
    for component in components.iter() {
        let label = component.label().to_lowercase();
        if label.contains("cpu") || label.contains("tctl") || label.contains("core") || label.contains("k10temp") {
            cpu_temp = component.temperature();
            break;
        }
    }

    // Wi-Fi SSID from nmcli
    let wifi_ssid = Command::new("nmcli")
        .args(["-t", "-f", "active,ssid", "dev", "wifi"])
        .output()
        .map(|o| {
            let s = String::from_utf8_lossy(&o.stdout);
            for line in s.lines() {
                if line.starts_with("yes:") {
                    return line.replace("yes:", "").trim().to_string();
                }
            }
            "Conectado".to_string()
        })
        .unwrap_or_else(|_| "Wi-Fi".to_string());

    let wifi_enabled = Command::new("nmcli")
        .args(["radio", "wifi"])
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim() == "enabled")
        .unwrap_or(true);

    TelemetryData {
        cpu_usage,
        cpu_temp,
        cpu_brand,
        cpu_cores,
        ram_used_gb,
        ram_total_gb,
        ram_usage,
        wifi_ssid,
        wifi_enabled,
    }
}

// =========================================================================
// 4. AUDIO & MIC CONTROLS (WirePlumber / PipeWire `wpctl`)
// =========================================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AudioState {
    pub volume: u32,
    pub is_muted: bool,
    pub is_mic_muted: bool,
}

#[tauri::command]
pub fn get_audio_status() -> AudioState {
    let out = Command::new("wpctl")
        .args(["get-volume", "@DEFAULT_AUDIO_SINK@"])
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
        .unwrap_or_default();

    // Output format: Volume: 0.50 [MUTED]
    let is_muted = out.contains("[MUTED]");
    let num_part = out.replace("Volume:", "").replace("[MUTED]", "").trim().to_string();
    let vol_float = num_part.parse::<f32>().unwrap_or(0.5);
    let volume = (vol_float * 100.0).round() as u32;

    let mic_out = Command::new("wpctl")
        .args(["get-volume", "@DEFAULT_AUDIO_SOURCE@"])
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
        .unwrap_or_default();
    let is_mic_muted = mic_out.contains("[MUTED]");

    AudioState {
        volume,
        is_muted,
        is_mic_muted,
    }
}

#[tauri::command]
pub fn toggle_audio_mute() -> Result<AudioState, String> {
    let _ = Command::new("wpctl")
        .args(["set-mute", "@DEFAULT_AUDIO_SINK@", "toggle"])
        .status();
    Ok(get_audio_status())
}

#[tauri::command]
pub fn toggle_mic_mute() -> Result<AudioState, String> {
    let _ = Command::new("wpctl")
        .args(["set-mute", "@DEFAULT_AUDIO_SOURCE@", "toggle"])
        .status();
    Ok(get_audio_status())
}

#[tauri::command]
pub fn set_audio_volume(percent: u32) -> Result<AudioState, String> {
    let frac = (percent as f32 / 100.0).min(1.0).max(0.0);
    let _ = Command::new("wpctl")
        .args(["set-volume", "@DEFAULT_AUDIO_SINK@", &format!("{:.2}", frac)])
        .status();
    Ok(get_audio_status())
}

// =========================================================================
// 5. BACKGROUND TELEMETRY POLLER (1s ticker)
// =========================================================================

pub fn start_system_poller(app_handle: AppHandle) {
    std::thread::spawn(move || {
        loop {
            let telemetry = get_system_telemetry();
            let _ = app_handle.emit("telemetry_update", telemetry);
            std::thread::sleep(std::time::Duration::from_millis(1000));
        }
    });
}

// =========================================================================
// 6. SYSTEM APP LAUNCHER & KRUNNER REPLACEMENT
// =========================================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppEntry {
    pub id: String,
    pub name: String,
    pub exec: String,
    pub icon: String,
    pub comment: String,
    pub categories: String,
    pub keywords: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecentDocEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
}

/// Reads the user's currently selected icon theme from KDE Plasma's ~/.config/kdeglobals
pub fn get_active_kde_icon_theme() -> String {
    if let Ok(home) = std::env::var("HOME") {
        let kdeglobals = std::path::PathBuf::from(home).join(".config/kdeglobals");
        if let Ok(content) = std::fs::read_to_string(kdeglobals) {
            let mut in_icons_section = false;
            for line in content.lines() {
                let trimmed = line.trim();
                if trimmed == "[Icons]" {
                    in_icons_section = true;
                    continue;
                }
                if in_icons_section && trimmed.starts_with('[') && trimmed.ends_with(']') {
                    break;
                }
                if in_icons_section && trimmed.starts_with("Theme=") {
                    let theme = trimmed.replace("Theme=", "").trim().to_string();
                    if !theme.is_empty() {
                        return theme;
                    }
                }
            }
        }
    }
    std::env::var("ICON_THEME").unwrap_or_else(|_| "breeze-dark".to_string())
}

static ICON_CACHE: Mutex<Option<std::collections::HashMap<String, String>>> = Mutex::new(None);
static SYSTEM_APPS_CACHE: Mutex<Option<(std::time::Instant, Vec<AppEntry>)>> = Mutex::new(None);

/// Resolves a FreeDesktop icon name to the user's active theme SVG/PNG on disk
pub fn resolve_desktop_icon_path(icon_name: &str) -> String {
    let clean = icon_name.trim();
    if clean.is_empty() {
        return String::new();
    }
    let p = std::path::Path::new(clean);
    if p.is_absolute() && p.exists() {
        return clean.to_string();
    }

    // Check in-memory icon cache first for instant 0ms hit
    if let Ok(mut lock) = ICON_CACHE.lock() {
        if lock.is_none() {
            *lock = Some(std::collections::HashMap::new());
        }
        if let Some(ref cache) = *lock {
            if let Some(cached_path) = cache.get(clean) {
                return cached_path.clone();
            }
        }
    }

    let resolved = resolve_desktop_icon_path_uncached(clean);

    // Save to cache
    if let Ok(mut lock) = ICON_CACHE.lock() {
        if let Some(ref mut cache) = *lock {
            cache.insert(clean.to_string(), resolved.clone());
        }
    }

    resolved
}

fn resolve_desktop_icon_path_uncached(clean: &str) -> String {
    let home = std::env::var("HOME").unwrap_or_default();
    let active_theme = get_active_kde_icon_theme();

    // 1. Direct query via kiconfinder6 (KDE Plasma 6 query)
    // CRITICAL: kiconfinder6 prints theme warnings to stdout/stderr. Find the line that is an actual existing file path!
    if let Ok(output) = Command::new("kiconfinder6").arg(clean).output() {
        if output.status.success() {
            let stdout_str = String::from_utf8_lossy(&output.stdout);
            for line in stdout_str.lines() {
                let trimmed = line.trim();
                if trimmed.starts_with('/') 
                    && !trimmed.contains("unknown.png") 
                    && !trimmed.contains("missing.png")
                    && std::path::Path::new(trimmed).exists() {
                    return trimmed.to_string();
                }
            }
        }
    }

    // Try common alternate names with kiconfinder6 (e.g. firefox -> org.mozilla.firefox, code -> visual-studio-code)
    let alt_candidates: &[&str] = match clean {
        "firefox" => &["org.mozilla.firefox", "firefox-esr", "mozilla-firefox"],
        "spotify" => &["spotify-client", "com.spotify.Client"],
        "discord" => &["com.discordapp.Discord", "discord-canary"],
        "antigravity" | "antigravity-ide" => &["code", "com.visualstudio.code", "visual-studio-code"],
        "opera" => &["opera-stable", "com.opera.Opera"],
        _ => &[],
    };

    for alt in alt_candidates {
        if let Ok(output) = Command::new("kiconfinder6").arg(alt).output() {
            if output.status.success() {
                let stdout_str = String::from_utf8_lossy(&output.stdout);
                for line in stdout_str.lines() {
                    let trimmed = line.trim();
                    if trimmed.starts_with('/') 
                        && !trimmed.contains("unknown.png") 
                        && !trimmed.contains("missing.png")
                        && std::path::Path::new(trimmed).exists() {
                        return trimmed.to_string();
                    }
                }
            }
        }
    }

    // 2. Comprehensive hierarchical theme search chain
    let mut theme_roots = Vec::new();

    // A. Active theme from KDE (e.g. Ultimate Edition Dark Glass)
    theme_roots.push(format!("{}/.local/share/icons/{}", home, active_theme));
    theme_roots.push(format!("/usr/share/icons/{}", active_theme));

    // B. Major installed Linux themes
    theme_roots.push(format!("{}/.local/share/icons/BeautyFolders", home));
    theme_roots.push(format!("{}/.local/share/icons/BeautyLine", home));
    theme_roots.push(format!("{}/.local/share/icons", home));
    theme_roots.push("/usr/share/icons/breeze-dark".to_string());
    theme_roots.push("/usr/share/icons/breeze".to_string());
    theme_roots.push("/usr/share/icons/Papirus-Dark".to_string());
    theme_roots.push("/usr/share/icons/Papirus".to_string());
    theme_roots.push("/usr/share/icons/Qogir-Dark".to_string());
    theme_roots.push("/usr/share/icons/Qogir".to_string());

    // C. Flatpak and Snap exported icons (Vital for Flatpak apps!)
    theme_roots.push(format!("{}/.local/share/flatpak/exports/share/icons/hicolor", home));
    theme_roots.push(format!("{}/.local/share/flatpak/exports/share/icons", home));
    theme_roots.push("/var/lib/flatpak/exports/share/icons/hicolor".to_string());
    theme_roots.push("/var/lib/flatpak/exports/share/icons".to_string());
    theme_roots.push("/var/lib/snapd/desktop/applications".to_string());

    // D. Universal hicolor & pixmaps
    theme_roots.push(format!("{}/.local/share/icons/hicolor", home));
    theme_roots.push("/usr/share/icons/hicolor".to_string());
    theme_roots.push("/usr/share/pixmaps".to_string());

    let sub_paths = [
        "apps/scalable",
        "scalable/apps",
        "256x256/apps",
        "apps/256",
        "apps/256x256",
        "128x128/apps",
        "apps/128",
        "apps/128x128",
        "64x64/apps",
        "apps/64",
        "apps/64x64",
        "48x48/apps",
        "apps/48",
        "apps/48x48",
        "32x32/apps",
        "apps/32",
        "apps/32x32",
        "24x24/apps",
        "apps/24",
        "devices/scalable",
        "devices/48x48",
        "devices",
        "categories/scalable",
        "categories/48x48",
        "categories",
        "places/scalable",
        "places/48x48",
        "apps",
        "",
    ];

    let exts = [".svg", ".png", ".xpm"];
    let mut names_to_check = vec![clean];
    names_to_check.extend_from_slice(alt_candidates);

    for root in &theme_roots {
        if !std::path::Path::new(root).exists() {
            continue;
        }
        for sub in &sub_paths {
            let base_dir = if sub.is_empty() {
                root.clone()
            } else {
                format!("{}/{}", root, sub)
            };
            if !std::path::Path::new(&base_dir).exists() {
                continue;
            }
            for name in &names_to_check {
                for ext in &exts {
                    let candidate = format!("{}/{}{}", base_dir, name, ext);
                    if std::path::Path::new(&candidate).exists() && !candidate.contains("unknown.png") {
                        return candidate;
                    }
                }
                let candidate = format!("{}/{}", base_dir, name);
                if std::path::Path::new(&candidate).exists() && !candidate.contains("unknown.png") {
                    return candidate;
                }
            }
        }
    }

    clean.to_string()
}

pub fn prewarm_system_apps() {
    let _ = get_system_apps();
}

#[tauri::command]
pub fn get_system_apps() -> Vec<AppEntry> {
    // Check in-memory cache first (valid for 5 minutes)
    if let Ok(lock) = SYSTEM_APPS_CACHE.lock() {
        if let Some((ref cached_at, ref apps)) = *lock {
            if cached_at.elapsed() < std::time::Duration::from_secs(300) {
                return apps.clone();
            }
        }
    }

    let mut apps = Vec::new();
    let mut seen_ids = std::collections::HashSet::new();

    let mut search_dirs = vec![
        std::path::PathBuf::from("/usr/share/applications"),
        std::path::PathBuf::from("/usr/local/share/applications"),
        std::path::PathBuf::from("/var/lib/flatpak/exports/share/applications"),
    ];

    if let Ok(home) = std::env::var("HOME") {
        search_dirs.push(std::path::PathBuf::from(format!("{}/.local/share/applications", home)));
        search_dirs.push(std::path::PathBuf::from(format!("{}/.local/share/flatpak/exports/share/applications", home)));
    }

    for dir in search_dirs {
        if !dir.exists() {
            continue;
        }
        if let Ok(entries) = std::fs::read_dir(dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.extension().and_then(|s| s.to_str()) != Some("desktop") {
                    continue;
                }
                let file_name = path.file_name().and_then(|s| s.to_str()).unwrap_or("").to_string();
                if file_name.is_empty() || seen_ids.contains(&file_name) {
                    continue;
                }

                // Filter out non-user daemons, KCM control modules, and internal handlers
                let lower_id = file_name.to_lowercase();
                if lower_id.contains("avahi-discover")
                    || lower_id.contains("breezestyleconfig")
                    || lower_id.contains("eos-quickstart")
                    || lower_id.contains("url-handler")
                    || lower_id.contains("kwin_killer")
                    || lower_id.contains("kcm_")
                    || lower_id.contains("okularapplication_")
                    || lower_id.contains("xdg-desktop-portal")
                    || lower_id.contains("mimeinfo")
                {
                    continue;
                }

                if let Ok(content) = std::fs::read_to_string(&path) {
                    let mut name = String::new();
                    let mut exec = String::new();
                    let mut icon = String::new();
                    let mut comment = String::new();
                    let mut categories = String::new();
                    let mut keywords = String::new();
                    let mut no_display = false;
                    let mut is_in_entry = false;

                    for line in content.lines() {
                        let trimmed = line.trim();
                        if trimmed == "[Desktop Entry]" {
                            is_in_entry = true;
                            continue;
                        }
                        if trimmed.starts_with('[') && trimmed.ends_with(']') {
                            if is_in_entry {
                                break;
                            }
                            continue;
                        }
                        if !is_in_entry {
                            continue;
                        }

                        if trimmed.starts_with("Name=") && name.is_empty() {
                            name = trimmed.replace("Name=", "").trim().to_string();
                        } else if trimmed.starts_with("Exec=") && exec.is_empty() {
                            exec = trimmed.replace("Exec=", "").trim().to_string();
                        } else if trimmed.starts_with("Icon=") && icon.is_empty() {
                            icon = trimmed.replace("Icon=", "").trim().to_string();
                        } else if trimmed.starts_with("Comment=") && comment.is_empty() {
                            comment = trimmed.replace("Comment=", "").trim().to_string();
                        } else if trimmed.starts_with("GenericName=") {
                            let gen = trimmed.replace("GenericName=", "").trim().to_string();
                            if !gen.is_empty() && !comment.contains(&gen) {
                                if comment.is_empty() {
                                    comment = gen;
                                } else {
                                    comment = format!("{} • {}", gen, comment);
                                }
                            }
                        } else if trimmed.starts_with("Categories=") && categories.is_empty() {
                            categories = trimmed.replace("Categories=", "").trim().to_string();
                        } else if trimmed.starts_with("Keywords=") && keywords.is_empty() {
                            keywords = trimmed.replace("Keywords=", "").trim().to_string();
                        } else if trimmed.starts_with("NoDisplay=true") {
                            no_display = true;
                        }
                    }

                    if !no_display && !name.is_empty() && !exec.is_empty() {
                        seen_ids.insert(file_name.clone());
                        let resolved_icon = resolve_desktop_icon_path(&icon);
                        apps.push(AppEntry {
                            id: file_name,
                            name,
                            exec,
                            icon: resolved_icon,
                            comment,
                            categories,
                            keywords,
                        });
                    }
                }
            }
        }
    }

    apps.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));

    // Store in cache
    if let Ok(mut lock) = SYSTEM_APPS_CACHE.lock() {
        *lock = Some((std::time::Instant::now(), apps.clone()));
    }

    apps
}

/// Returns recently accessed native files from FreeDesktop ~/.local/share/recently-used.xbel
#[tauri::command]
pub fn get_recent_documents() -> Vec<RecentDocEntry> {
    let home = std::env::var("HOME").unwrap_or_default();
    let xbel_path = format!("{}/.local/share/recently-used.xbel", home);
    let mut docs = Vec::new();
    let mut seen = std::collections::HashSet::new();

    if let Ok(content) = std::fs::read_to_string(&xbel_path) {
        // Collect matches in reverse to get most recent first
        let mut bookmarks: Vec<&str> = content.lines().filter(|l| l.contains("<bookmark href=\"file://")).collect();
        bookmarks.reverse();

        for line in bookmarks {
            if let Some(start) = line.find("href=\"file://") {
                let rem = &line[start + 13..];
                if let Some(end) = rem.find('"') {
                    let raw_url = &rem[..end];
                    // Percent decode URL (e.g. %20 -> space)
                    let decoded_path = url::form_urlencoded::parse(raw_url.as_bytes())
                        .map(|(k, _)| k.to_string())
                        .collect::<Vec<String>>()
                        .join("");
                    let real_path = if decoded_path.is_empty() { raw_url.to_string() } else { decoded_path };

                    let p = std::path::Path::new(&real_path);
                    if p.exists() && !seen.contains(&real_path) {
                        seen.insert(real_path.clone());
                        let is_dir = p.is_dir();
                        let file_name = p.file_name().and_then(|s| s.to_str()).unwrap_or(&real_path).to_string();
                        docs.push(RecentDocEntry {
                            name: file_name,
                            path: real_path,
                            is_dir,
                        });
                        if docs.len() >= 25 {
                            break;
                        }
                    }
                }
            }
        }
    }

    docs
}

/// Opens any file or folder with the default Linux application (xdg-open)
#[tauri::command]
pub fn open_native_path(path: String) -> Result<bool, String> {
    let _ = Command::new("xdg-open").arg(&path).spawn().map_err(|e| e.to_string())?;
    Ok(true)
}

/// Runs a terminal command inside Konsole or native shell
#[tauri::command]
pub fn run_terminal_command(command: String) -> Result<bool, String> {
    let clean = command.trim();
    if clean.is_empty() {
        return Ok(true);
    }
    let _ = Command::new("konsole")
        .args(["-e", "bash", "-c", &format!("{}; echo ''; read -n 1 -s -r -p 'Presiona cualquier tecla para salir...'", clean)])
        .spawn();
    Ok(true)
}

fn record_app_launch_internal(desktop_id: &str) {
    if let Ok(home) = std::env::var("HOME") {
        let dir = std::path::PathBuf::from(home).join(".config/enigma_launcher");
        let _ = std::fs::create_dir_all(&dir);
        let file = dir.join("app_usage.json");
        let mut map: std::collections::HashMap<String, u32> = if file.exists() {
            std::fs::read_to_string(&file)
                .ok()
                .and_then(|s| serde_json::from_str(&s).ok())
                .unwrap_or_default()
        } else {
            std::collections::HashMap::new()
        };
        *map.entry(desktop_id.to_string()).or_insert(0) += 1;
        if let Ok(json) = serde_json::to_string_pretty(&map) {
            let _ = std::fs::write(&file, json);
        }
    }
}

#[tauri::command]
pub fn record_app_launch(desktop_id: String) -> Result<bool, String> {
    record_app_launch_internal(&desktop_id);
    Ok(true)
}

#[tauri::command]
pub fn get_app_usage_counts() -> std::collections::HashMap<String, u32> {
    if let Ok(home) = std::env::var("HOME") {
        let file = std::path::PathBuf::from(home).join(".config/enigma_launcher/app_usage.json");
        if file.exists() {
            return std::fs::read_to_string(&file)
                .ok()
                .and_then(|s| serde_json::from_str(&s).ok())
                .unwrap_or_default();
        }
    }
    std::collections::HashMap::new()
}

#[tauri::command]
pub fn launch_system_app(desktop_id: String, exec: String) -> Result<bool, String> {
    record_app_launch_internal(&desktop_id);
    // 1. Try launching with gtk-launch first
    if desktop_id.ends_with(".desktop") {
        if let Ok(status) = Command::new("gtk-launch").arg(&desktop_id).status() {
            if status.success() {
                return Ok(true);
            }
        }
    }

    // 2. Fallback: clean exec string (remove %u, %U, %f, %F, etc.) and launch in background
    let clean_exec: String = exec
        .split_whitespace()
        .filter(|w| !w.starts_with('%'))
        .collect::<Vec<&str>>()
        .join(" ");

    let _ = Command::new("sh")
        .args(["-c", &format!("{} &", clean_exec)])
        .spawn();

    Ok(true)
}

#[tauri::command]
pub fn execute_system_action(action: String) -> Result<bool, String> {
    match action.as_str() {
        "poweroff" | "shutdown" | "apagar" => {
            let _ = Command::new("systemctl").arg("poweroff").spawn();
        }
        "reboot" | "reiniciar" => {
            let _ = Command::new("systemctl").arg("reboot").spawn();
        }
        "lock" | "bloquear" => {
            let _ = Command::new("loginctl").arg("lock-session").spawn();
        }
        "suspend" | "suspender" => {
            let _ = Command::new("systemctl").arg("suspend").spawn();
        }
        _ => return Err(format!("Acción desconocida: {}", action)),
    }
    Ok(true)
}

// =========================================================================
// 7. DETAILED BLUETOOTH WITH 3 TIERS (Connected, Paired, Available)
// =========================================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DetailedBluetoothState {
    pub powered: bool,
    pub connected_devices: Vec<BluetoothDevice>,
    pub paired_devices: Vec<BluetoothDevice>,
    pub available_devices: Vec<BluetoothDevice>,
}

#[tauri::command]
pub fn get_detailed_bluetooth_status() -> DetailedBluetoothState {
    if !is_bluetooth_available() {
        return DetailedBluetoothState {
            powered: false,
            connected_devices: Vec::new(),
            paired_devices: Vec::new(),
            available_devices: Vec::new(),
        };
    }

    let show_out = run_bluetoothctl(&["show"]).unwrap_or_default();
    let powered = show_out.contains("Powered: yes");

    let conn_out = run_bluetoothctl(&["devices", "Connected"]).unwrap_or_default();
    let paired_out = run_bluetoothctl(&["devices", "Paired"]).unwrap_or_default();
    let all_out = run_bluetoothctl(&["devices"]).unwrap_or_default();

    let parse_dev_lines = |raw: &str| -> Vec<BluetoothDevice> {
        let mut list = Vec::new();
        for line in raw.lines() {
            let parts: Vec<&str> = line.split_whitespace().collect();
            if parts.len() >= 3 && parts[0] == "Device" {
                let mac = parts[1].to_string();
                let name = parts[2..].join(" ");
                list.push(BluetoothDevice {
                    mac,
                    name,
                    connected: false,
                });
            }
        }
        list
    };

    let mut connected_devices = parse_dev_lines(&conn_out);
    for dev in &mut connected_devices {
        dev.connected = true;
    }
    let conn_macs: std::collections::HashSet<String> = connected_devices.iter().map(|d| d.mac.clone()).collect();

    let raw_paired = parse_dev_lines(&paired_out);
    let paired_devices: Vec<BluetoothDevice> = raw_paired
        .into_iter()
        .filter(|d| !conn_macs.contains(&d.mac))
        .collect();
    let paired_macs: std::collections::HashSet<String> = paired_devices.iter().map(|d| d.mac.clone()).collect();

    let raw_all = parse_dev_lines(&all_out);
    let available_devices: Vec<BluetoothDevice> = raw_all
        .into_iter()
        .filter(|d| !conn_macs.contains(&d.mac) && !paired_macs.contains(&d.mac))
        .collect();

    DetailedBluetoothState {
        powered,
        connected_devices,
        paired_devices,
        available_devices,
    }
}

#[tauri::command]
pub fn bluetooth_disconnect_device(mac: String) -> Result<bool, String> {
    if !is_bluetooth_available() {
        return Err("No hay adaptador Bluetooth disponible en el sistema".to_string());
    }
    let status = Command::new("timeout")
        .args(["2s", "bluetoothctl", "disconnect", &mac])
        .status()
        .map(|s| s.success())
        .unwrap_or(false);
    Ok(status)
}

#[tauri::command]
pub fn bluetooth_unpair_device(mac: String) -> Result<bool, String> {
    if !is_bluetooth_available() {
        return Err("No hay adaptador Bluetooth disponible en el sistema".to_string());
    }
    let status = Command::new("timeout")
        .args(["2s", "bluetoothctl", "remove", &mac])
        .status()
        .map(|s| s.success())
        .unwrap_or(false);
    Ok(status)
}

#[tauri::command]
pub fn bluetooth_pair_device(mac: String) -> Result<bool, String> {
    if !is_bluetooth_available() {
        return Err("No hay adaptador Bluetooth disponible en el sistema".to_string());
    }
    let _ = Command::new("timeout").args(["3s", "bluetoothctl", "pair", &mac]).status();
    let status = Command::new("timeout")
        .args(["3s", "bluetoothctl", "connect", &mac])
        .status()
        .map(|s| s.success())
        .unwrap_or(false);
    Ok(status)
}

// =========================================================================
// 8. DETAILED NETWORK & WI-FI (Ethernet vs Wi-Fi vs Disconnected)
// =========================================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WifiNetworkItem {
    pub in_use: bool,
    pub ssid: String,
    pub signal: u32,
    pub security: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NetworkDetails {
    pub conn_type: String,       // "ethernet" | "wifi" | "none"
    pub state: String,           // "connected" | "disconnected"
    pub device: String,          // e.g. "enp4s0"
    pub name: String,            // e.g. "Conexión cableada 1"
    pub speed_label: String,     // e.g. "1.0 Gbps" or "100 Mbps"
    pub ip_address: String,      // e.g. "192.168.1.136"
    pub wifi_networks: Vec<WifiNetworkItem>,
}

#[tauri::command]
pub fn get_detailed_network_status() -> NetworkDetails {
    let dev_status = Command::new("nmcli")
        .args(["-t", "-f", "DEVICE,TYPE,STATE,CONNECTION", "dev", "status"])
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
        .unwrap_or_default();

    let mut conn_type = "none".to_string();
    let mut state = "disconnected".to_string();
    let mut device = "".to_string();
    let mut name = "Sin conexión".to_string();
    let mut speed_label = "0 Mbps".to_string();
    let mut ip_address = "".to_string();
    let mut wifi_networks = Vec::new();

    // Check lines for connected devices
    for line in dev_status.lines() {
        let parts: Vec<&str> = line.split(':').collect();
        if parts.len() >= 4 {
            let dev = parts[0].trim();
            let dtype = parts[1].trim();
            let dstate = parts[2].trim();
            let conn = parts[3].trim();

            if (dstate == "connected" || dstate == "conectado") && dtype != "loopback" {
                if dtype == "ethernet" {
                    conn_type = "ethernet".to_string();
                    state = "connected".to_string();
                    device = dev.to_string();
                    name = if !conn.is_empty() { conn.to_string() } else { "Conexión Cableada".to_string() };

                    // Read interface speed
                    let speed_path = format!("/sys/class/net/{}/speed", dev);
                    if let Ok(raw_speed) = std::fs::read_to_string(&speed_path) {
                        if let Ok(mbps) = raw_speed.trim().parse::<u32>() {
                            if mbps >= 1000 {
                                speed_label = format!("{:.1} Gbps", mbps as f32 / 1000.0);
                            } else {
                                speed_label = format!("{} Mbps", mbps);
                            }
                        } else {
                            speed_label = "1.0 Gbps".to_string();
                        }
                    } else {
                        speed_label = "1.0 Gbps".to_string();
                    }

                    // Query IP
                    if let Ok(out) = Command::new("nmcli").args(["-g", "IP4.ADDRESS", "dev", "show", dev]).output() {
                        let ip = String::from_utf8_lossy(&out.stdout).trim().to_string();
                        ip_address = ip.split('/').next().unwrap_or("").to_string();
                    }
                    break;
                } else if dtype == "wifi" && conn_type != "ethernet" {
                    conn_type = "wifi".to_string();
                    state = "connected".to_string();
                    device = dev.to_string();
                    name = if !conn.is_empty() { conn.to_string() } else { "Wi-Fi".to_string() };
                    speed_label = "300 Mbps".to_string();

                    // Query IP
                    if let Ok(out) = Command::new("nmcli").args(["-g", "IP4.ADDRESS", "dev", "show", dev]).output() {
                        let ip = String::from_utf8_lossy(&out.stdout).trim().to_string();
                        ip_address = ip.split('/').next().unwrap_or("").to_string();
                    }
                }
            }
        }
    }

    // Only query Wi-Fi list if not ethernet or if wifi is the primary interface
    if conn_type != "ethernet" {
        let wifi_out = Command::new("nmcli")
            .args(["-t", "-f", "IN-USE,SSID,SIGNAL,SECURITY", "dev", "wifi", "list"])
            .output()
            .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
            .unwrap_or_default();

        for line in wifi_out.lines() {
            let parts: Vec<&str> = line.split(':').collect();
            if parts.len() >= 4 {
                let in_use = parts[0].trim() == "*";
                let ssid = parts[1].trim().to_string();
                let signal = parts[2].trim().parse::<u32>().unwrap_or(0);
                let security = parts[3].trim().to_string();

                if !ssid.is_empty() && !wifi_networks.iter().any(|w: &WifiNetworkItem| w.ssid == ssid) {
                    wifi_networks.push(WifiNetworkItem {
                        in_use,
                        ssid,
                        signal,
                        security,
                    });
                }
            }
        }
    }

    NetworkDetails {
        conn_type,
        state,
        device,
        name,
        speed_label,
        ip_address,
        wifi_networks,
    }
}

#[tauri::command]
pub fn connect_wifi_network(ssid: String, password: Option<String>) -> Result<bool, String> {
    let mut cmd = Command::new("nmcli");
    cmd.args(["dev", "wifi", "connect", &ssid]);
    if let Some(pwd) = password {
        if !pwd.is_empty() {
            cmd.args(["password", &pwd]);
        }
    }
    let status = cmd.status().map(|s| s.success()).unwrap_or(false);
    Ok(status)
}

#[tauri::command]
pub fn disconnect_network(device: String) -> Result<bool, String> {
    let status = Command::new("nmcli")
        .args(["dev", "disconnect", &device])
        .status()
        .map(|s| s.success())
        .unwrap_or(false);
    Ok(status)
}

// =========================================================================
// 9. DETAILED AUDIO CONTROL (Per-Device & Per-App Streams with pactl)
// =========================================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AudioSinkItem {
    pub id: u32,
    pub name: String,
    pub description: String,
    pub volume: u32,
    pub is_muted: bool,
    pub is_default: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AudioAppStream {
    pub id: u32,
    pub sink_id: u32,
    pub app_name: String,
    pub icon_name: String,
    pub volume: u32,
    pub is_muted: bool,
    pub media_title: String,
    pub media_artist: String,
    pub media_art_url: String,
    pub is_video: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DetailedAudioState {
    pub master_volume: u32,
    pub is_master_muted: bool,
    pub is_mic_muted: bool,
    pub sinks: Vec<AudioSinkItem>,
    pub apps: Vec<AudioAppStream>,
}

#[tauri::command]
pub fn get_detailed_audio_status() -> DetailedAudioState {
    let master = get_audio_status();
    let default_sink_name = Command::new("pactl")
        .arg("get-default-sink")
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_default();

    // 1. Parse hardware output sinks
    let sinks_raw = Command::new("pactl")
        .args(["list", "sinks"])
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
        .unwrap_or_default();

    let mut sinks = Vec::new();
    let mut cur_sink_id: Option<u32> = None;
    let mut cur_sink_name = String::new();
    let mut cur_sink_desc = String::new();
    let mut cur_sink_vol: u32 = 50;
    let mut cur_sink_muted = false;

    for line in sinks_raw.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("Sink #") {
            if let Some(id) = cur_sink_id {
                let is_default = !default_sink_name.is_empty() && (cur_sink_name == default_sink_name || id.to_string() == default_sink_name);
                sinks.push(AudioSinkItem {
                    id,
                    name: cur_sink_name.clone(),
                    description: if !cur_sink_desc.is_empty() { cur_sink_desc.clone() } else { cur_sink_name.clone() },
                    volume: cur_sink_vol,
                    is_muted: cur_sink_muted,
                    is_default,
                });
            }
            let id_str = trimmed.replace("Sink #", "").trim().to_string();
            cur_sink_id = id_str.parse::<u32>().ok();
            cur_sink_name.clear();
            cur_sink_desc.clear();
            cur_sink_vol = 50;
            cur_sink_muted = false;
        } else if trimmed.starts_with("Name:") {
            cur_sink_name = trimmed.replace("Name:", "").trim().to_string();
        } else if trimmed.starts_with("Description:") {
            cur_sink_desc = trimmed.replace("Description:", "").trim().to_string();
        } else if trimmed.starts_with("Mute:") {
            cur_sink_muted = trimmed.contains("yes");
        } else if trimmed.starts_with("Volume:") && cur_sink_vol == 50 {
            // Volume: front-left: 26214 /  40% / -23,88 dB
            if let Some(idx) = trimmed.find('%') {
                let slice = &trimmed[..idx];
                if let Some(space_idx) = slice.rfind(|c: char| c.is_whitespace() || c == '/') {
                    let num_str = slice[space_idx + 1..].trim();
                    if let Ok(v) = num_str.parse::<u32>() {
                        cur_sink_vol = v;
                    }
                }
            }
        }
    }
    if let Some(id) = cur_sink_id {
        let is_default = !default_sink_name.is_empty() && (cur_sink_name == default_sink_name || id.to_string() == default_sink_name);
        sinks.push(AudioSinkItem {
            id,
            name: cur_sink_name.clone(),
            description: if !cur_sink_desc.is_empty() { cur_sink_desc.clone() } else { cur_sink_name.clone() },
            volume: cur_sink_vol,
            is_muted: cur_sink_muted,
            is_default,
        });
    }

    // 2. Parse active application playback streams (sink-inputs)
    let inputs_raw = Command::new("pactl")
        .args(["list", "sink-inputs"])
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
        .unwrap_or_default();

    let mut apps = Vec::new();
    let mut cur_app_id: Option<u32> = None;
    let mut cur_sink_for_app: u32 = 0;
    let mut cur_app_name = String::new();
    let mut cur_icon_name = String::new();
    let mut cur_app_vol: u32 = 100;
    let mut cur_app_muted = false;
    let mut cur_media_title = String::new();
    let mut cur_media_artist = String::new();
    let mut cur_is_video = false;

    // Get current MPRIS info to enrich active media
    let mpris_status = crate::mpris::get_media_status();

    for line in inputs_raw.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("Sink Input #") {
            if let Some(id) = cur_app_id {
                let mut media_art_url = String::new();
                if !mpris_status.art_url.is_empty() && (mpris_status.player.to_lowercase().contains(&cur_app_name.to_lowercase()) || cur_app_name.to_lowercase().contains(&mpris_status.player.to_lowercase())) {
                    media_art_url = mpris_status.art_url.clone();
                    if cur_media_title.is_empty() {
                        cur_media_title = mpris_status.title.clone();
                    }
                    if cur_media_artist.is_empty() {
                        cur_media_artist = mpris_status.artist.clone();
                    }
                }

                apps.push(AudioAppStream {
                    id,
                    sink_id: cur_sink_for_app,
                    app_name: if !cur_app_name.is_empty() { cur_app_name.clone() } else { "Reproductor".to_string() },
                    icon_name: cur_icon_name.clone(),
                    volume: cur_app_vol,
                    is_muted: cur_app_muted,
                    media_title: cur_media_title.clone(),
                    media_artist: cur_media_artist.clone(),
                    media_art_url,
                    is_video: cur_is_video,
                });
            }
            let id_str = trimmed.replace("Sink Input #", "").trim().to_string();
            cur_app_id = id_str.parse::<u32>().ok();
            cur_sink_for_app = 0;
            cur_app_name.clear();
            cur_icon_name.clear();
            cur_app_vol = 100;
            cur_app_muted = false;
            cur_media_title.clear();
            cur_media_artist.clear();
            cur_is_video = false;
        } else if trimmed.starts_with("Sink:") {
            cur_sink_for_app = trimmed.replace("Sink:", "").trim().parse::<u32>().unwrap_or(0);
        } else if trimmed.starts_with("Mute:") {
            cur_app_muted = trimmed.contains("yes");
        } else if trimmed.starts_with("Volume:") && cur_app_vol == 100 {
            if let Some(idx) = trimmed.find('%') {
                let slice = &trimmed[..idx];
                if let Some(space_idx) = slice.rfind(|c: char| c.is_whitespace() || c == '/') {
                    let num_str = slice[space_idx + 1..].trim();
                    if let Ok(v) = num_str.parse::<u32>() {
                        cur_app_vol = v;
                    }
                }
            }
        } else if trimmed.contains("application.name =") {
            cur_app_name = trimmed.split('=').nth(1).unwrap_or("").trim().trim_matches('"').to_string();
        } else if trimmed.contains("application.icon_name =") {
            cur_icon_name = trimmed.split('=').nth(1).unwrap_or("").trim().trim_matches('"').to_string();
        } else if trimmed.contains("media.title =") || trimmed.contains("media.name =") {
            let val = trimmed.split('=').nth(1).unwrap_or("").trim().trim_matches('"').to_string();
            if cur_media_title.is_empty() {
                cur_media_title = val;
            }
        } else if trimmed.contains("media.artist =") {
            cur_media_artist = trimmed.split('=').nth(1).unwrap_or("").trim().trim_matches('"').to_string();
        } else if trimmed.contains("media.role = \"video\"") || trimmed.to_lowercase().contains("video") {
            cur_is_video = true;
        }
    }
    if let Some(id) = cur_app_id {
        let mut media_art_url = String::new();
        if !mpris_status.art_url.is_empty() && (mpris_status.player.to_lowercase().contains(&cur_app_name.to_lowercase()) || cur_app_name.to_lowercase().contains(&mpris_status.player.to_lowercase())) {
            media_art_url = mpris_status.art_url.clone();
            if cur_media_title.is_empty() {
                cur_media_title = mpris_status.title.clone();
            }
            if cur_media_artist.is_empty() {
                cur_media_artist = mpris_status.artist.clone();
            }
        }

        apps.push(AudioAppStream {
            id,
            sink_id: cur_sink_for_app,
            app_name: if !cur_app_name.is_empty() { cur_app_name.clone() } else { "Reproductor".to_string() },
            icon_name: cur_icon_name.clone(),
            volume: cur_app_vol,
            is_muted: cur_app_muted,
            media_title: cur_media_title.clone(),
            media_artist: cur_media_artist.clone(),
            media_art_url,
            is_video: cur_is_video,
        });
    }

    DetailedAudioState {
        master_volume: master.volume,
        is_master_muted: master.is_muted,
        is_mic_muted: master.is_mic_muted,
        sinks,
        apps,
    }
}

#[tauri::command]
pub fn set_sink_volume(sink_id: u32, volume: u32) -> Result<bool, String> {
    let vol_clamped = volume.min(150);
    let _ = Command::new("pactl")
        .args(["set-sink-volume", &sink_id.to_string(), &format!("{}%", vol_clamped)])
        .status();
    Ok(true)
}

#[tauri::command]
pub fn toggle_sink_mute(sink_id: u32) -> Result<bool, String> {
    let _ = Command::new("pactl")
        .args(["set-sink-mute", &sink_id.to_string(), "toggle"])
        .status();
    Ok(true)
}

#[tauri::command]
pub fn set_default_sink(sink_id: u32) -> Result<bool, String> {
    let _ = Command::new("pactl")
        .args(["set-default-sink", &sink_id.to_string()])
        .status();
    Ok(true)
}

#[tauri::command]
pub fn set_app_volume(input_id: u32, volume: u32) -> Result<bool, String> {
    let vol_clamped = volume.min(150);
    let _ = Command::new("pactl")
        .args(["set-sink-input-volume", &input_id.to_string(), &format!("{}%", vol_clamped)])
        .status();
    Ok(true)
}

#[tauri::command]
pub fn toggle_app_mute(input_id: u32) -> Result<bool, String> {
    let _ = Command::new("pactl")
        .args(["set-sink-input-mute", &input_id.to_string(), "toggle"])
        .status();
    Ok(true)
}

#[tauri::command]
pub fn move_app_to_sink(input_id: u32, sink_id: u32) -> Result<bool, String> {
    let _ = Command::new("pactl")
        .args(["move-sink-input", &input_id.to_string(), &sink_id.to_string()])
        .status();
    Ok(true)
}
