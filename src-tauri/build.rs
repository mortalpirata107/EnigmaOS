fn main() {
    let home = std::env::var("HOME").unwrap_or_default();
    println!("cargo:rustc-link-search=native={}/.local/lib", home);
    println!("cargo:rustc-link-search=native=/usr/lib");
    println!("cargo:rustc-link-search=native=/usr/local/lib");
    println!("cargo:rustc-link-search=native=/usr/lib/x86_64-linux-gnu");
    println!("cargo:rustc-link-lib=gtk-layer-shell");
    println!("cargo:rustc-link-lib=wayland-client");
    println!("cargo:rustc-link-arg=-Wl,-rpath,{}/.local/lib", home);
    println!("cargo:rustc-link-arg=-Wl,-rpath,/usr/local/lib");
    println!("cargo:rustc-link-arg=-Wl,-rpath,/usr/lib/x86_64-linux-gnu");

    let mut build = cc::Build::new();
    build.file("c_src/wayland_input.c");
    build.include(format!("{}/.local/include", home));
    build.include("/usr/include");
    build.include("/usr/local/include");

    if let Ok(cflags) = std::process::Command::new("pkg-config").args(&["--cflags", "gtk+-3.0", "wayland-client"]).output() {
        let flags_str = String::from_utf8_lossy(&cflags.stdout);
        for flag in flags_str.split_whitespace() {
            if let Some(inc) = flag.strip_prefix("-I") {
                build.include(inc);
            } else if flag.starts_with("-D") {
                build.flag(flag);
            }
        }
    }
    build.compile("wayland_input_helper");

    tauri_build::build();
}
