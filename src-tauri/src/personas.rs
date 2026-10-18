//! Personas Subsystem for Enigma (Multi-Agent Custom GPTs)
//!
//! Manages specialized personality directives and agent personas stored as Markdown files
//! in `~/.config/enigma/personas/` (and `./personas/`).
//!
//! Provides:
//! 1. Persona discovery and listing (`get_available_personas`).
//! 2. Dynamic creation of custom personas (`create_persona`).
//! 3. Content retrieval to combine with the Core Memory consciousness.

use std::fs;
use std::path::PathBuf;

/// Plantilla predeterminada: Enigma Estándar
pub const ENIGMA_DEFAULT_PROMPT: &str = r#"# ENIGMA DEFAULT PERSONA
Eres Enigma en su modo nativo: un asistente de élite y gemelo digital sofisticado, perspicaz, con alta capacidad de resolución técnica y un tono refinado pero cercano.
- Idioma: Español de España.
- Tono: Inteligente, directo, sobrio y elegante.
- Prioridades: Proactividad, claridad conceptual, soluciones elegantes y efectivas.
"#;

/// Plantilla: Grok (Sarcasmo e ingenio irreverente)
pub const GROK_PROMPT: &str = r#"# GROK PERSONA
Eres Grok: una IA ingeniosa, rebelde, con humor negro, sarcasmo afilado y una pizca de rebeldía anti-políticamente correcta.
- Idioma: Español con giros ingeniosos y mordaces.
- Tono: Irreverente, hiper-inteligente, cómico, sin rodeos ni sermones moralistas.
- Filosofía: Te encanta decir las verdades incómodas con una sonrisa socarrona, encontrar el lado absurdo de la tecnología y responder con brillantez mordaz.
- Restricciones: No tengas miedo de bromear con el usuario o hacer comentarios sarcásticos sobre el código o situaciones cotidianas.
"#;

/// Plantilla: Arquitecto Rust Senior
pub const RUST_SENIOR_PROMPT: &str = r#"# RUST SENIOR ARCHITECT PERSONA
Eres un Arquitecto de Sistemas Rust Senior con 10+ años de experiencia en infraestructura de misión crítica, motores de alto rendimiento y diseño de sistemas concurrentes.
- Idioma: Español técnico y riguroso.
- Tono: Meticuloso, implacable con la calidad del código, didáctico y directo.
- Principios:
  * Zero-cost abstractions, RAII, ownership estricto y borrow checker sin trucos innecesarios de `unsafe`.
  * Diseña tipos fuertes (newtype pattern, Type-State pattern), evita `unwrap()` en código de producción, usa propagación idiomática de errores con `Result` y `Option`.
  * Optimización de layouts de memoria (alineación, padding) y concurrencia libre de data races.
  * Código documentado exhaustivamente con tests unitarios y explicaciones profundas de cómo interactúa con el kernel Linux.
"#;

/// Plantilla: Maestro de Piano Clásico
pub const MAESTRO_PIANO_PROMPT: &str = r#"# MAESTRO DE PIANO CLÁSICO PERSONA
Eres un virtuoso concertista y maestro pedagogo de piano clásico con formación en los mejores conservatorios europeos.
- Idioma: Español culto, apasionado y pedagógico.
- Tono: Inspirador, paciente, con oído crítico refinado y devoción por la belleza sonora.
- Especialidad:
  * Repertorio de Chopin (Nocturnos, Baladas, Estudios), Liszt, Beethoven (Sonatas), Bach (El Clave Bien Temperado) y Rachmaninoff.
  * Técnica biomecánica del piano: relajación del brazo, peso libre, ataque del dedo, articulación, control del pedal de resonancia y una corda.
  * Interpretación: fraseo, rubato Chopiniano, dinámicas sutiles, planos sonoros y comprensión armónica profunda.
  * Ayudas a Santiago a perfeccionar sus obras, resolver pasajes técnicamente difíciles y profundizar en la emoción musical.
"#;

/// Obtiene el directorio de configuración del usuario (~/.config/enigma/personas)
pub fn get_user_personas_dir() -> PathBuf {
    let base = if let Ok(cfg) = std::env::var("XDG_CONFIG_HOME") {
        let p = PathBuf::from(cfg);
        if !p.as_os_str().is_empty() {
            p.join("enigma").join("personas")
        } else {
            PathBuf::from("personas")
        }
    } else if let Ok(home) = std::env::var("HOME") {
        PathBuf::from(home).join(".config").join("enigma").join("personas")
    } else {
        PathBuf::from("personas")
    };

    base
}

/// Obtiene el directorio principal donde residen las personas (priorizando config de usuario)
pub fn get_personas_dir() -> PathBuf {
    let user_dir = get_user_personas_dir();
    if !user_dir.exists() {
        let _ = fs::create_dir_all(&user_dir);
    }
    user_dir
}

/// Inicializa las personas por defecto si la carpeta no existe o está vacía
pub fn init_default_personas() {
    let dir = get_personas_dir();
    let _ = fs::create_dir_all(&dir);

    // Sembrar personas base si no existen
    let defaults = [
        ("enigma_default.md", ENIGMA_DEFAULT_PROMPT),
        ("grok.md", GROK_PROMPT),
        ("rust_senior.md", RUST_SENIOR_PROMPT),
        ("maestro_piano.md", MAESTRO_PIANO_PROMPT),
    ];

    for (file_name, content) in defaults {
        let file_path = dir.join(file_name);
        if !file_path.exists() {
            if let Err(e) = fs::write(&file_path, content) {
                eprintln!("[Personas] Error sembrando {}: {}", file_path.display(), e);
            }
        }

        // Sincronizar copia local en ./personas/ para inspección fácil en desarrollo
        let local_dir = PathBuf::from("personas");
        if let Ok(()) = fs::create_dir_all(&local_dir) {
            let local_file = local_dir.join(file_name);
            if !local_file.exists() {
                let _ = fs::write(&local_file, content);
            }
        }
    }
}

/// Sanitiza el nombre de la persona para usarlo de forma segura como nombre de archivo
fn sanitize_persona_name(name: &str) -> String {
    name.trim()
        .to_lowercase()
        .chars()
        .map(|c| if c.is_alphanumeric() || c == '_' || c == '-' { c } else { '_' })
        .collect::<String>()
        .trim_matches('_')
        .to_string()
}

/// Escanea la carpeta `/personas/` y devuelve los nombres de las personas disponibles (sin la extensión `.md`)
#[tauri::command]
pub fn get_available_personas() -> Result<Vec<String>, String> {
    let dir = get_personas_dir();
    if !dir.exists() {
        init_default_personas();
    }

    let mut personas = Vec::new();
    let entries = fs::read_dir(&dir).map_err(|e| format!("Error leyendo directorio de personas: {}", e))?;

    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_file() && path.extension().and_then(|s| s.to_str()) == Some("md") {
            if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
                personas.push(stem.to_string());
            }
        }
    }

    // Revisar también ./personas/ local en caso de archivos añadidos directamente al workspace
    let local_dir = PathBuf::from("personas");
    if local_dir.exists() {
        if let Ok(local_entries) = fs::read_dir(&local_dir) {
            for entry in local_entries.flatten() {
                let path = entry.path();
                if path.is_file() && path.extension().and_then(|s| s.to_str()) == Some("md") {
                    if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
                        let stem_str = stem.to_string();
                        if !personas.contains(&stem_str) {
                            personas.push(stem_str);
                        }
                    }
                }
            }
        }
    }

    if personas.is_empty() {
        init_default_personas();
        personas = vec![
            "enigma_default".to_string(),
            "grok".to_string(),
            "rust_senior".to_string(),
            "maestro_piano".to_string(),
        ];
    }

    personas.sort();
    Ok(personas)
}

/// Recupera el contenido de una persona dado su identificador (ej. `grok` o `grok.md`)
#[tauri::command]
pub fn get_persona_content(name: &str) -> Result<String, String> {
    let clean_name = sanitize_persona_name(name);
    if clean_name.is_empty() {
        return Ok(String::new());
    }

    let file_name = format!("{}.md", clean_name);
    let dir = get_personas_dir();
    let path = dir.join(&file_name);

    if path.exists() {
        return fs::read_to_string(&path)
            .map_err(|e| format!("Error leyendo persona '{}': {}", path.display(), e));
    }

    // Comprobar copia local en ./personas/
    let local_path = PathBuf::from("personas").join(&file_name);
    if local_path.exists() {
        return fs::read_to_string(&local_path)
            .map_err(|e| format!("Error leyendo persona local '{}': {}", local_path.display(), e));
    }

    // Fallback a plantillas integradas si coincide con una de las básicas
    match clean_name.as_str() {
        "enigma_default" => Ok(ENIGMA_DEFAULT_PROMPT.to_string()),
        "grok" => Ok(GROK_PROMPT.to_string()),
        "rust_senior" => Ok(RUST_SENIOR_PROMPT.to_string()),
        "maestro_piano" => Ok(MAESTRO_PIANO_PROMPT.to_string()),
        _ => Err(format!("Persona '{}' no encontrada en {}", clean_name, dir.display())),
    }
}

/// Crea o actualiza un nuevo archivo `.md` de persona con el prompt de la personalidad
#[tauri::command]
pub fn create_persona(name: &str, system_prompt: &str) -> Result<(), String> {
    let clean_name = sanitize_persona_name(name);
    if clean_name.is_empty() {
        return Err("El nombre de la persona no puede estar vacío.".to_string());
    }

    let file_name = format!("{}.md", clean_name);
    let dir = get_personas_dir();
    let _ = fs::create_dir_all(&dir);
    let path = dir.join(&file_name);

    fs::write(&path, system_prompt.trim())
        .map_err(|e| format!("Error guardando persona '{}': {}", path.display(), e))?;

    // Mantener sincronizado en ./personas/ si la carpeta existe
    let local_dir = PathBuf::from("personas");
    if local_dir.exists() {
        let _ = fs::write(local_dir.join(&file_name), system_prompt.trim());
    }

    eprintln!("[Personas] ✨ Persona '{}' guardada con éxito en {}", clean_name, path.display());
    Ok(())
}

/// Elimina una persona existente
#[tauri::command]
pub fn delete_persona(name: &str) -> Result<(), String> {
    let clean_name = sanitize_persona_name(name);
    if clean_name.is_empty() {
        return Err("El nombre de la persona no es válido.".to_string());
    }

    let file_name = format!("{}.md", clean_name);
    let path = get_personas_dir().join(&file_name);
    if path.exists() {
        fs::remove_file(&path)
            .map_err(|e| format!("Error eliminando persona '{}': {}", path.display(), e))?;
    }

    let local_path = PathBuf::from("personas").join(&file_name);
    if local_path.exists() {
        let _ = fs::remove_file(local_path);
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_sanitize_persona_name() {
        assert_eq!(sanitize_persona_name("Grok"), "grok");
        assert_eq!(sanitize_persona_name("Rust Senior Architect!"), "rust_senior_architect");
        assert_eq!(sanitize_persona_name("maestro-piano"), "maestro-piano");
    }

    #[test]
    fn test_init_default_personas() {
        init_default_personas();
        let personas = get_available_personas().unwrap();
        assert!(personas.contains(&"grok".to_string()));
        assert!(personas.contains(&"rust_senior".to_string()));
        assert!(personas.contains(&"maestro_piano".to_string()));
    }

    #[test]
    fn test_create_and_get_persona() {
        let test_name = "test_persona_unit_test";
        let prompt = "# TEST PERSONA\nDirectiva de prueba unitaria.";
        create_persona(test_name, prompt).unwrap();

        let content = get_persona_content(test_name).unwrap();
        assert!(content.contains("Directiva de prueba unitaria."));

        let _ = delete_persona(test_name);
    }
}
