//! Global evdev keyboard shortcut monitor for Linux (Wayland / X11)
//!
//! Directly monitors physical keyboard event devices (/dev/input/event*)
//! for shortcuts (ALT+Space, ALT+3, ALT+N, ALT+P) and emits "physical-key-event" to the frontend.

use evdev::Key;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

pub fn start_global_shortcut_listener(app_handle: AppHandle) {
    std::thread::spawn(move || {
        loop {
            // Find keyboard devices that support both KEY_LEFTALT and KEY_SPACE
            let mut devices = Vec::new();
            for (_path, dev) in evdev::enumerate() {
                if let Some(keys) = dev.supported_keys() {
                    if keys.contains(Key::KEY_LEFTALT) && keys.contains(Key::KEY_SPACE) {
                        devices.push(dev);
                    }
                }
            }

            if devices.is_empty() {
                eprintln!("[GlobalShortcut] evdev: No accessible keyboard in /dev/input/event*. (Run 'sudo usermod -aG input $USER' for direct evdev access)");
                std::thread::sleep(Duration::from_millis(3000));
                continue;
            } else {
                eprintln!("[GlobalShortcut] evdev: Monitoring {} physical keyboard device(s)", devices.len());
            }

            // Spawn a monitor thread for each keyboard
            let mut handles = Vec::new();
            for mut dev in devices {
                let app = app_handle.clone();
                let handle = std::thread::spawn(move || {
                    let mut alt_pressed = false;
                    let mut ctrl_pressed = false;
                    let mut last_search_time = std::time::Instant::now() - Duration::from_secs(1);

                    loop {
                        match dev.fetch_events() {
                            Ok(events) => {
                                for ev in events {
                                    if ev.event_type() == evdev::EventType::KEY {
                                        let code = ev.code();
                                        let value = ev.value(); // 0 = release, 1 = press, 2 = repeat

                                        if code == Key::KEY_LEFTALT.code() || code == Key::KEY_RIGHTALT.code() {
                                             alt_pressed = value > 0;
                                        } else if code == Key::KEY_LEFTCTRL.code() || code == Key::KEY_RIGHTCTRL.code() {
                                             ctrl_pressed = value > 0;
                                        } else if code == Key::KEY_SPACE.code() {
                                            if alt_pressed && value == 1 {
                                                if last_search_time.elapsed() >= Duration::from_millis(250) {
                                                    last_search_time = std::time::Instant::now();
                                                    eprintln!("[GlobalShortcut] evdev detected ALT + Space! Emitting trigger-search");
                                                    let _ = app.emit("trigger-search", ());
                                                }
                                            }
                                        } else if code == Key::KEY_3.code() {
                                            if (alt_pressed || ctrl_pressed) && value == 1 {
                                                eprintln!("[GlobalShortcut] evdev detected ALT + 3! Emitting toggle-enigma");
                                                let _ = app.emit("toggle-enigma", ());
                                            }
                                        } else if code == Key::KEY_V.code() {
                                            if alt_pressed && value == 1 {
                                                eprintln!("[GlobalShortcut] evdev detected ALT + V! Emitting open-clipboard-history");
                                                let _ = app.emit("open-clipboard-history", ());
                                            }
                                        }
                                    }
                                }
                            }
                            Err(_) => {
                                // Device disconnected or error, break and rediscover
                                break;
                            }
                        }
                    }
                });
                handles.push(handle);
            }

            // Wait for threads (if keyboards disconnect)
            for h in handles {
                let _ = h.join();
            }

            std::thread::sleep(Duration::from_millis(1000));
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_enumerate_keyboards() {
        let mut count = 0;
        for (path, dev) in evdev::enumerate() {
            if let Some(keys) = dev.supported_keys() {
                if keys.contains(Key::KEY_LEFTALT) && keys.contains(Key::KEY_SPACE) {
                    println!("[TEST] Found physical keyboard device: {:?} -> {:?}", path, dev.name());
                    count += 1;
                }
            }
        }
        println!("[TEST] Physical keyboard devices with ALT+Space: {}", count);
        assert!(count > 0, "Should find at least one physical keyboard");
    }
}
