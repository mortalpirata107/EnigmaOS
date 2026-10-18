# 🌌 EnigmaOS

<p align="center">
  <img src="docs/screenshots/topbar_overview.png" alt="EnigmaOS Overview" width="100%" />
</p>

<p align="center">
  <strong>Entorno de sobrecubierta futurista, Dynamic Island, Dock inteligente y Asistente de IA multimodal para Linux (Wayland & X11).</strong>
</p>

<p align="center">
  <a href="https://github.com/mortalpirata107/EnigmaOS/releases"><img src="https://img.shields.io/github/v/release/mortalpirata107/EnigmaOS?style=for-the-badge&color=red" alt="Release" /></a>
  <img src="https://img.shields.io/badge/Platform-Linux%20Wayland%20%7C%20X11-red?style=for-the-badge&logo=linux" alt="Linux Wayland" />
  <img src="https://img.shields.io/badge/Built%20With-Tauri%20v2-24C8D8?style=for-the-badge&logo=tauri" alt="Tauri v2" />
  <img src="https://img.shields.io/badge/Backend-Rust-DEA584?style=for-the-badge&logo=rust" alt="Rust" />
  <img src="https://img.shields.io/badge/Frontend-React%2019%20%7C%20TypeScript-61DAFB?style=for-the-badge&logo=react" alt="React TypeScript" />
  <img src="https://img.shields.io/badge/Style-Neumorphic%20Obsidian-0B0B0E?style=for-the-badge" alt="Neumorphic Obsidian" />
  <img src="https://img.shields.io/badge/License-MIT-yellow?style=for-the-badge" alt="MIT License" />
</p>

---

## ⚡ Instalación Rápida (1 Solo Comando)

Puedes instalar EnigmaOS en cualquier distribución Linux (Ubuntu, Debian, Arch Linux, Fedora, Manjaro, openSUSE, Pop!_OS) ejecutando en tu terminal:

```bash
curl -fsSL https://raw.githubusercontent.com/mortalpirata107/EnigmaOS/main/install.sh | bash
```

> [!NOTE]
> **¿Qué hace el instalador automático?**
> 1. Detecta tu distribución e instala automáticamente las dependencias nativas del sistema (`webkit2gtk`, `gtk3`, `cairo`, `alsa`, etc.).
> 2. Configura el binario optimizado `enigmaos` y el lanzador `enigmaos-launcher` en `~/.local/bin/`.
> 3. Registra el acceso directo `enigmaos.desktop` con iconos oficiales en tu lanzador de aplicaciones (KRunner, GNOME Dash, Rofi, etc.).
> 4. Genera la plantilla de configuración de modelos de IA en `~/.config/enigmaos/models.json`.

---

## 🧠 Guía de Modelos de IA (Ollama)

EnigmaOS utiliza **[Ollama](https://ollama.com/)** para ejecutar Inteligencia Artificial de forma **100% local, privada y sin enviar tus datos a la nube**.

### 1. Instalar Ollama (si no lo tienes aún)
```bash
curl -fsSL https://ollama.com/install.sh | sh
```

---

### 2. Requisitos de Hardware y Perfiles de Modelos

EnigmaOS se adapta a cualquier equipo: desde un portátil modesto con solo CPU hasta una estación de trabajo con GPU dedicada. Elige el nivel según tu hardware:

| Perfil | Requisitos de Hardware | Rendimiento | Modelo General | Modelo de Visión |
| :--- | :--- | :--- | :--- | :--- |
| **Básico (Ligero)** | CPU moderna · 4 GB a 8 GB de RAM · Sin GPU dedicada | Rápido y fluido en cualquier PC portátil | `llama3.2:1b` o `qwen2.5:1.5b` | `moondream` |
| **Equilibrado (Recomendado)** | 16 GB de RAM o GPU con 6 GB - 8 GB VRAM (RTX 2060/3060/4060 o AMD RX) | Excelente razonamiento y velocidad de respuesta | `llama3.2:3b` + `qwen2.5-coder:7b` | `llava:7b` |
| **Pro / Máximo** | 32 GB+ de RAM o GPU con 12 GB+ VRAM (RTX 3080/4070/4080/4090) | Máxima precisión analítica, código y razonamiento | `hermes3:8b` + `deepseek-r1:14b` | `llava:13b` |

---

### 3. Comandos para Descargar los Modelos

Ejecuta en tu terminal el comando del perfil que mejor se ajuste a tu máquina:

#### Opción A: Perfil Básico (Para cualquier PC o portátil sin tarjeta gráfica dedicada)
```bash
# Modelo ultraligero y rápido (solo ocupa ~1.3 GB de RAM)
ollama pull llama3.2:1b

# Modelo ligero de visión para análisis de capturas de pantalla (opcional)
ollama pull moondream
```

#### Opción B: Perfil Equilibrado ⭐ (Recomendado para la mayoría de usuarios)
```bash
# Modelo conversacional y orquestador diario
ollama pull llama3.2:3b

# Modelo para tareas de programación y refactorización
ollama pull qwen2.5-coder:7b

# Modelo de visión multimodal para capturas y análisis de pantalla
ollama pull llava:7b
```

#### Opción C: Perfil Pro / Máximo (Para equipos de alto rendimiento)
```bash
# Modelo especializado en herramientas y control del sistema
ollama pull hermes3:8b

# Modelo avanzado de razonamiento y lógica profunda
ollama pull deepseek-r1:8b

# Modelo especializado en desarrollo y código
ollama pull qwen2.5-coder:7b

# Modelo de visión de alta fidelidad
ollama pull llava:7b
```

---

### 4. 🎛️ Cómo Cambiar los Modelos Fácilmente (Sin Tocar Código)

EnigmaOS almacena la configuración de modelos en un archivo de texto simple y legible:

📁 **Ruta:** `~/.config/enigmaos/models.json`

Puedes abrir este archivo con cualquier editor de texto (Kate, Gedit, Nano, VS Code, etc.):

```bash
nano ~/.config/enigmaos/models.json
```

Simplemente cambia el nombre del modelo por el que tú tengas instalado. Aquí tienes tres ejemplos listos para copiar y pegar:

#### Ejemplo 1: Configuración para PC Ligero (CPU / 8GB RAM)
```json
{
  "preset": "lightweight",
  "orchestrator_model": "llama3.2:1b",
  "system_model": "llama3.2:1b",
  "code_model": "llama3.2:1b",
  "reasoning_model": "llama3.2:1b",
  "general_model": "llama3.2:1b",
  "vision_model": "moondream",
  "default_model": "llama3.2:1b"
}
```

#### Ejemplo 2: Configuración Equilibrada (Recomendada)
```json
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
```

#### Ejemplo 3: Usar un Solo Modelo para Todo
Si solo quieres descargar un único modelo (por ejemplo, `mistral` o `llama3.2`):
```json
{
  "preset": "custom",
  "orchestrator_model": "llama3.2",
  "system_model": "llama3.2",
  "code_model": "llama3.2",
  "reasoning_model": "llama3.2",
  "general_model": "llama3.2",
  "vision_model": "llava",
  "default_model": "llama3.2"
}
```

> [!TIP]
> **Tolerancia a fallos inteligente:**  
> Si configuras un modelo que aún no has descargado, EnigmaOS **no fallará ni se cerrará**: detecta automáticamente qué modelos tienes instalados en Ollama y usa el más adecuado como alternativa instantánea.

---

## ✨ Características Principales

### 1. 🏝️ Dynamic Notch (Dynamic Island para Linux)
- **Física de resortes ultra-fluida:** Transiciones líquidas orgánicas impulsadas por Framer Motion.
- **Reloj Neumórfico:** Números monoespaciados tabulares con micro-orbe rubí pulsante de latido.
- **Reproductor Multimedia MPRIS:** Detección automática de Spotify y reproductores multimedia con mini-ecualizador espectral animado en carmesí y panel expandido con controles de transporte y barra de progreso.

<p align="center">
  <img src="docs/screenshots/spotify_notch.png" alt="Dynamic Island Spotify Player" width="85%" />
</p>

---

### 2. 📋 Portapapeles Inteligente con Caché Desacoplado (`Alt + V`)
- **Monitor en tiempo real en segundo plano:** Escucha continua en Wayland con soporte nativo para texto, código, colores, enlaces e imágenes.
- **Clasificador Heurístico Automático:** Identifica y clasifica instantáneamente fragmentos de código (JavaScript, Rust, Python, SQL), colores hexadecimales/RGBA con muestra visual en vivo, URLs con extracción de dominio y texto enriquecido.
- **Arquitectura de Miniaturas + Caché en Disco:** Almacenamiento optimizado de capturas con apertura instantánea en menos de 50 ms.
- **Copiado Nativo en 1 Clic:** Copia directa a nivel de sistema (`arboard` / `wl-copy`).

<p align="center">
  <img src="docs/screenshots/clipboard_history.png" alt="Portapapeles Inteligente" width="85%" />
</p>

---

### 3. 🔍 Lanzador Universal & Spotlight Hub (`Alt + Espacio`)
- **Buscador de aplicaciones y archivos:** Búsqueda difusa ultrarrápida de aplicaciones `.desktop`, binarios del sistema y carpetas.
- **Conversor de divisas y calculadora instantánea:** Resuelve expresiones matemáticas y conversiones de moneda en vivo (ej: `50 usd a eur`).
- **Acciones del sistema:** Atajos rápidos para suspender, bloquear pantalla, reiniciar o apagar.

<p align="center">
  <img src="docs/screenshots/search_launcher.png" alt="Spotlight Launcher" width="85%" />
</p>

---

### 4. 🧠 Enigma AI Hub & VoiceOrb 3D (`Alt + 3`)
- **VoiceOrb 3D en WebGL:** Orbe de partículas carmesí reactivo al audio y estado de inferencia (`idle`, `thinking`, `speaking`, `alert`, `listening`, `searching`).
- **Panel Bento Multimodal:** Chat conversacional (Ollama local), Visión IA (captura y análisis de pantalla con modelos de visión), Calendario, Tareas, Horarios y Notas locales persistentes en SQLite.
- **Dictado STT / TTS:** Síntesis y transcripción de voz local con auto-ducking inteligente de audio.

<p align="center">
  <img src="docs/screenshots/enigma_assistant.png" alt="Enigma AI Assistant Hub" width="85%" />
</p>

---

### 5. 🎛️ Cápsulas Modulares de la Topbar
- **Cápsula Izquierda:**
  - Identidad de la distribución con menú rápido.
  - Indicador dinámico de escritorios virtuales KWin con cambio reactivo.
  - Lanzadores rápidos de aplicaciones (Terminal, Navegador, Gestor de archivos, Editor).
  - Píldora de búsqueda rápida.
- **Cápsula Derecha:**
  - Wi-Fi y redes cableadas con menú emergente detallado.
  - Micrófono con alternancia de mute en un clic.
  - Bluetooth con listado de dispositivos y emparejamiento.
  - Modo No Molestar (DND).
  - Mezclador de volumen con slider de precisión y estado MUTE.
  - Monitor de nivel de batería con indicador de corriente CA.

---

## ⌨️ Atajos de Teclado Globales

| Atajo | Acción |
| :--- | :--- |
| **`Alt + Espacio`** | Abre / Cierra el Lanzador Universal Spotlight |
| **`Alt + V`** | Abre / Cierra el Portapapeles Inteligente con miniaturas y código |
| **`Alt + 3`** | Activa el Asistente Enigma AI con VoiceOrb 3D y panel Bento |
| **`Esc`** | Cierra cualquier modal activo y repliega el Notch al modo reloj |

---

## 💻 Control por Línea de Comandos (CLI)

Puedes controlar y alternar los diferentes paneles de EnigmaOS desde cualquier terminal o script de shell:

```bash
# Alternar el buscador universal Spotlight
enigmaos --toggle-search

# Alternar el historial del portapapeles inteligente
enigmaos --toggle-clipboard

# Alternar el centro de asistencia Enigma AI
enigmaos --toggle-enigma

# Iniciar dictado por voz (STT)
enigmaos --stt

# Enviar texto a síntesis de voz (TTS)
enigmaos --speak "Hola, sistema Enigma operativo"

# Ejecutar un prompt directamente en la IA
enigmaos --enigma-prompt "¿Qué tareas tengo pendientes hoy?"
```

---

## 🎨 Sistema de Diseño Neumórfico

- **Obsidiana Sólida:** `#0B0B0E` puro e idéntico en todas las islas para eliminar discordancias de color.
- **Borde de Relieve Carmesí:** `border: 1px solid rgba(239, 68, 68, 0.22)`
- **Sombra Neumórfica Profunda:** `box-shadow: 0 16px 36px rgba(0, 0, 0, 0.95)`
- **Cavidades Talladas (`.neu-inset`):** Fondo `#08080C` con sombra interior suave para cajas de búsqueda y badges.
- **Botones Táctiles (`.neu-extruded`):** Fondo `#111116` con micro-relieve afilado y hover activo.
- **Micro-orbe Rubí (`.neu-led-red`):** Gradiente `#991B1B` a `#EF4444` con resplandor difuso.

---

## 🛠️ Compilación Manual desde el Código Fuente

Si prefieres compilar el proyecto manualmente desde el código fuente:

### 1. Clonar el Repositorio
```bash
git clone https://github.com/mortalpirata107/EnigmaOS.git
cd EnigmaOS
```

### 2. Ejecutar el Instalador Automático
```bash
./install.sh
```

O paso a paso de forma manual:
```bash
# Instalar dependencias de frontend y compilar
npm install
npm run build

# Compilar binario nativo de Rust con optimizaciones release
cargo build --release --manifest-path src-tauri/Cargo.toml

# Copiar binario y launcher
mkdir -p ~/.local/bin
cp src-tauri/target/release/enigmaos ~/.local/bin/enigmaos
cp enigmaos-launcher.sh ~/.local/bin/enigmaos-launcher
chmod +x ~/.local/bin/enigmaos ~/.local/bin/enigmaos-launcher
```

---

## 🚀 Inicio Automático con la Sesión

Para que EnigmaOS se inicie automáticamente al encender tu PC o iniciar sesión en tu entorno de escritorio:

Crea o verifica el archivo `~/.config/autostart/enigmaos.desktop`:

```ini
[Desktop Entry]
Type=Application
Exec=enigmaos-launcher
Hidden=false
NoDisplay=false
X-GNOME-Autostart-enabled=true
Name=EnigmaOS
Comment=EnigmaOS AI Desktop Shell para Linux
```

---

## 📄 Licencia

Este proyecto está bajo la licencia **MIT**. Desarrollado con pasión para la comunidad de Linux y código abierto.
