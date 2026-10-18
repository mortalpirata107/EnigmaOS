use std::process::{Command, Stdio};
use std::sync::Mutex;
use enigo::{Button, Coordinate, Direction, Enigo, Key, Keyboard, Mouse, Settings};
use sysinfo::System;

static ENIGO_INSTANCE: Mutex<Option<Enigo>> = Mutex::new(None);

fn with_enigo<F, R>(f: F) -> Result<R, String>
where
    F: FnOnce(&mut Enigo) -> Result<R, String>,
{
    let mut lock = ENIGO_INSTANCE
        .lock()
        .map_err(|e| format!("Error adquiriendo lock de Enigo: {}", e))?;

    if lock.is_none() {
        let enigo = Enigo::new(&Settings::default())
            .map_err(|e| format!("Error inicializando controlador Enigo: {:?}", e))?;
        *lock = Some(enigo);
    }

    let enigo = lock.as_mut().unwrap();
    f(enigo)
}

#[tauri::command]
pub fn open_url(url: String) -> Result<String, String> {
    let mut target = url.trim().to_string();
    if target.is_empty() {
        return Err("La URL no puede estar vacía".to_string());
    }

    // Auto-resolver atajos comunes a URLs canónicas
    match target.to_lowercase().as_str() {
        "youtube" => target = "https://www.youtube.com".to_string(),
        "gmail" => target = "https://mail.google.com".to_string(),
        "github" => target = "https://github.com".to_string(),
        "whatsapp" | "whatsapp web" => target = "https://web.whatsapp.com".to_string(),
        "chatgpt" => target = "https://chatgpt.com".to_string(),
        _ => {
            if !target.starts_with("http://") && !target.starts_with("https://") {
                target = format!("https://{}", target);
            }
        }
    }

    eprintln!("[system_control] Abriendo URL en navegador Opera: '{}'", target);

    // 1. Intentar directamente con Opera (el navegador predeterminado del usuario)
    let opera_spawned = Command::new("opera")
        .arg(&target)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .is_ok();

    if opera_spawned {
        // Enfocar la ventana de Opera en KDE Plasma Wayland
        let windows = crate::windows::get_open_windows();
        if let Some(win) = windows.iter().find(|w| {
            let app = w.app_name.to_lowercase();
            let title = w.title.to_lowercase();
            let class = w.window_class.to_lowercase();
            app.contains("opera") || title.contains("opera") || class.contains("opera")
        }) {
            let _ = crate::windows::focus_window_by_id(&win.id);
        }
        std::thread::spawn(|| {
            std::thread::sleep(std::time::Duration::from_millis(350));
            let windows = crate::windows::get_open_windows();
            if let Some(win) = windows.iter().find(|w| {
                let app = w.app_name.to_lowercase();
                let title = w.title.to_lowercase();
                let class = w.window_class.to_lowercase();
                app.contains("opera") || title.contains("opera") || class.contains("opera")
            }) {
                let _ = crate::windows::focus_window_by_id(&win.id);
            }
        });
        return Ok(format!("URL abierta en Opera: {}", target));
    }

    // 2. Fallback con open::that (respetará el xdg-open predeterminado)
    if open::that(&target).is_ok() {
        return Ok(format!("URL abierta en navegador: {}", target));
    }

    // 3. Fallback con xdg-open
    Command::new("xdg-open")
        .arg(&target)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map(|_| format!("URL abierta en navegador: {}", target))
        .map_err(|e| format!("Error abriendo la URL '{}': {}", target, e))
}

#[tauri::command]
pub fn open_app(app_name: String) -> Result<(), String> {
    let app_trimmed = app_name.trim();
    if app_trimmed.is_empty() {
        return Err("El nombre de la aplicación no puede estar vacío".to_string());
    }

    // Safety fallback: si por error se envía una web o servicio conocido a open_app, delegar a open_url
    let lower_app = app_trimmed.to_lowercase();
    if lower_app.starts_with("http://")
        || lower_app.starts_with("https://")
        || lower_app == "youtube"
        || lower_app == "gmail"
        || lower_app.contains(".com")
        || lower_app.contains(".org")
        || lower_app.contains(".net")
    {
        eprintln!("[system_control] Detectado enlace web en open_app ('{}'), redirigiendo a open_url", app_trimmed);
        return open_url(app_name).map(|_| ());
    }

    eprintln!("[system_control] Lanzando aplicación: '{}'", app_trimmed);

    // Separar binario y argumentos si los hubiera
    let parts: Vec<&str> = app_trimmed.split_whitespace().collect();
    let bin = parts[0];
    let args = &parts[1..];

    // 1. Intento directo con el comando/binario proporcionado
    if let Ok(_child) = Command::new(bin)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
    {
        return Ok(());
    }

    // 2. Intento en minúsculas (ej: "Firefox" -> "firefox", "Spotify" -> "spotify")
    let lower_bin = bin.to_lowercase();
    if lower_bin != bin {
        if let Ok(_child) = Command::new(&lower_bin)
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
        {
            return Ok(());
        }
    }

    // 3. Fallback nativo de escritorio mediante gtk-launch
    if let Ok(_child) = Command::new("gtk-launch")
        .arg(&lower_bin)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
    {
        return Ok(());
    }

    Err(format!("No se pudo encontrar o ejecutar el binario '{}'", app_trimmed))
}

#[tauri::command]
pub fn close_app(app_name: String) -> Result<(), String> {
    let app_trimmed = app_name.trim().to_lowercase();
    if app_trimmed.is_empty() {
        return Err("El nombre de la aplicación no puede estar vacío".to_string());
    }

    eprintln!("[system_control] Buscando procesos para cerrar: '{}'", app_trimmed);

    let mut sys = System::new_all();
    sys.refresh_processes();

    let mut killed_count = 0;
    for (pid, process) in sys.processes() {
        let proc_name = process.name().to_lowercase();
        let exe_str = process
            .exe()
            .map(|p| p.to_string_lossy().to_lowercase())
            .unwrap_or_default();

        let matches = proc_name == app_trimmed
            || proc_name.starts_with(&app_trimmed)
            || exe_str.ends_with(&format!("/{}", app_trimmed))
            || (app_trimmed.len() >= 4 && proc_name.contains(&app_trimmed));

        if matches {
            eprintln!("[system_control] Cerrando proceso '{}' (PID: {})", process.name(), pid);
            if process.kill() {
                killed_count += 1;
            }
        }
    }

    if killed_count > 0 {
        eprintln!("[system_control] Cerrados exitosamente {} proceso(s) para '{}'", killed_count, app_name);
        Ok(())
    } else {
        Err(format!("No se encontró ningún proceso activo que coincida con '{}'", app_name))
    }
}

#[tauri::command]
pub fn move_mouse(x: i32, y: i32) -> Result<(), String> {
    with_enigo(|enigo| {
        enigo
            .move_mouse(x, y, Coordinate::Abs)
            .map_err(|e| format!("Error moviendo el ratón a ({}, {}): {:?}", x, y, e))
    })
}

#[tauri::command]
pub fn mouse_click(button: String) -> Result<(), String> {
    let btn = match button.trim().to_lowercase().as_str() {
        "left" | "izquierdo" | "izq" | "primary" => Button::Left,
        "right" | "derecho" | "der" | "secondary" => Button::Right,
        "middle" | "central" | "medio" => Button::Middle,
        other => return Err(format!("Botón de ratón no reconocido: '{}'. Usa 'left', 'right' o 'middle'", other)),
    };

    with_enigo(|enigo| {
        enigo
            .button(btn, Direction::Click)
            .map_err(|e| format!("Error haciendo clic con botón '{:?}': {:?}", btn, e))
    })
}

#[tauri::command]
pub fn type_text(text: String) -> Result<(), String> {
    with_enigo(|enigo| {
        enigo
            .text(&text)
            .map_err(|e| format!("Error escribiendo texto: {:?}", e))
    })
}

#[tauri::command]
pub fn press_key(key: String) -> Result<(), String> {
    let key_trimmed = key.trim().to_lowercase();

    let k = match key_trimmed.as_str() {
        "enter" | "intro" | "return" => Key::Return,
        "tab" | "tabulador" => Key::Tab,
        "super" | "meta" | "windows" | "win" => Key::Meta,
        "escape" | "esc" => Key::Escape,
        "space" | "espacio" => Key::Space,
        "backspace" | "borrar" | "retroceso" => Key::Backspace,
        "up" | "arriba" => Key::UpArrow,
        "down" | "abajo" => Key::DownArrow,
        "left" | "izquierda" => Key::LeftArrow,
        "right" | "derecha" => Key::RightArrow,
        "shift" | "mayus" | "mayusc" => Key::Shift,
        "control" | "ctrl" => Key::Control,
        "alt" => Key::Alt,
        "home" | "inicio" => Key::Home,
        "end" | "fin" => Key::End,
        "pageup" | "repag" => Key::PageUp,
        "pagedown" | "avpag" => Key::PageDown,
        "delete" | "supr" | "suprimir" => Key::Delete,
        "f1" => Key::F1,
        "f2" => Key::F2,
        "f3" => Key::F3,
        "f4" => Key::F4,
        "f5" => Key::F5,
        "f6" => Key::F6,
        "f7" => Key::F7,
        "f8" => Key::F8,
        "f9" => Key::F9,
        "f10" => Key::F10,
        "f11" => Key::F11,
        "f12" => Key::F12,
        other => {
            if other.chars().count() == 1 {
                Key::Unicode(other.chars().next().unwrap())
            } else {
                return Err(format!("Tecla no reconocida: '{}'", other));
            }
        }
    };

    with_enigo(|enigo| {
        enigo
            .key(k, Direction::Click)
            .map_err(|e| format!("Error pulsando tecla '{:?}': {:?}", k, e))
    })
}

#[tauri::command]
pub fn run_terminal(command: String) -> Result<String, String> {
    eprintln!("[system_control] Ejecutando comando en terminal: '{}'", command);

    let output = Command::new("sh")
        .arg("-c")
        .arg(&command)
        .output()
        .map_err(|e| format!("Error al ejecutar comando en la terminal: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    if output.status.success() {
        if stdout.is_empty() && !stderr.is_empty() {
            Ok(stderr)
        } else if stdout.is_empty() {
            Ok("Comando ejecutado con éxito sin salida.".to_string())
        } else {
            Ok(stdout)
        }
    } else {
        let err_msg = if !stderr.is_empty() {
            stderr
        } else if !stdout.is_empty() {
            stdout
        } else {
            format!("El proceso terminó con error (código {:?})", output.status.code())
        };
        Err(err_msg)
    }
}

