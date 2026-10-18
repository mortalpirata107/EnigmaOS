//! OS Skills Module for Enigma
//!
//! Provides core operating system interaction skills for Enigma:
//! 1. `read_local_file`: Inspect and read any local text, code, or log file.
//! 2. `execute_terminal_command`: Execute safe bash commands with strict anti-destruction safeguards.

use std::path::PathBuf;

/// Lista de patrones peligrosos que están terminantemente prohibidos por las salvaguardas de Enigma
const DANGEROUS_COMMAND_PATTERNS: &[&str] = &[
    "rm -rf",
    "rm -fr",
    "rm -r /",
    "rm -r ~",
    "rm -r *",
    "rm --recursive",
    "mkfs",
    "dd if=",
    ":(){ :|:& };:",
    "> /dev/sd",
    "> /dev/nvme",
    "> /dev/vd",
    "> /dev/hd",
    ">/dev/sd",
    ">/dev/nvme",
    "chmod -r 777 /",
    "chmod -r 000 /",
    "chown -r",
    "shutdown",
    "poweroff",
    "reboot",
    "init 0",
    "fdisk",
    "parted",
    "wipefs",
    "truncate -s 0 /",
    "mv /* /dev/null",
];

/// Verifica si un comando de terminal contiene patrones destructivos
pub fn is_command_safe(command: &str) -> Result<(), String> {
    let lower = command.to_lowercase();
    for pattern in DANGEROUS_COMMAND_PATTERNS {
        if lower.contains(pattern) {
            return Err(format!(
                "⚠️ Comando bloqueado por salvaguardas de seguridad de Enigma: Se detectó el patrón potencialmente destructivo '{}'.",
                pattern
            ));
        }
    }

    Ok(())
}

/// Resuelve una ruta de archivo manejando esquemas `file://` y tilde de usuario `~`
pub fn resolve_local_path(raw_path: &str) -> PathBuf {
    let trimmed = raw_path.trim();
    let without_scheme = trimmed.strip_prefix("file://").unwrap_or(trimmed);

    if without_scheme.starts_with("~/") {
        if let Some(home) = std::env::var_os("HOME") {
            let mut p = PathBuf::from(home);
            p.push(&without_scheme[2..]);
            return p;
        }
    } else if without_scheme == "~" {
        if let Some(home) = std::env::var_os("HOME") {
            return PathBuf::from(home);
        }
    }

    PathBuf::from(without_scheme)
}

/// Lee el contenido de cualquier archivo de texto, código, configuración o log del ordenador.
/// Si la ruta es un directorio, devuelve el listado de sus elementos.
#[tauri::command]
pub fn read_local_file(path: &str) -> Result<String, String> {
    let resolved = resolve_local_path(path);
    if !resolved.exists() {
        return Err(format!("El archivo no existe en la ruta: '{}'", resolved.display()));
    }

    if resolved.is_dir() {
        // Si el usuario pasó un directorio, listar su contenido para ayudar a la IA
        let mut entries = Vec::new();
        let read_dir = std::fs::read_dir(&resolved)
            .map_err(|e| format!("Error leyendo el directorio '{}': {}", resolved.display(), e))?;

        for entry in read_dir.flatten() {
            let file_name = entry.file_name().to_string_lossy().to_string();
            let file_type = if entry.path().is_dir() { "📁 [DIR]" } else { "📄 [FILE]" };
            entries.push(format!("{} {}", file_type, file_name));
        }
        entries.sort();

        return Ok(format!(
            "La ruta '{}' es un directorio con {} elemento(s):\n{}",
            resolved.display(),
            entries.len(),
            entries.join("\n")
        ));
    }

    // Leer bytes del archivo
    let bytes = std::fs::read(&resolved)
        .map_err(|e| format!("Error al leer el archivo '{}': {}", resolved.display(), e))?;

    if bytes.is_empty() {
        return Ok(format!("(El archivo '{}' está vacío)", resolved.display()));
    }

    // Convertir de forma tolerante a UTF-8
    let content = String::from_utf8_lossy(&bytes).to_string();

    // Limitar longitud para no desbordar la ventana de contexto del LLM (máximo 250 KB)
    const MAX_CHARS: usize = 250_000;
    if content.chars().count() > MAX_CHARS {
        let truncated: String = content.chars().take(MAX_CHARS).collect();
        Ok(format!(
            "{}\n\n... [Aviso: Contenido truncado en los primeros {} caracteres por límite de contexto]",
            truncated, MAX_CHARS
        ))
    } else {
        Ok(content)
    }
}

/// Ejecuta comandos seguros de bash usando `std::process::Command` y devuelve stdout o stderr.
/// Aplica salvaguardas estrictas para impedir acciones destructivas en el sistema de Santiago.
#[tauri::command]
pub fn execute_terminal_command(command: &str) -> Result<String, String> {
    let trimmed = command.trim();
    if trimmed.is_empty() {
        return Err("El comando de terminal no puede estar vacío.".to_string());
    }

    // 1. Validar contra salvaguardas de seguridad
    is_command_safe(trimmed)?;

    eprintln!("[OS_Skills] 💻 Ejecutando comando seguro: '{}'", trimmed);

    // 2. Ejecutar comando mediante bash
    let output = std::process::Command::new("bash")
        .args(["-c", trimmed])
        .output()
        .map_err(|e| format!("Error ejecutando comando en bash: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();

    if output.status.success() {
        if !stdout.is_empty() && !stderr.is_empty() {
            Ok(format!("{}\n\n[stderr]:\n{}", stdout, stderr))
        } else if !stdout.is_empty() {
            Ok(stdout)
        } else if !stderr.is_empty() {
            Ok(format!("[Aviso stderr]: {}", stderr))
        } else {
            Ok("> ⚙️ Comando ejecutado con éxito sin salida en consola.".to_string())
        }
    } else {
        let exit_code = output.status.code().unwrap_or(-1);
        if !stderr.is_empty() {
            Err(format!("Error (código {}):\n{}", exit_code, stderr))
        } else if !stdout.is_empty() {
            Err(format!("Falló (código {}):\n{}", exit_code, stdout))
        } else {
            Err(format!("El comando finalizó con código de error {}", exit_code))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_guardrails_blocks_dangerous_commands() {
        assert!(is_command_safe("rm -rf /").is_err());
        assert!(is_command_safe("sudo rm -rf /home/user").is_err());
        assert!(is_command_safe("mkfs.ext4 /dev/sda1").is_err());
        assert!(is_command_safe("dd if=/dev/zero of=/dev/sda").is_err());
        assert!(is_command_safe("echo ':(){ :|:& };:'").is_err());
        assert!(is_command_safe("chmod -R 777 /").is_err());
        assert!(is_command_safe("shutdown -h now").is_err());
        assert!(is_command_safe("reboot").is_err());
    }

    #[test]
    fn test_guardrails_allows_safe_commands() {
        assert!(is_command_safe("echo 'hello enigma'").is_ok());
        assert!(is_command_safe("ls -la /tmp").is_ok());
        assert!(is_command_safe("git status").is_ok());
        assert!(is_command_safe("cargo test").is_ok());
        assert!(is_command_safe("cat Cargo.toml").is_ok());
    }

    #[test]
    fn test_execute_safe_command() {
        let out = execute_terminal_command("echo 'test_enigma_os_skills'").unwrap();
        assert_eq!(out, "test_enigma_os_skills");
    }

    #[test]
    fn test_read_local_file_success() {
        let res = read_local_file("Cargo.toml");
        assert!(res.is_ok());
        assert!(res.unwrap().contains("[package]"));
    }

    #[test]
    fn test_read_local_file_not_found() {
        let res = read_local_file("archivo_inexistente_123456.xyz");
        assert!(res.is_err());
    }
}
