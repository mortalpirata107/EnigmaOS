#!/usr/bin/env bash
# ==============================================================================
# EnigmaOS - Universal Linux Installer
# Supported: Arch Linux, Ubuntu, Debian, Fedora, openSUSE, Pop!_OS, Linux Mint
# ==============================================================================

set -e

CYAN='\033[0;36m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color
BOLD='\033[1m'

echo -e "${CYAN}${BOLD}"
cat << "EOF"
  ______       _                            ____   _____ 
 |  ____|     (_)                          / __ \ / ____|
 | |__   _ __  _  __ _ _ __ ___   __ _    | |  | | (___  
 |  __| | '_ \| |/ _` | '_ ` _ \ / _` |   | |  | |\___ \ 
 | |____| | | | | (_| | | | | | | (_| |   | |__| |____) |
 |______|_| |_|_|\__, |_| |_| |_|\__,_|    \____/|_____/ 
                  __/ |                                  
                 |___/                                   
EOF
echo -e "${NC}"
echo -e "${BOLD}Instalador Universal de EnigmaOS para Linux${NC}"
echo -e "Repositorio oficial: https://github.com/mortalpirata107/EnigmaOS"
echo -e "------------------------------------------------------------------"

INSTALL_DIR="$HOME/.local/bin"
DESKTOP_DIR="$HOME/.local/share/applications"
ICON_DIR="$HOME/.local/share/icons/hicolor/512x512/apps"
CONFIG_DIR="$HOME/.config/enigmaos"
DATA_DIR="$HOME/.local/share/enigma"

mkdir -p "$INSTALL_DIR" "$DESKTOP_DIR" "$ICON_DIR" "$CONFIG_DIR" "$DATA_DIR"

# 1. Detectar Distribución de Linux
DISTRO="unknown"
if [ -f /etc/os-release ]; then
    . /etc/os-release
    DISTRO=$ID
    LIKE=$ID_LIKE
fi

echo -e "${YELLOW}>> Detectando sistema operativo: ${DISTRO} (${LIKE:-native})${NC}"

# Función para instalar dependencias nativas del sistema
install_system_deps() {
    echo -e "${YELLOW}>> Comprobando e instalando dependencias nativas del sistema...${NC}"
    case "$DISTRO" in
        arch|manjaro|endeavouros)
            sudo pacman -S --needed --noconfirm \
                webkit2gtk-4.1 gtk3 cairo openssl alsa-lib wmctrl libappindicator-gtk3 xdotool 2>/dev/null || \
            sudo pacman -S --needed --noconfirm \
                webkit2gtk gtk3 cairo openssl alsa-lib wmctrl xdotool
            ;;
        ubuntu|debian|pop|mint|elementary|zorin)
            sudo apt-get update -y
            sudo apt-get install -y \
                libwebkit2gtk-4.1-dev libgtk-3-dev libcairo2-dev libssl-dev libasound2-dev wmctrl libayatana-appindicator3-dev xdotool 2>/dev/null || \
            sudo apt-get install -y \
                libwebkit2gtk-4.0-dev libgtk-3-dev libcairo2-dev libssl-dev libasound2-dev wmctrl xdotool
            ;;
        fedora|rhel|centos)
            sudo dnf install -y \
                webkit2gtk4.1-devel gtk3-devel cairo-devel openssl-devel alsa-lib-devel wmctrl libappindicator-gtk3-devel xdotool
            ;;
        opensuse*|suse)
            sudo zypper install -y \
                webkit2gtk3-devel gtk3-devel cairo-devel libopenssl-devel alsa-devel wmctrl libappindicator3-1 xdotool
            ;;
        *)
            echo -e "${YELLOW}Aviso: Distribución no reconocida para auto-instalación de paquetes. Asegúrate de tener GTK3, WebKit2GTK y ALSA instalados.${NC}"
            ;;
    esac
}

# Preguntar antes de instalar dependencias si sudo está disponible
if command -v sudo >/dev/null 2>&1; then
    install_system_deps
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd || echo "")"

# 2. Determinar si compilamos desde fuentes locales o descargamos binario
if [ -f "$SCRIPT_DIR/src-tauri/Cargo.toml" ] && [ -f "$SCRIPT_DIR/package.json" ]; then
    echo -e "${CYAN}>> Modo: Compilación e instalación desde código fuente local${NC}"
    cd "$SCRIPT_DIR"

    # Verificar Node.js
    if ! command -v npm >/dev/null 2>&1; then
        echo -e "${RED}Error: Node.js / npm no está instalado. Instálalo para continuar.${NC}"
        exit 1
    fi

    # Verificar Cargo / Rust
    if ! command -v cargo >/dev/null 2>&1; then
        echo -e "${YELLOW}>> Rust no detectado. Instalando rustup...${NC}"
        curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
        source "$HOME/.cargo/env"
    fi

    echo -e "${YELLOW}>> Instalando dependencias de Node.js...${NC}"
    npm install

    echo -e "${YELLOW}>> Compilando frontend (Vite)...${NC}"
    npm run build

    echo -e "${YELLOW}>> Compilando backend en Rust (Release)...${NC}"
    cargo build --manifest-path src-tauri/Cargo.toml --release

    TARGET_BIN="$SCRIPT_DIR/src-tauri/target/release/enigmaos"
    if [ ! -f "$TARGET_BIN" ]; then
        TARGET_BIN="$SCRIPT_DIR/target/release/enigmaos"
    fi

    cp "$TARGET_BIN" "$INSTALL_DIR/enigmaos"
    chmod +x "$INSTALL_DIR/enigmaos"

    # Copiar launcher
    cp "$SCRIPT_DIR/enigmaos-launcher.sh" "$INSTALL_DIR/enigmaos-launcher"
    chmod +x "$INSTALL_DIR/enigmaos-launcher"

    # Copiar icono
    if [ -f "$SCRIPT_DIR/src-tauri/icons/128x128@2x.png" ]; then
        cp "$SCRIPT_DIR/src-tauri/icons/128x128@2x.png" "$ICON_DIR/enigmaos.png"
    fi

    # Copiar desktop entry
    sed -e "s|Exec=enigmaos-launcher|Exec=$INSTALL_DIR/enigmaos-launcher|g" \
        -e "s|Icon=enigmaos|Icon=$ICON_DIR/enigmaos.png|g" \
        "$SCRIPT_DIR/enigmaos.desktop" > "$DESKTOP_DIR/enigmaos.desktop"
    chmod +x "$DESKTOP_DIR/enigmaos.desktop"

else
    echo -e "${CYAN}>> Modo: Descarga de binario precompilado desde GitHub Releases${NC}"
    
    LATEST_JSON=$(curl -s "https://api.github.com/repos/mortalpirata107/EnigmaOS/releases/latest" 2>/dev/null || echo "")
    DOWNLOAD_URL=$(echo "$LATEST_JSON" | grep -o 'https://[^"]*EnigmaOS[^"]*\.AppImage' | head -n 1 || echo "")

    if [ -z "$DOWNLOAD_URL" ]; then
        DOWNLOAD_URL=$(echo "$LATEST_JSON" | grep -o 'https://[^"]*enigmaos[^"]*\.AppImage' | head -n 1 || echo "")
    fi

    if [ -n "$DOWNLOAD_URL" ]; then
        echo -e "${YELLOW}>> Descargando última versión de EnigmaOS AppImage...${NC}"
        curl -L "$DOWNLOAD_URL" -o "$INSTALL_DIR/enigmaos"
        chmod +x "$INSTALL_DIR/enigmaos"
    else
        echo -e "${YELLOW}>> No hay binarios AppImage publicados aún en GitHub Releases.${NC}"
        echo -e "Por favor, clona el repositorio y ejecuta ./install.sh para compilarlo:"
        echo -e "  git clone https://github.com/mortalpirata107/EnigmaOS.git"
        echo -e "  cd EnigmaOS && ./install.sh"
        exit 0
    fi
fi

# 3. Inicializar configuración de modelos si no existe
if [ ! -f "$CONFIG_DIR/models.json" ]; then
    echo -e "${YELLOW}>> Generando configuración inicial de modelos en $CONFIG_DIR/models.json...${NC}"
    cat << "EOF" > "$CONFIG_DIR/models.json"
{
  "preset": "balanced",
  "orchestrator_model": "llama3.2:3b",
  "system_model": "hermes3:8b",
  "code_model": "qwen2.5-coder:7b",
  "reasoning_model": "deepseek-r1:8b",
  "general_model": "llama3.2:3b",
  "vision_model": "llava:7b",
  "default_model": "llama3.2:3b"
}
EOF
fi

# Actualizar base de datos de escritorio e iconos
update-desktop-database "$DESKTOP_DIR" 2>/dev/null || true
gtk-update-icon-cache -f -t "$HOME/.local/share/icons/hicolor" 2>/dev/null || true

echo -e "\n${GREEN}${BOLD}✔ ¡EnigmaOS instalado exitosamente!${NC}"
echo -e "------------------------------------------------------------------"
echo -e "Puedes iniciar EnigmaOS:"
echo -e "  1. Desde tu lanzador de aplicaciones (KRunner, GNOME Dash, Rofi): buscar ${BOLD}EnigmaOS${NC}"
echo -e "  2. Desde la terminal: ${BOLD}enigmaos-launcher${NC} o ${BOLD}enigmaos${NC}"
echo -e "  3. Atajo global por defecto para invocar a Enigma: ${BOLD}Alt + 3${NC}"
echo -e "  4. Configuración de Modelos de IA:"
echo -e "     - Archivo de configuración: ${BOLD}~/.config/enigmaos/models.json${NC}"
echo -e "     - Para instalar el modelo recomendado por defecto (equilibrado):"
echo -e "       ${CYAN}ollama pull llama3.2:3b${NC}"
echo -e "     - Para equipos con recursos limitados (solo CPU / 4-8 GB RAM):"
echo -e "       ${CYAN}ollama pull llama3.2:1b${NC} y cambia 'default_model' en models.json"
echo -e "------------------------------------------------------------------"
