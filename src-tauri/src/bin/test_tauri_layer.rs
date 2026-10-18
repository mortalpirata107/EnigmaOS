use tauri::Manager;
use gtk::prelude::*;
use std::os::raw::c_int;

#[link(name = "gtk-layer-shell")]
extern "C" {
    fn gtk_layer_is_supported() -> c_int;
    fn gtk_layer_init_for_window(window: *mut gtk::ffi::GtkWindow);
    fn gtk_layer_set_layer(window: *mut gtk::ffi::GtkWindow, layer: c_int);
    fn gtk_layer_set_anchor(window: *mut gtk::ffi::GtkWindow, edge: c_int, anchor_to_edge: c_int);
    fn gtk_layer_set_exclusive_zone(window: *mut gtk::ffi::GtkWindow, exclusive_zone: c_int);
    fn gtk_layer_set_margin(window: *mut gtk::ffi::GtkWindow, edge: c_int, margin: c_int);
}

fn main() {
    std::env::set_var("TAURI_LINUX_USE_GTK", "1");
    std::env::set_var("__NV_DISABLE_EXPLICIT_SYNC", "1");
    std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");

    tauri::Builder::default()
        .setup(|app| {
            if let Some(win) = app.get_webview_window("main") {
                if let Ok(gtk_win) = win.gtk_window() {
                    use gtk::glib::translate::ToGlibPtr;
                    let win_ref: &gtk::Window = gtk_win.upcast_ref();
                    let win_ptr: *mut gtk::ffi::GtkWindow = win_ref.to_glib_none().0;

                    unsafe {
                        gtk_layer_init_for_window(win_ptr);
                        gtk_layer_set_layer(win_ptr, 2); // TOP
                        gtk_layer_set_anchor(win_ptr, 2, 1); // TOP
                        gtk_layer_set_anchor(win_ptr, 0, 1); // LEFT
                        gtk_layer_set_anchor(win_ptr, 1, 1); // RIGHT
                        gtk_layer_set_margin(win_ptr, 2, 0);
                        gtk_layer_set_margin(win_ptr, 0, 0);
                        gtk_layer_set_margin(win_ptr, 1, 0);
                        gtk_layer_set_exclusive_zone(win_ptr, 36);
                    }

                    gtk_win.set_default_size(2560, 600);
                    gtk::prelude::WidgetExt::set_size_request(&gtk_win, 2560, 600);

                    gtk_win.connect_draw(|_, cr| {
                        eprintln!("[TestTauriLayer] gtk_win draw handler called!");
                        cr.set_source_rgb(1.0, 0.0, 0.0);
                        cr.rectangle(0.0, 0.0, 2560.0, 36.0);
                        let _ = cr.fill();
                        gtk::glib::Propagation::Proceed
                    });

                    gtk_win.show_all();

                    gtk::glib::timeout_add_local(std::time::Duration::from_millis(1500), move || {
                        std::thread::spawn(|| {
                            std::thread::sleep(std::time::Duration::from_millis(500));
                            let _ = std::process::Command::new("spectacle")
                                .args(&["-b", "-n", "-o", "/tmp/test_cairo_shot.png"])
                                .output();
                            eprintln!("[TestTauriLayer] Screenshot taken!");
                            std::thread::sleep(std::time::Duration::from_millis(500));
                            std::process::exit(0);
                        });
                        gtk::glib::ControlFlow::Break
                    });
                }
                let _ = win.show();
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
