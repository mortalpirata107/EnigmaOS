fn main() {
    std::env::set_var("TAURI_LINUX_USE_GTK", "1");
    std::env::set_var("__NV_DISABLE_EXPLICIT_SYNC", "1");
    std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");

    tauri::Builder::default()
        .setup(|app| {
            let win = tauri::WebviewWindowBuilder::new(
                app,
                "test",
                tauri::WebviewUrl::App("index.html".into()),
            )
            .title("Test Natural Render 2560")
            .inner_size(2560.0, 600.0)
            .transparent(true)
            .decorations(true)
            .build()?;

            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(2500));
                let _ = std::process::Command::new("spectacle")
                    .args(&["-b", "-n", "-o", "/tmp/screen_natural_render.png"])
                    .output();
                eprintln!("[NaturalTest] Screenshot taken!");
                std::thread::sleep(std::time::Duration::from_millis(500));
                std::process::exit(0);
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
