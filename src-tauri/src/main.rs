#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod window_strut;
mod mpris;
mod system;
mod global_shortcut;
mod windows;
mod dock;
mod enigma;
mod wake_word;
mod db;
mod whatsapp_bridge;
mod google_auth;
mod system_control;
mod memory;
mod router;
mod telemetry;
mod vision;
mod messenger_bridge;
mod scheduler;
mod creative;
mod os_skills;
mod personas;
mod clipboard;
mod desktop_notifications;
mod connectivities;

use gtk::prelude::*;
use tauri::{Manager, Emitter, WebviewWindow};

#[tauri::command]
fn log_frontend(window: WebviewWindow, msg: String) {
    eprintln!("[Frontend:{}] {}", window.label(), msg);
}

#[tauri::command]
fn focus_window(app_name: Option<String>, id: Option<String>) -> Result<(), String> {
    let target = app_name.or(id).unwrap_or_default();
    if target.trim().is_empty() {
        return Ok(());
    }

    // 1. Try wmctrl -a "nombre_de_la_app"
    if let Ok(status) = std::process::Command::new("wmctrl").arg("-a").arg(&target).status() {
        if status.success() {
            eprintln!("[focus_window] Focused via wmctrl: {}", target);
            return Ok(());
        }
    }

    // 2. Native Wayland fallback for KDE Plasma 6 (qdbus6 WindowsRunner Match & Run)
    let windows = windows::get_open_windows();
    let lower_target = target.to_lowercase();
    if let Some(win) = windows.iter().find(|w| {
        w.id == target
            || w.app_name.to_lowercase().contains(&lower_target)
            || lower_target.contains(&w.app_name.to_lowercase())
            || w.window_class.to_lowercase().contains(&lower_target)
            || lower_target.contains(&w.window_class.to_lowercase())
            || w.title.to_lowercase().contains(&lower_target)
    }) {
        if let Ok(()) = windows::focus_window_by_id(&win.id) {
            eprintln!("[focus_window] Focused via KWin WindowsRunner: {} ({})", win.app_name, win.id);
            return Ok(());
        }
    }

    // 3. If target was already a KWin window ID like "0_{...}"
    if target.starts_with("0_{") {
        let _ = windows::focus_window_by_id(&target);
    }

    Ok(())
}

#[tauri::command]
fn open_file(exec: String, path: String) -> Result<(), String> {
    dock::open_file_with_app(exec, path)
}

#[tauri::command]
fn start_stt() -> Result<(), String> {
    wake_word::trigger_start_dictation();
    Ok(())
}

#[tauri::command]
fn stop_stt() -> Result<(), String> {
    wake_word::trigger_stop_dictation();
    Ok(())
}

fn forward_cli_args_to_socket(args: &[String]) -> bool {
    let mut msg = None;
    if args.iter().any(|a| a == "--search" || a == "--toggle-search") {
        msg = Some("open_search\n".to_string());
    } else if args.iter().any(|a| a == "--clipboard" || a == "--toggle-clipboard") {
        msg = Some("open_clipboard\n".to_string());
    } else if args.iter().any(|a| a == "--enigma" || a == "--toggle-enigma") {
        msg = Some("toggle_enigma\n".to_string());
    } else if args.iter().any(|a| a == "--stt") {
        msg = Some("start_stt\n".to_string());
    } else if let Some(pos) = args.iter().position(|a| a == "--speak") {
        if let Some(target) = args.get(pos + 1) {
            msg = Some(format!("speak:{}\n", target));
        }
    } else if let Some(pos) = args.iter().position(|a| a == "--prompt" || a == "--enigma-prompt") {
        if let Some(target) = args.get(pos + 1) {
            msg = Some(format!("enigma_prompt:{}\n", target));
        }
    } else if let Some(pos) = args.iter().position(|a| a == "--popover") {
        if let Some(target) = args.get(pos + 1) {
            msg = Some(format!("popover:{}\n", target));
        }
    } else if let Some(pos) = args.iter().position(|a| a == "--view") {
        if let Some(target) = args.get(pos + 1) {
            msg = Some(format!("view:{}\n", target));
        }
    }

    if let Some(cmd) = msg {
        use std::io::Write;
        use std::os::unix::net::UnixStream;
        for _ in 0..6 {
            if let Ok(mut stream) = UnixStream::connect("/tmp/enigmaos.sock") {
                let _ = stream.write_all(cmd.as_bytes());
                return true;
            }
            if let Ok(mut stream) = UnixStream::connect("/tmp/dynamictopbar.sock") {
                let _ = stream.write_all(cmd.as_bytes());
                return true;
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        return true;
    }

    false
}

fn main() {
    let args: Vec<String> = std::env::args().collect();

    // Bloqueo a nivel de kernel (flock) para garantizar que NUNCA se abran dos instancias
    // simultáneas al reiniciar el PC (evita conflicto entre autostart y activación D-Bus).
    let lock_path = std::env::var("XDG_RUNTIME_DIR")
        .map(|p| format!("{}/enigmaos.lock", p))
        .unwrap_or_else(|_| "/tmp/enigmaos.lock".to_string());

    let lock_file = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(&lock_path);

    let _instance_lock = match lock_file {
        Ok(file) => {
            use std::os::unix::io::AsRawFd;
            let fd = file.as_raw_fd();
            let res = unsafe { libc::flock(fd, libc::LOCK_EX | libc::LOCK_NB) };
            if res != 0 {
                // Ya hay otra instancia activa en el sistema.
                if forward_cli_args_to_socket(&args) {
                    eprintln!("[SingleInstance] Acción reenviada a la instancia activa. Saliendo limpiamente.");
                } else {
                    eprintln!("[SingleInstance] Ya existe una instancia de EnigmaOS en ejecución. Saliendo sin duplicar.");
                }
                return;
            }
            // Mantenemos el descriptor abierto durante toda la vida del proceso;
            // el kernel de Linux lo libera de forma automática si el proceso se cierra o finaliza.
            Box::leak(Box::new(file));
            true
        }
        Err(e) => {
            eprintln!("[SingleInstance] Advertencia: No se pudo abrir {}: {}", lock_path, e);
            false
        }
    };

    let _ = dotenvy::dotenv();
    let _ = dotenvy::from_filename("src-tauri/.env");
    memory::init_core_memory();
    personas::init_default_personas();

    if std::env::var("GDK_BACKEND").is_err() {
        if std::env::var("WAYLAND_DISPLAY").is_ok() {
            std::env::set_var("GDK_BACKEND", "wayland,x11");
        } else {
            std::env::set_var("GDK_BACKEND", "x11");
        }
    }
    std::env::set_var("TAURI_LINUX_USE_GTK", "1");
    // Previene error de protocolo Wayland (error 4 de explicit sync en drivers NVIDIA 555-615)
    if std::env::var("__NV_DISABLE_EXPLICIT_SYNC").is_err() {
        std::env::set_var("__NV_DISABLE_EXPLICIT_SYNC", "1");
    }
    // El renderer DMABUF de WebKitGTK es el único que repinta correctamente TODA la superficie en Wayland
    // (con WEBKIT_DISABLE_DMABUF_RENDERER=1 solo se pintaba el canvas WebGL y el resto del notch/dock
    // quedaba recortado). Aseguramos que se limpie de cualquier entorno heredado a menos que se pida explícitamente.
    if std::env::var("DTB_DISABLE_DMABUF").is_err() {
        std::env::remove_var("WEBKIT_DISABLE_DMABUF_RENDERER");
    } else {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }

    let startup_args = args.clone();

    tauri::Builder::default()
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state() == tauri_plugin_global_shortcut::ShortcutState::Pressed {
                        eprintln!("[GlobalShortcut:Plugin] Alt+3 pressed! Emitting toggle-enigma");
                        let _ = app.emit("toggle-enigma", ());
                    }
                })
                .build()
        )
        .setup(move |app| {
            #[cfg(desktop)]
            {
                use tauri_plugin_global_shortcut::GlobalShortcutExt;
                let _ = app.global_shortcut().register("alt+3");
            }
            #[cfg(target_os = "linux")]
            {
                if let Some(window) = app.get_webview_window("main") {
                    let win_for_sock = window.clone();
                    let app_for_sock = app.handle().clone();
                    std::thread::spawn(move || {
                        use std::io::{BufRead, BufReader};
                        use std::os::unix::net::UnixListener;
                        let sock_path = "/tmp/enigmaos.sock";
                        let _ = std::fs::remove_file(sock_path);
                        let _ = std::fs::remove_file("/tmp/dynamictopbar.sock");
                        let _ = std::os::unix::fs::symlink(sock_path, "/tmp/dynamictopbar.sock");
                        if let Ok(listener) = UnixListener::bind(sock_path) {
                            for stream in listener.incoming().flatten() {
                                let mut reader = BufReader::new(stream);
                                let mut line = String::new();
                                if reader.read_line(&mut line).is_ok() {
                                    let trimmed = line.trim();
                                    eprintln!("[Socket] received line: '{}'", trimmed);
                                    if trimmed == "open_search" {
                                        let _ = app_for_sock.emit("open-search", ());
                                    } else if trimmed == "close_search" {
                                        let _ = app_for_sock.emit("close-search", ());
                                    } else if trimmed == "toggle_search" {
                                        let _ = app_for_sock.emit("toggle-search", ());
                                    } else if trimmed == "open_clipboard" || trimmed == "toggle_clipboard" {
                                        let _ = app_for_sock.emit("open-clipboard-history", ());
                                    } else if trimmed == "open_enigma" || trimmed == "toggle_enigma" || trimmed == "trigger-enigma" {
                                        eprintln!("[Socket] Emitting toggle-enigma");
                                        let _ = app_for_sock.emit("toggle-enigma", ());
                                    } else if trimmed == "start_stt" {
                                        wake_word::trigger_start_dictation();
                                    } else if let Some(text_to_speak) = trimmed.strip_prefix("speak:") {
                                        let cleaned = enigma::clean_markdown_for_speech(text_to_speak);
                                        enigma::speak_text_async(cleaned);
                                    } else if let Some(target) = trimmed.strip_prefix("popover:") {
                                        let _ = app_for_sock.emit("open_popover", target.to_string());
                                    } else if let Some(prompt) = trimmed.strip_prefix("enigma_prompt:") {
                                        let prompt_str = prompt.to_string();
                                        let _ = app_for_sock.emit("trigger-enigma-prompt", prompt_str.clone());
                                        let _ = win_for_sock.emit("trigger-enigma-prompt", prompt_str.clone());
                                    } else if let Some(view) = trimmed.strip_prefix("view:") {
                                        let _ = app_for_sock.emit("set-enigma-view", view.to_string());
                                        let _ = win_for_sock.emit("set-enigma-view", view.to_string());
                                    } else if let Some(code) = trimmed.strip_prefix("eval:") {
                                        let _ = win_for_sock.eval(code);
                                    }
                                }
                            }
                        }
                    });

                    if let Ok(gtk_win) = window.gtk_window() {
                        let is_wayland_layer = window_strut::init_wayland_layer_shell(&gtk_win);
                        eprintln!("[EnigmaOS] is_wayland_layer = {}", is_wayland_layer);
                        if is_wayland_layer {
                            window_strut::configure_layer_shell_window_main(&gtk_win);
                        } else {
                            window_strut::configure_desktop_window(&gtk_win);
                        }

                        let win_clone = window.clone();
                        gtk_win.connect_leave_notify_event(move |_, event| {
                            if event.detail() != gdk::NotifyType::Inferior {
                                let _ = win_clone.emit("hardware_pointer_leave", ());
                            }
                            gtk::glib::Propagation::Proceed
                        });

                        gtk_win.show_all();
                        window_strut::install_forced_redraw(&gtk_win);
                    }
                    let _ = window.show();
                }

                // 2. Initialize and configure the BottomDock window
                if let Some(dock_window) = app.get_webview_window("dock") {
                    if let Ok(gtk_win) = dock_window.gtk_window() {
                        let is_wayland_layer = window_strut::init_wayland_layer_shell_dock(&gtk_win);
                        eprintln!("[BottomDock] is_wayland_layer = {}", is_wayland_layer);
                        if is_wayland_layer {
                            window_strut::configure_layer_shell_window_dock(&gtk_win);
                        } else {
                            window_strut::configure_dock_desktop_window(&gtk_win);
                        }

                        let dock_clone = dock_window.clone();
                        gtk_win.connect_leave_notify_event(move |_, event| {
                            if event.detail() != gdk::NotifyType::Inferior {
                                let _ = dock_clone.emit("dock_pointer_leave", ());
                            }
                            gtk::glib::Propagation::Proceed
                        });

                        gtk_win.show_all();
                        window_strut::install_forced_redraw(&gtk_win);
                    }
                    let _ = dock_window.show();
                }

                // Initialize SQLite core DB
                if let Err(e) = db::init_db() {
                    eprintln!("[SQLite] Error initializing database: {}", e);
                }

                // Initialize default personas folder and templates
                personas::init_default_personas();

                // Start real-time background threads for immediate UI responsiveness
                mpris::start_media_poller(app.handle().clone());
                windows::start_window_poller(app.handle().clone());
                windows::init_active_window_tracker(app.handle().clone());
                dock::start_process_monitor(app.handle().clone());
                global_shortcut::start_global_shortcut_listener(app.handle().clone());
                desktop_notifications::start_notification_server(app.handle().clone());
                enigma::set_speech_app_handle(app.handle().clone());
                clipboard::start_clipboard_monitor(app.handle().clone());

                let args_for_startup = startup_args.clone();
                let app_handle_for_startup = app.handle().clone();
                std::thread::spawn(move || {
                    if args_for_startup.iter().any(|a| a == "--search" || a == "--toggle-search") {
                        std::thread::sleep(std::time::Duration::from_millis(600));
                        let _ = app_handle_for_startup.emit("open-search", ());
                    } else if args_for_startup.iter().any(|a| a == "--clipboard" || a == "--toggle-clipboard") {
                        std::thread::sleep(std::time::Duration::from_millis(600));
                        let _ = app_handle_for_startup.emit("open-clipboard-history", ());
                    }
                });

                // Pre-warm system applications cache in memory immediately on background thread
                std::thread::spawn(|| {
                    system::prewarm_system_apps();
                });

                // Defer heavy secondary services (Node.js WhatsApp, Vosk STT, Telegram, Telemetry)
                // by 1.5 seconds so the top bar and dock display and paint instantly (<200ms)
                let app_handle_deferred = app.handle().clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(1500));
                    eprintln!("[Startup] Launching deferred background services...");
                    system::start_system_poller(app_handle_deferred.clone());
                    whatsapp_bridge::start_whatsapp_bridge();
                    whatsapp_bridge::start_contacts_sync_daemon(app_handle_deferred.clone());
                    wake_word::start_wake_word_listener(app_handle_deferred.clone());
                    telemetry::start_telemetry_daemon();
                    messenger_bridge::start_telegram_bot(app_handle_deferred.clone());
                    scheduler::start_scheduler(app_handle_deferred.clone());
                    db::start_notification_daemon();
                });
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            log_frontend,
            window_strut::update_custom_input_regions,
            window_strut::set_keyboard_interactivity,
            window_strut::get_cursor_position,
            windows::get_open_windows,
            focus_window,
            dock::launch_app,
            dock::force_quit,
            dock::open_file_with_app,
            open_file,
            dock::get_running_apps,
            dock::load_dock_config,
            dock::save_dock_config,
            dock::load_visual_settings,
            dock::save_visual_settings,
            mpris::get_media_status,
            mpris::media_control,
            system::get_virtual_desktops,
            system::switch_virtual_desktop,
            system::get_bluetooth_status,
            system::toggle_bluetooth,
            system::connect_bluetooth_device,
            system::get_system_telemetry,
            system::get_audio_status,
            system::toggle_audio_mute,
            system::toggle_mic_mute,
            system::set_audio_volume,
            system::get_system_apps,
            system::get_recent_documents,
            system::open_native_path,
            system::run_terminal_command,
            system::launch_system_app,
            system::record_app_launch,
            system::get_app_usage_counts,
            system::execute_system_action,
            system::get_detailed_bluetooth_status,
            system::bluetooth_disconnect_device,
            system::bluetooth_unpair_device,
            system::bluetooth_pair_device,
            system::get_detailed_network_status,
            system::connect_wifi_network,
            system::disconnect_network,
            system::get_detailed_audio_status,
            system::set_sink_volume,
            system::toggle_sink_mute,
            system::set_default_sink,
            system::set_app_volume,
            system::toggle_app_mute,
            system::move_app_to_sink,
            enigma::invoke_enigma,
            enigma::speak_text,
            enigma::stop_speaking_cmd,
            enigma::toggle_enigma_voice,
            enigma::get_enigma_voice_enabled,
            start_stt,
            stop_stt,
            db::get_calendar_events,
            db::add_calendar_event,
            db::delete_calendar_event,
            db::get_tasks,
            db::add_task,
            db::toggle_task,
            db::delete_task,
            db::get_schedules,
            db::add_schedule,
            db::delete_schedule,
            db::get_categories_by_module,
            db::add_category,
            db::delete_category,
            db::get_notes,
            db::add_note,
            db::update_note,
            db::delete_note,
            db::get_extensions,
            db::get_whatsapp_contacts,
            db::add_whatsapp_contact,
            db::delete_whatsapp_contact,
            db::delete_whatsapp_contacts_batch,
            whatsapp_bridge::get_whatsapp_status,
            whatsapp_bridge::get_whatsapp_qr,
            whatsapp_bridge::send_whatsapp_command,
            whatsapp_bridge::sync_whatsapp_contacts,
            google_auth::start_google_auth,
            google_auth::get_google_auth_status,
            google_auth::disconnect_google_auth,
            google_auth::get_google_access_token,
            google_auth::get_gmail_emails,
            google_auth::get_google_calendar_events,
            google_auth::get_saved_google_credentials,
            system_control::open_url,
            system_control::open_app,
            system_control::close_app,
            system_control::move_mouse,
            system_control::mouse_click,
            system_control::type_text,
            system_control::press_key,
            system_control::run_terminal,
            memory::get_recent_context,
            memory::get_chat_history,
            memory::clear_chat_history,
            memory::save_chat_message,
            memory::get_core_memory,
            memory::save_core_memory,
            os_skills::read_local_file,
            os_skills::execute_terminal_command,
            personas::get_available_personas,
            personas::create_persona,
            personas::get_persona_content,
            personas::delete_persona,
            router::process_enigma_message,
            telemetry::get_user_usage_patterns,
            vision::analyze_image,
            vision::analyze_current_screen,
            vision::capture_screen_preview,
            creative::generate_image,
            creative::load_image_asset,
            messenger_bridge::send_telegram_notification,
            messenger_bridge::get_telegram_status,
            scheduler::trigger_scheduler_check,
            clipboard::get_clipboard_content,
            clipboard::copy_to_clipboard,
            clipboard::copy_clipboard_item,
            db::get_clipboard_history,
            db::delete_clipboard_item,
            db::clear_clipboard_history,
            windows::focus_app_or_window,
            windows::get_active_desktop_context,
            windows::minimize_window,
            windows::maximize_window,
            windows::close_window_cleanly,
            windows::get_window_thumbnail,
            windows::capture_window_thumbnail_now,
            desktop_notifications::invoke_desktop_notification_action,
            desktop_notifications::close_desktop_notification,

        ])
        .build(tauri::generate_context!())
        .expect("error while building EnigmaOS application")
        .run(|_app_handle, event| {
            match event {
                tauri::RunEvent::WindowEvent {
                    event: tauri::WindowEvent::CloseRequested { .. },
                    ..
                } => {
                    eprintln!("[Tauri] CloseRequested: Apagando puente de WhatsApp...");
                    whatsapp_bridge::shutdown_bridge_http();
                }
                tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit => {
                    eprintln!("[Tauri] ExitRequested/Exit: Apagando puente de WhatsApp...");
                    whatsapp_bridge::stop_whatsapp_bridge();
                }
                _ => {}
            }
        });
}

