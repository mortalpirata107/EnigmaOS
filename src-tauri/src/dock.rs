//! BottomDock backend: process launching, running-app queries and persistent pinned config.
//!
//! - `launch_app`: spawns a shell command (detached, child reaped in a background thread).
//! - `force_quit`: kills by exact process name (`killall`, fallback `pkill -x`).
//! - `open_file_with_app`: opens a dropped file with an app (argv, no shell).
//! - `start_process_monitor`: sysinfo thread emitting `running-processes-update` every 1.5 s.
//! - `get_running_apps`: groundwork for KWin-based running app detection (currently reuses
//!   the KWin D-Bus window query from `windows.rs`, de-duplicated by window class).
//! - `load_dock_config` / `save_dock_config`: persists pinned apps to
//!   `$XDG_CONFIG_HOME/dynamictopbar/dock.json` (fallback `~/.config/...`).

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::process::{Command, Stdio};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PinnedApp {
    pub id: String,
    pub name: String,
    pub icon: String,
    pub exec: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct DockConfig {
    pub pinned: Vec<PinnedApp>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RunningApp {
    pub window_id: String,
    pub app_name: String,
    pub window_class: String,
    pub icon: String,
    pub title: String,
    pub is_active: bool,
}

/// Removes freedesktop field codes (%u, %U, %f, %F, %i, %c, %k...) from an Exec string.
fn clean_exec(exec: &str) -> String {
    exec.split_whitespace()
        .filter(|w| !(w.len() == 2 && w.starts_with('%')))
        .collect::<Vec<&str>>()
        .join(" ")
}

/// Launches an application via `sh -c <exec_command>` without blocking Tauri.
/// The child is detached from stdio and reaped in a background thread (no zombies).
#[tauri::command]
pub fn launch_app(exec_command: String) -> Result<(), String> {
    let cmd = clean_exec(&exec_command);
    if cmd.trim().is_empty() {
        return Err("Comando vacío".into());
    }

    let mut child = Command::new("sh")
        .arg("-c")
        .arg(&cmd)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("No se pudo lanzar '{}': {}", cmd, e))?;

    std::thread::spawn(move || {
        let _ = child.wait();
    });

    eprintln!("[BottomDock] launch_app: {}", cmd);
    Ok(())
}

/// Force-quits an app by its EXACT process name (`killall <name>`, fallback `pkill -x <name>`).
/// Unlike `pkill -f`, this never matches substrings of other command lines.
/// Returns `true` if at least one process was signalled, `false` if none had that name.
#[tauri::command]
pub fn force_quit(process_name: String) -> Result<bool, String> {
    let name = process_name.trim();
    if name.is_empty() || name.contains('/') {
        return Err(format!("Nombre de proceso inválido: '{}'", name));
    }

    // Nunca matar al propio Dock
    let own = std::env::current_exe()
        .ok()
        .and_then(|p| p.file_name().map(|f| f.to_string_lossy().to_string()))
        .unwrap_or_default();
    if !own.is_empty() && own.eq_ignore_ascii_case(name) {
        return Err(format!("'{}' es el propio Dock; cancelado", name));
    }

    let status = match Command::new("killall").arg("-q").arg("--").arg(name).status() {
        Ok(s) => s,
        // killall no instalado → pkill con coincidencia exacta del nombre
        Err(_) => Command::new("pkill")
            .arg("-x")
            .arg("--")
            .arg(name)
            .status()
            .map_err(|e| format!("No se pudo ejecutar killall/pkill: {}", e))?,
    };

    eprintln!("[BottomDock] force_quit '{}' -> {:?}", name, status.code());
    match status.code() {
        Some(0) => Ok(true),
        Some(1) => Ok(false),
        other => Err(format!("killall terminó con código {:?}", other)),
    }
}

/// Splits an Exec string into argv, honouring double/single quotes (no shell involved).
fn split_exec(exec: &str) -> Vec<String> {
    let mut args = Vec::new();
    let mut cur = String::new();
    let mut quote: Option<char> = None;
    let mut has_token = false;
    let mut chars = exec.chars().peekable();
    while let Some(c) = chars.next() {
        match (quote, c) {
            (Some(q), c) if c == q => quote = None,
            (Some('"'), '\\') => {
                if let Some(n) = chars.next() { cur.push(n); }
            }
            (Some(_), c) => cur.push(c),
            (None, '"') | (None, '\'') => { quote = Some(c); has_token = true; }
            (None, c) if c.is_whitespace() => {
                if has_token || !cur.is_empty() { args.push(std::mem::take(&mut cur)); has_token = false; }
            }
            (None, c) => cur.push(c),
        }
    }
    if has_token || !cur.is_empty() { args.push(cur); }
    args
}

/// Opens `file_path` with the app described by `app_exec` (e.g. `code`, `vlc --fullscreen`,
/// or a .desktop Exec like `dolphin %u`).
/// - `%f %F %u %U` are replaced by the file; if absent, the file is appended as last argument.
/// - Executed directly (argv), NOT through `sh -c`, so file names with spaces, quotes or `;`
///   cannot inject commands.
#[tauri::command]
pub fn open_file_with_app(app_exec: String, file_path: String) -> Result<(), String> {
    let path = std::path::Path::new(&file_path);
    if !path.exists() {
        return Err(format!("El archivo no existe: {}", file_path));
    }

    let tokens = split_exec(&app_exec);
    let (program, rest) = tokens.split_first().ok_or("Comando de app vacío")?;

    let mut args: Vec<String> = Vec::new();
    let mut inserted = false;
    for t in rest {
        match t.as_str() {
            "%f" | "%F" | "%u" | "%U" => {
                if !inserted { args.push(file_path.clone()); inserted = true; }
            }
            // Otros códigos de campo (%i, %c, %k...) se descartan
            s if s.len() == 2 && s.starts_with('%') => {}
            s => args.push(s.to_string()),
        }
    }
    if !inserted {
        args.push(file_path.clone());
    }

    let mut child = Command::new(program)
        .args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("No se pudo ejecutar '{}': {}", program, e))?;
    std::thread::spawn(move || { let _ = child.wait(); });

    eprintln!("[BottomDock] open_file_with_app: {} {:?}", program, args);
    Ok(())
}

/// Background monitor: every 1.5 s lists running executables with `sysinfo` and emits
/// `running-processes-update` (Vec<String>) to the dock window.
/// Includes both the kernel process name (truncated to 15 chars on Linux) and the
/// executable's file name, so long names like `antigravity-ide` still match. Threads are skipped.
pub fn start_process_monitor(app: tauri::AppHandle) {
    use sysinfo::{ProcessRefreshKind, System, UpdateKind};
    use tauri::Emitter;

    std::thread::spawn(move || {
        let mut sys = System::new();
        let refresh = ProcessRefreshKind::new().with_exe(UpdateKind::OnlyIfNotSet);
        let mut last_apps: Vec<RunningApp> = Vec::new();
        loop {
            sys.refresh_processes_specifics(refresh);

            let mut names: Vec<String> = Vec::with_capacity(sys.processes().len());
            for process in sys.processes().values() {
                if process.thread_kind().is_some() {
                    continue; // hilos (kernel o userland), no procesos
                }
                let name = process.name();
                if !name.is_empty() {
                    names.push(name.to_string());
                }
                if let Some(file) = process.exe().and_then(|p| p.file_name()) {
                    let exe = file.to_string_lossy();
                    if exe != name {
                        names.push(exe.to_string());
                    }
                }
            }
            names.sort_unstable();
            names.dedup();

            // Tauri 2: emit_to apunta a la ventana del dock
            let _ = app.emit_to("dock", "running-processes-update", &names);

            // Emitir lista de aplicaciones reales abiertas (Wayland KWin D-Bus)
            let current_apps = get_running_apps();
            if current_apps != last_apps {
                last_apps = current_apps.clone();
                let _ = app.emit_to("dock", "running-apps-update", &current_apps);
            }

            std::thread::sleep(std::time::Duration::from_millis(1500));
        }
    });
}

/// Returns currently running apps (one entry per window class).
/// Groundwork: today it reuses the KWin D-Bus window list; later it can query KWin scripting directly.
#[tauri::command]
pub fn get_running_apps() -> Vec<RunningApp> {
    let mut seen = std::collections::HashSet::new();
    crate::windows::get_open_windows()
        .into_iter()
        .filter(|w| {
            let key = if w.window_class.is_empty() { w.app_name.to_lowercase() } else { w.window_class.to_lowercase() };
            seen.insert(key)
        })
        .map(|w| RunningApp {
            window_id: w.id,
            app_name: w.app_name,
            window_class: w.window_class,
            icon: w.icon,
            title: w.title,
            is_active: w.is_active,
        })
        .collect()
}

fn config_path() -> Option<PathBuf> {
    let base = std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".config")))?;
    let modern = base.join("enigmaos").join("dock.json");
    if modern.exists() {
        return Some(modern);
    }
    let legacy = base.join("dynamictopbar").join("dock.json");
    if legacy.exists() {
        return Some(legacy);
    }
    Some(modern)
}

/// Loads the persisted dock config. Returns `None` if it does not exist yet (frontend uses defaults).
#[tauri::command]
pub fn load_dock_config() -> Option<DockConfig> {
    let path = config_path()?;
    let data = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&data).ok()
}

/// Persists the dock config atomically (write to temp file + rename).
#[tauri::command]
pub fn save_dock_config(config: DockConfig) -> Result<(), String> {
    let path = config_path().ok_or("No se pudo resolver el directorio de configuración")?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, json).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VisualSettings {
    pub theme: String,             // "crimson" | "cyan" | "amethyst" | "gold"
    pub dock_size: u32,            // 36..64 (default 48)
    pub magnify_scale: f32,        // 1.0..1.8 (default 1.45)
    pub autohide_delay_ms: u32,    // 60..500 (default 180)
}

impl Default for VisualSettings {
    fn default() -> Self {
        Self {
            theme: "crimson".to_string(),
            dock_size: 48,
            magnify_scale: 1.45,
            autohide_delay_ms: 180,
        }
    }
}

fn visual_settings_path() -> Option<PathBuf> {
    let base = std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".config")))?;
    let modern = base.join("enigmaos").join("visual_settings.json");
    if modern.exists() {
        return Some(modern);
    }
    let legacy = base.join("dynamictopbar").join("visual_settings.json");
    if legacy.exists() {
        return Some(legacy);
    }
    Some(modern)
}

#[tauri::command]
pub fn load_visual_settings() -> VisualSettings {
    let Some(path) = visual_settings_path() else {
        return VisualSettings::default();
    };
    let Ok(data) = std::fs::read_to_string(path) else {
        return VisualSettings::default();
    };
    serde_json::from_str(&data).unwrap_or_default()
}

#[tauri::command]
pub fn save_visual_settings(settings: VisualSettings, app: tauri::AppHandle) -> Result<(), String> {
    use tauri::Emitter;

    let path = visual_settings_path().ok_or("No se pudo resolver el directorio de configuración")?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, json).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())?;

    // Emitir en vivo a todas las ventanas (main y dock)
    let _ = app.emit("visual_settings_updated", &settings);

    Ok(())
}

