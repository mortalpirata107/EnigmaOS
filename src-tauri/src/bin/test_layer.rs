use std::os::raw::c_int;
use gtk::prelude::*;

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
    gtk::init().expect("Failed to initialize GTK");

    unsafe {
        if gtk_layer_is_supported() == 0 {
            eprintln!("gtk_layer_is_supported == 0");
            return;
        }
    }

    let window = gtk::Window::new(gtk::WindowType::Toplevel);
    use gtk::glib::translate::ToGlibPtr;
    let win_ptr: *mut gtk::ffi::GtkWindow = window.to_glib_none().0;

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

    window.set_default_size(2560, 36);
    window.set_size_request(2560, 36);

    let drawing_area = gtk::DrawingArea::new();
    drawing_area.connect_draw(|_, cr| {
        cr.set_source_rgb(1.0, 0.0, 0.0); // Bright pure RED
        let _ = cr.paint();
        gtk::glib::Propagation::Proceed
    });
    window.add(&drawing_area);

    window.show_all();

    std::thread::spawn(|| {
        std::thread::sleep(std::time::Duration::from_millis(1500));
        let _ = std::process::Command::new("spectacle")
            .args(&["-b", "-n", "-o", "/tmp/test_layer_shot.png"])
            .output();
        std::thread::sleep(std::time::Duration::from_millis(500));
        std::process::exit(0);
    });

    gtk::main();
}
