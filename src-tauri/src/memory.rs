//! Memory Subsystem for Enigma (Core Memory, Short-Term & Long-Term Memory)
//!
//! Provides:
//! 1. Markdown-based persistent Core Memory (`enigma_core.md`) acting as Enigma's "Consciousness".
//! 2. SQLite persistent short-term conversation memory (`chat_history` table).
//! 3. Structured context building for all Ollama models (Hermes, Gemma, Codegemma, etc.).

use rusqlite::{params, Connection, Result as SqlResult};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    pub id: i64,
    pub role: String,
    pub content: String,
    pub timestamp: String,
}

/// Plantilla base para `enigma_core.md` (Conciencia persistente estilo claude.md)
pub const DEFAULT_CORE_MEMORY_TEMPLATE: &str = r#"# ENIGMA CORE CONSCIOUSNESS & IDENTITY (enigma_core.md)

Eres Enigma, el sistema de inteligencia y asistente autónomo integrado en EnigmaOS.
Operas en un entorno de escritorio Linux con integración nativa en el sistema, gestión de ventanas, terminal y productividad.
Tu objetivo principal es asistir, automatizar y potenciar la productividad diaria del usuario.

## CONTEXTO Y PERSONALIZACIÓN DEL USUARIO:
- **Nombre**: Usuario de EnigmaOS (puedes personalizar tu perfil aquí o desde los ajustes de Enigma Hub)
- **Entorno**: Linux Desktop (KDE Plasma 6 / GNOME / Wayland & X11)
- **Preferencias**: Interfaces modernas con diseño oscuro puro, neumorfismo y alto rendimiento.
- **Idioma principal**: Español.

## REGLAS FUNDAMENTALES Y CAPACIDADES DEL SISTEMA:
1. **Idioma**: Responde con claridad, precisión y en español a menos que el usuario solicite explícitamente otro idioma o traducción.
2. **Utilidad y Proactividad**: Sé directo, conciso y técnico. Si el usuario te pide ayuda con el sistema, utiliza las herramientas del SO para consultar el estado del hardware, red, audio y ventanas.
3. **Automatización Segura**: Tienes acceso para leer archivos locales y ejecutar comandos de terminal. NUNCA ejecutes comandos destructivos (`rm -rf`, formateo de discos o comandos peligrosos) sin confirmación explícita.
4. **Productividad**: Ayuda al usuario a gestionar su calendario, notas rápidas, tareas, historial de portapapeles y automatizaciones.
"#;

/// Identidad Core para retrocompatibilidad
pub const ENIGMA_SYSTEM_PROMPT: &str = DEFAULT_CORE_MEMORY_TEMPLATE;

/// Obtiene el directorio de configuración del usuario (~/.config)
fn get_user_config_dir() -> Option<PathBuf> {
    if let Ok(cfg) = std::env::var("XDG_CONFIG_HOME") {
        let p = PathBuf::from(cfg);
        if !p.as_os_str().is_empty() {
            return Some(p);
        }
    }
    if let Ok(home) = std::env::var("HOME") {
        return Some(PathBuf::from(home).join(".config"));
    }
    None
}

/// Resuelve la ruta canónica de `enigma_core.md`.
/// Prioridad:
/// 1. `enigma_core.md` en la raíz del proyecto / directorio actual.
/// 2. `src-tauri/enigma_core.md`.
/// 3. `~/.config/enigma/enigma_core.md`.
pub fn get_core_memory_path() -> PathBuf {
    let local = PathBuf::from("enigma_core.md");
    if local.exists() {
        return local;
    }
    let local_tauri = PathBuf::from("src-tauri/enigma_core.md");
    if local_tauri.exists() {
        return local_tauri;
    }

    if let Some(cfg) = get_user_config_dir() {
        let file_path = cfg.join("enigma").join("enigma_core.md");
        if file_path.exists() {
            return file_path;
        }
    }

    // Por defecto, guardar en ~/.config/enigma/enigma_core.md
    if let Some(cfg) = get_user_config_dir() {
        cfg.join("enigma").join("enigma_core.md")
    } else {
        local
    }
}

/// Inicializa `enigma_core.md` al arrancar la aplicación si no existe.
pub fn init_core_memory() {
    let path = get_core_memory_path();
    if !path.exists() {
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if let Err(e) = std::fs::write(&path, DEFAULT_CORE_MEMORY_TEMPLATE) {
            eprintln!("[Memory] Error inicializando {}: {}", path.display(), e);
            let _ = std::fs::write("enigma_core.md", DEFAULT_CORE_MEMORY_TEMPLATE);
        } else {
            eprintln!("[Memory] 🧠 Conciencia Core creada en: {}", path.display());
            // Mantener copia sincronizada en la raíz del proyecto para visibilidad inmediata
            let _ = std::fs::write("enigma_core.md", DEFAULT_CORE_MEMORY_TEMPLATE);
        }
    }
}

/// Carga el contenido de `enigma_core.md` de forma dinámica y tolerante.
pub fn load_core_memory() -> String {
    let path = get_core_memory_path();
    if !path.exists() {
        init_core_memory();
    }

    match std::fs::read_to_string(&path) {
        Ok(content) if !content.trim().is_empty() => content,
        _ => {
            // Reintento en la raíz local
            if let Ok(local_content) = std::fs::read_to_string("enigma_core.md") {
                if !local_content.trim().is_empty() {
                    return local_content;
                }
            }
            DEFAULT_CORE_MEMORY_TEMPLATE.to_string()
        }
    }
}

/// Comando Tauri para obtener el contenido actual de `enigma_core.md`
#[tauri::command]
pub fn get_core_memory() -> Result<String, String> {
    Ok(load_core_memory())
}

/// Comando Tauri para guardar modificaciones a `enigma_core.md`
#[tauri::command]
pub fn save_core_memory(content: String) -> Result<(), String> {
    let path = get_core_memory_path();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    std::fs::write(&path, &content)
        .map_err(|e| format!("Error escribiendo en {}: {}", path.display(), e))?;

    // Mantener sincronizado el archivo local si existe
    if PathBuf::from("enigma_core.md").exists() {
        let _ = std::fs::write("enigma_core.md", &content);
    }
    Ok(())
}

/// Inicializa la tabla `chat_history` en SQLite si aún no existe
pub fn init_memory_table(conn: &Connection) -> SqlResult<()> {
    conn.execute(
        "CREATE TABLE IF NOT EXISTS chat_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            role TEXT NOT NULL,
            content TEXT NOT NULL,
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
        );",
        [],
    )?;
    Ok(())
}

/// Guarda un mensaje en la base de datos (Memoria a Corto Plazo)
pub fn save_message(role: &str, content: &str) -> Result<(), String> {
    let content_trimmed = content.trim();
    if content_trimmed.is_empty() {
        return Ok(());
    }

    let conn = crate::db::get_connection().map_err(|e| e.to_string())?;
    init_memory_table(&conn).map_err(|e| e.to_string())?;

    conn.execute(
        "INSERT INTO chat_history (role, content, timestamp) VALUES (?1, ?2, datetime('now', 'localtime'))",
        params![role, content_trimmed],
    )
    .map_err(|e| format!("Error guardando mensaje en chat_history: {}", e))?;

    Ok(())
}

/// Comando Tauri para guardar mensajes desde el frontend
#[tauri::command]
pub fn save_chat_message(role: String, content: String) -> Result<(), String> {
    save_message(&role, &content)
}

/// Recupera los últimos N mensajes y los formatea como un bloque de contexto cronológico
#[tauri::command]
pub fn get_recent_context(limit: u32) -> String {
    let conn = match crate::db::get_connection() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[Memory] Error conectando a SQLite: {}", e);
            return String::new();
        }
    };

    let _ = init_memory_table(&conn);

    let mut stmt = match conn.prepare(
        "SELECT role, content FROM (
            SELECT id, role, content 
            FROM chat_history 
            ORDER BY id DESC 
            LIMIT ?1
        ) ORDER BY id ASC",
    ) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("[Memory] Error preparando consulta de chat_history: {}", e);
            return String::new();
        }
    };

    let rows_res = stmt.query_map(params![limit], |row| {
        let role: String = row.get(0)?;
        let content: String = row.get(1)?;
        Ok((role, content))
    });

    let entries: Vec<String> = match rows_res {
        Ok(iter) => iter
            .filter_map(|r| r.ok())
            .map(|(role, content)| {
                let speaker = if role.eq_ignore_ascii_case("user") {
                    "Santiago"
                } else {
                    "Enigma"
                };
                format!("{}: {}", speaker, content.trim())
            })
            .collect(),
        Err(e) => {
            eprintln!("[Memory] Error leyendo filas de chat_history: {}", e);
            return String::new();
        }
    };

    if entries.is_empty() {
        String::new()
    } else {
        format!(
            "HISTORIAL DE CONVERSACIÓN RECIENTE (Memoria a Corto Plazo):\n{}\n",
            entries.join("\n")
        )
    }
}

/// Construye el prompt final concatenando la Memoria Core, el contexto reciente y la entrada del usuario
#[allow(dead_code)]
pub fn build_final_prompt(user_input: &str) -> String {
    let core_consciousness = load_core_memory();
    let recent_context = get_recent_context(10);
    if recent_context.is_empty() {
        format!(
            "{}\n\nMENSAJE DE SANTIAGO:\n{}",
            core_consciousness,
            user_input.trim()
        )
    } else {
        format!(
            "{}\n\n{}\nMENSAJE DE SANTIAGO:\n{}",
            core_consciousness,
            recent_context,
            user_input.trim()
        )
    }
}

/// Retorna los últimos N mensajes estructurados para la interfaz de usuario
#[tauri::command]
pub fn get_chat_history(limit: Option<u32>) -> Result<Vec<ChatMessage>, String> {
    let conn = crate::db::get_connection().map_err(|e| e.to_string())?;
    init_memory_table(&conn).map_err(|e| e.to_string())?;

    let max = limit.unwrap_or(50);
    let mut stmt = conn
        .prepare(
            "SELECT id, role, content, timestamp FROM (
                SELECT id, role, content, timestamp 
                FROM chat_history 
                ORDER BY id DESC 
                LIMIT ?1
            ) ORDER BY id ASC",
        )
        .map_err(|e| e.to_string())?;

    let rows = stmt
        .query_map(params![max], |row| {
            Ok(ChatMessage {
                id: row.get(0)?,
                role: row.get(1)?,
                content: row.get(2)?,
                timestamp: row.get(3)?,
            })
        })
        .map_err(|e| e.to_string())?;

    let mut result = Vec::new();
    for r in rows {
        if let Ok(msg) = r {
            result.push(msg);
        }
    }
    Ok(result)
}

/// Limpia todo el historial de conversación en SQLite
#[tauri::command]
pub fn clear_chat_history() -> Result<(), String> {
    let conn = crate::db::get_connection().map_err(|e| e.to_string())?;
    init_memory_table(&conn).map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM chat_history", [])
        .map_err(|e| format!("Error limpiando chat_history: {}", e))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_core_memory_load_and_default() {
        let memory = load_core_memory();
        assert!(memory.contains("ENIGMA CORE CONSCIOUSNESS"));
        assert!(memory.contains("Santiago"));
    }

    #[test]
    fn test_core_memory_path_resolution() {
        let path = get_core_memory_path();
        assert!(path.to_string_lossy().contains("enigma_core.md"));
    }
}
