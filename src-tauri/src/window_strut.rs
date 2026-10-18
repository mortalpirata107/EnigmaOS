//! Window Strut and KDE Plasma Desktop Integration
//!
//! Handles native Wayland Layer Shell (wlr-layer-shell) panel integration with 48px exclusive zone,
//! X11 _NET_WM_STRUT_PARTIAL fallback, multi-workspace stickiness, and Cairo/GDK click-through input shapes.

use std::os::raw::c_int;
use std::sync::Mutex;
use std::collections::HashMap;
use std::time::Instant;
use gtk::prelude::*;
use tauri::{WebviewWindow, Emitter};

struct RegionCacheEntry {
    last_applied: Vec<[i32; 4]>,
    last_update: Instant,
}

fn get_region_cache() -> &'static Mutex<HashMap<String, RegionCacheEntry>> {
    static CACHE: std::sync::OnceLock<Mutex<HashMap<String, RegionCacheEntry>>> = std::sync::OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

#[link(name = "gtk-layer-shell")]
extern "C" {
    fn gtk_layer_is_supported() -> c_int;
    fn gtk_layer_init_for_window(window: *mut gtk::ffi::GtkWindow);
    fn gtk_layer_is_layer_window(window: *mut gtk::ffi::GtkWindow) -> c_int;
    fn gtk_layer_set_layer(window: *mut gtk::ffi::GtkWindow, layer: c_int);
    fn gtk_layer_set_anchor(window: *mut gtk::ffi::GtkWindow, edge: c_int, anchor_to_edge: c_int);
    fn gtk_layer_set_exclusive_zone(window: *mut gtk::ffi::GtkWindow, exclusive_zone: c_int);
    fn gtk_layer_set_keyboard_mode(window: *mut gtk::ffi::GtkWindow, mode: c_int);
    fn gtk_layer_set_margin(window: *mut gtk::ffi::GtkWindow, edge: c_int, margin: c_int);
    #[allow(dead_code)]
    fn gtk_layer_try_force_commit(window: *mut gtk::ffi::GtkWindow);

    fn set_native_wayland_input_regions(
        window: *mut gtk::ffi::GtkWindow,
        rects: *const i32,
        count: c_int,
    ) -> c_int;
}

/// Opt-in diagnostic/workaround: when DTB_FORCE_REDRAW_MS=<ms> is set, periodically invalidates the
/// whole window (including the WebKit child) so GTK repaints regions WebKit failed to damage.
pub fn install_forced_redraw(gtk_window: &gtk::ApplicationWindow) {
    let ms: u64 = std::env::var("DTB_FORCE_REDRAW_MS").ok().and_then(|v| v.parse().ok()).unwrap_or(0);
    if ms == 0 {
        return;
    }
    eprintln!("[Redraw] forced full-window invalidation every {} ms", ms);
    let win = gtk_window.clone();
    gtk::glib::timeout_add_local(std::time::Duration::from_millis(ms), move || {
        win.queue_draw();
        if let Some(child) = win.child() {
            child.queue_draw();
        }
        gtk::glib::ControlFlow::Continue
    });
}

/// Applies universal zero-margin CSS to GTK to prevent any CSD / shadow offset
pub fn apply_zero_margin_css(gtk_window: &gtk::ApplicationWindow) {
    let css_provider = gtk::CssProvider::new();
    let _ = css_provider.load_from_data(b"window, decoration, .window-frame { margin: 0 !important; padding: 0 !important; border: none !important; box-shadow: none !important; background: transparent !important; }");
    if let Some(screen) = gtk::prelude::WidgetExt::screen(gtk_window) {
        gtk::StyleContext::add_provider_for_screen(&screen, &css_provider, gtk::STYLE_PROVIDER_PRIORITY_APPLICATION);
    }
}

/// Recursively applies a Cairo input shape region to a GTK widget and all its child widgets (such as WebKitWebView)
pub fn apply_recursive_input_shape(widget: &gtk::Widget, region: &cairo::Region) {
    if widget.has_window() {
        widget.input_shape_combine_region(Some(region));
    }
    if let Some(gdk_win) = widget.window() {
        gdk_win.input_shape_combine_region(region, 0, 0);
    }
    if let Ok(container) = widget.clone().downcast::<gtk::Container>() {
        for child in container.children() {
            apply_recursive_input_shape(&child, region);
        }
    }
}

/// Attempts to initialize native Wayland Layer Shell (wlr-layer-shell)
/// with TOP layer, exclusive zone of 36px, top/left/right anchors, and strict 0 margin.
pub fn init_wayland_layer_shell(gtk_window: &gtk::ApplicationWindow) -> bool {
    apply_zero_margin_css(gtk_window);
    #[cfg(target_os = "linux")]
    {
        use gtk::glib::translate::ToGlibPtr;
        unsafe {
            let supported = gtk_layer_is_supported();
            eprintln!("[EnigmaOS] gtk_layer_is_supported = {}", supported);
            if supported != 0 {
                let win_ref: &gtk::Window = gtk_window.upcast_ref();
                let win_ptr: *mut gtk::ffi::GtkWindow = win_ref.to_glib_none().0;
                gtk_layer_init_for_window(win_ptr);
                if gtk_layer_is_layer_window(win_ptr) != 0 {
                    // Set Layer to OVERLAY (3) so the topbar floats in front of all active/maximized windows.
                    gtk_layer_set_layer(win_ptr, 3);
                    // Anchor to TOP (2), LEFT (0), RIGHT (1)
                    gtk_layer_set_anchor(win_ptr, 2, 1);
                    gtk_layer_set_anchor(win_ptr, 0, 1);
                    gtk_layer_set_anchor(win_ptr, 1, 1);

                    // Strictly zero margin on all edges (especially top = 2)
                    gtk_layer_set_margin(win_ptr, 2, 0); // TOP
                    gtk_layer_set_margin(win_ptr, 0, 0); // LEFT
                    gtk_layer_set_margin(win_ptr, 1, 0); // RIGHT

                    // Explicit size request and default size for 2560x900 canvas
                    gtk_window.set_default_size(2560, 900);
                    gtk_window.resize(2560, 900);
                    gtk::prelude::WidgetExt::set_size_request(gtk_window, 2560, 900);

                    // Set exclusive zone to 36px to match topbar capsule height exactly (zero phantom margin)
                    gtk_layer_set_exclusive_zone(win_ptr, 36);
                    // Keyboard mode: NONE (0)
                    gtk_layer_set_keyboard_mode(win_ptr, 0);
                    eprintln!("[EnigmaOS] Native Wayland Layer Shell initialized (layer=TOP, exclusive_zone=36, size=2560x900, top_margin=0)");
                    return true;
                } else {
                    eprintln!("[EnigmaOS] gtk_layer_is_layer_window returned 0");
                }
            }
        }
    }
    false
}

/// Initializes native Wayland Layer Shell for the BottomDock:
/// - Layer: TOP (2) - Respects Fullscreen applications
/// - Anchor: BOTTOM (3)
/// - Exclusive zone: 0 (No Strut, floats over maximized windows)
/// - Keyboard mode: NONE (0)
pub fn init_wayland_layer_shell_dock(gtk_window: &gtk::ApplicationWindow) -> bool {
    apply_zero_margin_css(gtk_window);
    #[cfg(target_os = "linux")]
    {
        use gtk::glib::translate::ToGlibPtr;
        unsafe {
            let supported = gtk_layer_is_supported();
            eprintln!("[BottomDock] gtk_layer_is_supported = {}", supported);
            if supported != 0 {
                let win_ref: &gtk::Window = gtk_window.upcast_ref();
                let win_ptr: *mut gtk::ffi::GtkWindow = win_ref.to_glib_none().0;
                gtk_layer_init_for_window(win_ptr);
                if gtk_layer_is_layer_window(win_ptr) != 0 {
                    // Set Layer to OVERLAY (3) so dock floats cleanly above active windows
                    gtk_layer_set_layer(win_ptr, 3);
                    // Anchor to BOTTOM (3), LEFT (0), RIGHT (1) - stretches across the entire screen width
                    gtk_layer_set_anchor(win_ptr, 3, 1);
                    gtk_layer_set_anchor(win_ptr, 0, 1);
                    gtk_layer_set_anchor(win_ptr, 1, 1);

                    // Strictly zero margin
                    gtk_layer_set_margin(win_ptr, 3, 0); // BOTTOM
                    gtk_layer_set_margin(win_ptr, 0, 0); // LEFT
                    gtk_layer_set_margin(win_ptr, 1, 0); // RIGHT

                    gtk_window.set_default_size(2560, 740);
                    gtk_window.resize(2560, 740);
                    gtk::prelude::WidgetExt::set_size_request(gtk_window, 2560, 740);
                    // Exclusive zone 0 (No strut, floats above maximized windows)
                    gtk_layer_set_exclusive_zone(win_ptr, 0);
                    // Keyboard mode: NONE (0)
                    gtk_layer_set_keyboard_mode(win_ptr, 0);
                    eprintln!("[BottomDock] Native Wayland Layer Shell initialized (layer=TOP, exclusive_zone=0, anchor=BOTTOM/LEFT/RIGHT, size=2560x740)");
                    return true;
                } else {
                    eprintln!("[BottomDock] gtk_layer_is_layer_window returned 0");
                }
            }
        }
    }
    false
}

/// Fallback desktop configuration for BottomDock on X11 / non-layer-shell
pub fn configure_dock_desktop_window(gtk_window: &gtk::ApplicationWindow) {
    apply_zero_margin_css(gtk_window);
    gtk_window.set_type_hint(gdk::WindowTypeHint::Dock);
    gtk_window.set_decorated(false);
    gtk_window.set_focus_on_map(false);
    gtk_window.set_accept_focus(false);
    gtk_window.set_keep_above(true);
    gtk_window.stick();
    gtk_window.set_skip_taskbar_hint(true);
    gtk_window.set_skip_pager_hint(true);

    if let Some(screen) = gtk::prelude::WidgetExt::screen(gtk_window) {
        if let Some(visual) = screen.rgba_visual() {
            gtk_window.set_visual(Some(&visual));
        }
    }
    gtk_window.set_app_paintable(true);

    let empty_region = cairo::Region::create();
    apply_recursive_input_shape(gtk_window.upcast_ref(), &empty_region);
}

/// Configures GTK window properties for Main TopBar specifically on Wayland Layer Shell.
pub fn configure_layer_shell_window_main(gtk_window: &gtk::ApplicationWindow) {
    apply_zero_margin_css(gtk_window);
    gtk_window.set_decorated(false);
    gtk_window.set_focus_on_map(false);
    gtk_window.set_accept_focus(true);

    // Initial safe resting input region: Left [0, 0, 500, 36], Center [1140, 0, 280, 36], Right [2200, 0, 360, 36]
    let initial_region = cairo::Region::create();
    let _ = initial_region.union_rectangle(&cairo::RectangleInt::new(0, 0, 500, 36));
    let _ = initial_region.union_rectangle(&cairo::RectangleInt::new(1140, 0, 280, 36));
    let _ = initial_region.union_rectangle(&cairo::RectangleInt::new(2200, 0, 360, 36));
    apply_recursive_input_shape(gtk_window.upcast_ref(), &initial_region);

    #[cfg(target_os = "linux")]
    {
        use gtk::glib::translate::ToGlibPtr;
        let win_ref: &gtk::Window = gtk_window.upcast_ref();
        let win_ptr: *mut gtk::ffi::GtkWindow = win_ref.to_glib_none().0;
        let initial_rects: [i32; 12] = [
            0, 0, 500, 36,
            1140, 0, 280, 36,
            2200, 0, 360, 36,
        ];
        unsafe {
            set_native_wayland_input_regions(win_ptr, initial_rects.as_ptr(), 3);
        }
    }
}

/// Configures GTK window properties for BottomDock on Wayland Layer Shell.
pub fn configure_layer_shell_window_dock(gtk_window: &gtk::ApplicationWindow) {
    apply_zero_margin_css(gtk_window);
    gtk_window.set_decorated(false);
    gtk_window.set_focus_on_map(false);
    gtk_window.set_accept_focus(true);

    let initial_region = cairo::Region::create();
    let _ = initial_region.union_rectangle(&cairo::RectangleInt::new(1230, 718, 100, 22));
    apply_recursive_input_shape(gtk_window.upcast_ref(), &initial_region);

    #[cfg(target_os = "linux")]
    {
        use gtk::glib::translate::ToGlibPtr;
        let win_ref: &gtk::Window = gtk_window.upcast_ref();
        let win_ptr: *mut gtk::ffi::GtkWindow = win_ref.to_glib_none().0;
        let initial_rects: [i32; 4] = [1230, 718, 100, 22];
        unsafe {
            set_native_wayland_input_regions(win_ptr, initial_rects.as_ptr(), 1);
        }
    }
}

/// Configures GTK ApplicationWindow properties for a transparent topbar dock
pub fn configure_desktop_window(gtk_window: &gtk::ApplicationWindow) {
    // 1. Set window type hint to Dock: natively places at (0, 0) flush against top screen bezel
    // and integrates with KWin as a persistent desktop panel
    gtk_window.set_type_hint(gdk::WindowTypeHint::Dock);
    gtk_window.set_decorated(false);

    // 2. Do not steal focus on launch, but accept focus when clicked
    gtk_window.set_focus_on_map(false);
    gtk_window.set_accept_focus(true);

    // 3. Stay always above normal application windows
    gtk_window.set_keep_above(true);

    // 4. Stick across all virtual desktops / workspaces
    gtk_window.stick();

    // 5. Exclude from task managers and alt-tab pagers
    gtk_window.set_skip_taskbar_hint(true);
    gtk_window.set_skip_pager_hint(true);

    // 6. Move explicitly to (0, 0) flush with the top screen bezel
    gtk_window.move_(0, 0);

    // 7. Visual transparency: ensure visual RGBA colormap
    if let Some(screen) = gtk::prelude::WidgetExt::screen(gtk_window) {
        if let Some(visual) = screen.rgba_visual() {
            gtk_window.set_visual(Some(&visual));
        }
    }

    // 8. Make background transparent
    gtk_window.set_app_paintable(true);

    // 9. When mapped, reposition to 0, 0
    gtk_window.connect_map(|win| {
        win.move_(0, 0);
    });

    // 10. Initial input shape: initialize with empty region so clicks pass through until capsules mount
    let empty_region = cairo::Region::create();
    gtk_window.input_shape_combine_region(Some(&empty_region));
    if let Some(gdk_win) = gtk_window.window() {
        gdk_win.input_shape_combine_region(&empty_region, 0, 0);
    }
    gtk_window.queue_draw();
}

/// Updates the hardware input mask using GDK and Cairo.
/// Strictly executes ZERO external processes or terminal commands.
#[tauri::command]
pub fn update_custom_input_regions(window: WebviewWindow, regions: Vec<[i32; 4]>) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        let label = window.label().to_string();
        {
            let mut cache = get_region_cache().lock().unwrap();
            let now = Instant::now();
            if let Some(entry) = cache.get_mut(&label) {
                // Strict deduplication: skip if identical regions
                if entry.last_applied == regions {
                    return Ok(());
                }
                entry.last_applied = regions.clone();
                entry.last_update = now;
            } else {
                cache.insert(
                    label.clone(),
                    RegionCacheEntry {
                        last_applied: regions.clone(),
                        last_update: now,
                    },
                );
            }
        }

        let win = window.clone();
        window.run_on_main_thread(move || {
            if let Ok(gtk_window) = win.gtk_window() {
                use gtk::glib::translate::ToGlibPtr;
                let win_ref: &gtk::Window = gtk_window.upcast_ref();
                let win_ptr: *mut gtk::ffi::GtkWindow = win_ref.to_glib_none().0;

                // Flatten regions into a contiguous i32 array
                let mut flat: Vec<i32> = Vec::with_capacity(regions.len() * 4);
                for r in &regions {
                    flat.push(r[0]);
                    flat.push(r[1]);
                    flat.push(r[2]);
                    flat.push(r[3]);
                }

                // 1. Direct Wayland Layer Shell Protocol commit via wl_surface_set_input_region
                let wayland_ret = unsafe {
                    set_native_wayland_input_regions(
                        win_ptr,
                        if flat.is_empty() { std::ptr::null() } else { flat.as_ptr() },
                        regions.len() as c_int,
                    )
                };

                // 2. Cairo / GDK fallback and recursive input shape for GTK widgets & WebKit
                let region = cairo::Region::create();
                for r in &regions {
                    let rect = cairo::RectangleInt::new(r[0], r[1], r[2], r[3]);
                    let _ = region.union_rectangle(&rect);
                }
                apply_recursive_input_shape(gtk_window.upcast_ref(), &region);

                eprintln!("[InputRegions:{}] applied {} region(s) (wl_ret={}): {:?}", win.label(), regions.len(), wayland_ret, regions);
            }
        }).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Sets dynamic keyboard interactivity for Wayland Layer Shell or X11 surface.
/// When enabled = true, sets GTK_LAYER_SHELL_KEYBOARD_MODE_ON_DEMAND (2).
/// When enabled = false, restores GTK_LAYER_SHELL_KEYBOARD_MODE_NONE (0) to yield keyboard focus to desktop.
///
/// NOTE: We intentionally DO NOT call gtk_window.set_accept_focus(false) or gtk_window.present()!
/// In KWin Wayland, calling set_accept_focus(false) on a layer surface corrupts KWin's pointer routing,
/// causing all underlying desktop windows to stop receiving mouse clicks.
#[tauri::command]
pub fn set_keyboard_interactivity(window: WebviewWindow, enabled: bool, reason: Option<String>) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        use gtk::glib::translate::ToGlibPtr;
        let win = window.clone();
        window.run_on_main_thread(move || {
            if let Ok(gtk_window) = win.gtk_window() {
                let win_ref: &gtk::Window = gtk_window.upcast_ref();
                let win_ptr: *mut gtk::ffi::GtkWindow = win_ref.to_glib_none().0;

                unsafe {
                    if gtk_layer_is_supported() != 0 && gtk_layer_is_layer_window(win_ptr) != 0 {
                        // Modo 2: ON_DEMAND (toma foco de teclado cuando un input de texto está activo)
                        // Modo 0: NONE (el panel no retiene foco de teclado)
                        let mode = if enabled { 2 } else { 0 };
                        gtk_layer_set_keyboard_mode(win_ptr, mode);
                        gtk_layer_try_force_commit(win_ptr);
                        eprintln!("[EnigmaOS] Dynamic layer keyboard mode set to: {} (reason: {:?})", mode, reason);
                    }
                }
            }
        }).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Returns the global cursor position [x, y] in screen pixels
#[tauri::command]
pub fn get_cursor_position() -> [i32; 2] {
    #[cfg(target_os = "linux")]
    {
        if let Some(display) = gdk::Display::default() {
            if let Some(seat) = display.default_seat() {
                if let Some(pointer) = seat.pointer() {
                    let (_screen, x, y) = pointer.position();
                    return [x, y];
                }
            }
        }
    }
    [0, 0]
}

/// Spawns a 50 FPS global mouse cursor hardware tracker on the GTK main loop
#[allow(dead_code)]
pub fn start_global_cursor_tracker(window: WebviewWindow) {
    let mut was_inside = false;
    gtk::glib::timeout_add_local(std::time::Duration::from_millis(20), move || {
        if let Some(display) = gdk::Display::default() {
            if let Some(seat) = display.default_seat() {
                if let Some(pointer) = seat.pointer() {
                    let (_screen, x, y) = pointer.position();
                    // 2560x1440 screen geometry, center is 1280px
                    // Center Notch (idle range: 1140 to 1420, y: 0 to 36)
                    let is_in_idle_notch = x >= 1140 && x <= 1420 && y >= 0 && y <= 36;
                    // Expanded Media Notch (520px wide centered: 1000 to 1560, y: 0 to 275)
                    let is_in_expanded_notch = x >= 1000 && x <= 1560 && y >= 0 && y <= 275;

                    if !was_inside && is_in_idle_notch {
                        was_inside = true;
                        let _ = window.emit("notch_hover", true);
                    } else if was_inside && !is_in_expanded_notch {
                        was_inside = false;
                        let _ = window.emit("notch_hover", false);
                    }
                }
            }
        }
        gtk::glib::ControlFlow::Continue
    });
}
