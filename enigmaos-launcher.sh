#!/usr/bin/env bash
# EnigmaOS Native Desktop Shell Launcher
# Integración nativa con Linux (KDE Plasma 6 / GNOME / Wayland & X11)

export PATH="$HOME/.local/bin:$HOME/.cargo/bin:/usr/local/bin:/usr/bin:$PATH"
export PKG_CONFIG_PATH="$HOME/.local/lib/pkgconfig:$PKG_CONFIG_PATH"
export LD_LIBRARY_PATH="$HOME/.local/lib:$LD_LIBRARY_PATH"

export __NV_DISABLE_EXPLICIT_SYNC=1
export TAURI_LINUX_USE_GTK=1
export GDK_BACKEND="wayland,x11"

# Detener instancias previas si existen
killall -9 enigmaos dynamictopbar wayland_strut_daemon 2>/dev/null || true
sleep 0.15

# Recargar reglas de KWin si estamos en KDE Plasma
if command -v qdbus6 >/dev/null 2>&1; then
    qdbus6 org.kde.KWin /KWin org.kde.KWin.reconfigure >/dev/null 2>&1 || true
fi

# Detectar binario de EnigmaOS
ENIGMA_BIN=""
for candidate in \
    "$HOME/.local/bin/enigmaos" \
    "/usr/local/bin/enigmaos" \
    "/usr/bin/enigmaos" \
    "$(dirname "$0")/src-tauri/target/release/enigmaos" \
    "$(dirname "$0")/target/release/enigmaos"; do
    if [ -x "$candidate" ]; then
        ENIGMA_BIN="$candidate"
        break
    fi
done

if [ -z "$ENIGMA_BIN" ]; then
    ENIGMA_BIN=$(command -v enigmaos 2>/dev/null || true)
fi

if [ -z "$ENIGMA_BIN" ]; then
    echo "[EnigmaOS Launcher] Error: No se encontró el binario 'enigmaos'. Ejecuta ./install.sh primero." >&2
    exit 1
fi

# Iniciar EnigmaOS desacoplado en segundo plano
nohup setsid "$ENIGMA_BIN" "$@" > /tmp/enigmaos.log 2>&1 &
