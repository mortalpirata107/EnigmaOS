//! Dynamic Multi-Agent Router for Enigma & Ollama
//!
//! Intelligently classifies user intentions using `gemma4:e4b` and dynamically routes
//! requests to specialized local models:
//! - SYSTEM: `hermes3` (OS & system_control tools, bash terminal, apps)
//! - CODE: `codegemma` (Programming, refactoring, debugging, architectures)
//! - REASONING: `gemma4:31b` (Deep analytical reasoning, logic, philosophy)
//! - GENERAL: `llama3.1` / `gemma4:e4b` (Casual chat, daily queries)

use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter};

pub const OLLAMA_API_BASE: &str = "http://localhost:11434";

// Specialized Local Model Defaults (Fallback constants)
#[allow(dead_code)]
pub const ORCHESTRATOR_MODEL: &str = "llama3.2:3b";
#[allow(dead_code)]
pub const SYSTEM_MODEL: &str = "hermes3:8b";
#[allow(dead_code)]
pub const CODE_MODEL: &str = "qwen2.5-coder:7b";
#[allow(dead_code)]
pub const REASONING_MODEL: &str = "deepseek-r1:8b";
#[allow(dead_code)]
pub const GENERAL_MODEL: &str = "llama3.2:3b";

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum IntentCategory {
    SYSTEM,
    CODE,
    REASONING,
    GENERAL,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentRoute {
    pub category: IntentCategory,
    pub target_model: String,
    pub description: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_calls: Option<Vec<ToolCallItem>>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ChatRequest {
    pub model: String,
    pub messages: Vec<ChatMessage>,
    pub stream: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub format: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub options: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tools: Option<Value>,
}

#[derive(Debug, Clone, Deserialize)]
#[allow(dead_code)]
pub struct ChatResponse {
    pub model: String,
    pub message: ChatResponseMessage,
    #[serde(default)]
    pub done: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[allow(dead_code)]
pub struct ChatResponseMessage {
    pub role: String,
    pub content: String,
    #[serde(default)]
    pub thinking: Option<String>,
    #[serde(default)]
    pub tool_calls: Option<Vec<ToolCallItem>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolCallItem {
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub function: Option<ToolCallFunction>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolCallFunction {
    pub name: String,
    pub arguments: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EnigmaResponse {
    pub content: String,
    pub model_used: String,
    pub category: String,
    pub route: AgentRoute,
    pub tool_executed: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EnigmaStatusPayload {
    pub phase: u8,
    pub status: String,
    pub model: Option<String>,
}

fn try_parse_function_call_from_content(raw: &str) -> Option<(String, Value)> {
    let trimmed = raw.trim();
    if !trimmed.contains('{') && !trimmed.contains("```") && !trimmed.contains("<tool_call>") {
        return None;
    }

    // 1. Limpiar etiquetas XML o fences de código si las hay
    let un_tagged = trimmed
        .replace("<tool_call>", "")
        .replace("</tool_call>", "");
    let candidate = un_tagged.trim();

    // 2. Extraer el segmento JSON delimitado por llaves { ... }
    let slice = if let (Some(start), Some(end)) = (candidate.find('{'), candidate.rfind('}')) {
        if start < end {
            &candidate[start..=end]
        } else {
            candidate
        }
    } else {
        candidate
    };

    if let Ok(v) = serde_json::from_str::<Value>(slice) {
        // Manejar posibles arrays de llamadas: [{"name": "open_app", ...}]
        let item = if let Some(arr) = v.as_array() {
            arr.first().cloned().unwrap_or(Value::Null)
        } else {
            v.clone()
        };

        if item.is_object() {
            let name = item.get("name").and_then(|n| n.as_str())
                .or_else(|| {
                    item.get("function").and_then(|f| {
                        if let Some(s) = f.as_str() {
                            Some(s)
                        } else {
                            f.get("name").and_then(|n| n.as_str())
                        }
                    })
                })
                .or_else(|| item.get("action").and_then(|a| a.as_str()))
                .or_else(|| item.get("tool").and_then(|t| t.as_str()))
                .map(|s| s.to_string());

            let raw_args = item.get("parameters")
                .or_else(|| item.get("arguments"))
                .or_else(|| item.get("args"))
                .or_else(|| {
                    item.get("function").and_then(|f| {
                        f.get("parameters").or_else(|| f.get("arguments")).or_else(|| f.get("args"))
                    })
                })
                .cloned();

            // Si los argumentos vienen serializados como cadena escapada (ej: "{\"app_name\": \"spotify\"}")
            let mut args = match raw_args {
                Some(Value::String(s)) => {
                    serde_json::from_str::<Value>(&s).unwrap_or(Value::Object(serde_json::Map::new()))
                }
                Some(val @ Value::Object(_)) => val,
                _ => Value::Object(serde_json::Map::new()),
            };

            // Si los parámetros vienen en la raíz del objeto: ej: {"name": "open_app", "app_name": "spotify"}
            if args.as_object().map(|m| m.is_empty()).unwrap_or(true) {
                if let Some(map) = item.as_object() {
                    let mut clean_map = map.clone();
                    clean_map.remove("name");
                    clean_map.remove("type");
                    clean_map.remove("function");
                    clean_map.remove("action");
                    clean_map.remove("tool");
                    clean_map.remove("arguments");
                    clean_map.remove("parameters");
                    if !clean_map.is_empty() {
                        args = Value::Object(clean_map);
                    }
                }
            }

            if let Some(name_str) = name {
                return Some((name_str, args));
            }

            // Inferencia si faltaba la clave 'name' pero están presentes los argumentos clave
            if let Some(obj) = args.as_object() {
                if obj.contains_key("app_name") || obj.contains_key("app") {
                    return Some(("open_app".to_string(), args));
                } else if obj.contains_key("command") || obj.contains_key("cmd") {
                    return Some(("run_terminal".to_string(), args));
                } else if obj.contains_key("contact_name") {
                    return Some(("send_whatsapp".to_string(), args));
                }
            }
        }
    }

    // Tolerancia para JSONs truncados por LLM
    for pattern in &["\"name\":\"", "\"name\": \"", "\"action\":\"", "\"action\": \""] {
        if let Some(idx) = trimmed.find(pattern) {
            let after = &trimmed[idx + pattern.len()..];
            if let Some(end_quote) = after.find('"') {
                let func_name = after[..end_quote].to_string();
                return Some((func_name, Value::Object(serde_json::Map::new())));
            }
        }
    }

    None
}

/// Elimina por completo cualquier etiqueta y bloque de pensamiento interno <think>...</think> o <thought>...</thought> (DeepSeek-R1)
pub fn strip_thinking_tags(raw: &str) -> String {
    let mut text = raw.to_string();
    while let Some(start) = text.find("<think>") {
        if let Some(end) = text[start..].find("</think>") {
            text.replace_range(start..start + end + "</think>".len(), "");
        } else {
            text.truncate(start);
            break;
        }
    }
    while let Some(start) = text.find("<thought>") {
        if let Some(end) = text[start..].find("</thought>") {
            text.replace_range(start..start + end + "</thought>".len(), "");
        } else {
            text.truncate(start);
            break;
        }
    }
    text.trim().to_string()
}

/// Elimina bloques de código JSON o etiquetas <tool_call> del texto del asistente
/// para evitar que el JSON crudo de las herramientas se filtre a la interfaz de usuario.
fn sanitize_response_text(input: &str) -> String {
    let un_thought = strip_thinking_tags(input);
    let mut text = un_thought.trim().to_string();

    // 1. Eliminar etiquetas <tool_call>...</tool_call>
    while let Some(start) = text.find("<tool_call>") {
        if let Some(end) = text.find("</tool_call>") {
            text.replace_range(start..end + "</tool_call>".len(), "");
        } else {
            text.truncate(start);
            break;
        }
    }

    // 2. Filtrar bloques markdown ```json ... ``` que contengan llamadas a herramientas
    let mut sanitized_lines = Vec::new();
    let mut in_code_block = false;
    let mut code_block_buf = Vec::new();

    for line in text.lines() {
        let trimmed_line = line.trim();
        if trimmed_line.starts_with("```") {
            if in_code_block {
                in_code_block = false;
                let block_content = code_block_buf.join("\n");
                if !block_content.contains("\"name\"")
                    && !block_content.contains("\"arguments\"")
                    && !block_content.contains("\"parameters\"")
                    && !block_content.contains("\"action\"")
                {
                    sanitized_lines.push(format!("```\n{}\n```", block_content));
                }
                code_block_buf.clear();
            } else {
                in_code_block = true;
                code_block_buf.clear();
            }
            continue;
        }

        if in_code_block {
            code_block_buf.push(line);
        } else {
            // Omitir líneas que sean JSON directo de llamada a función
            if (trimmed_line.starts_with('{') || trimmed_line.starts_with('}'))
                && (trimmed_line.contains("\"name\"") || trimmed_line.contains("\"arguments\"") || trimmed_line.contains("\"parameters\""))
            {
                continue;
            }
            sanitized_lines.push(line.to_string());
        }
    }

    let result = sanitized_lines.join("\n").trim().to_string();

    // Si el texto restante es únicamente un objeto JSON suelto, suprimirlo por completo
    if result.starts_with('{') && result.ends_with('}') && (result.contains("\"name\"") || result.contains("\"arguments\"")) {
        return String::new();
    }

    result
}

/// Tools schema definition for `hermes3` system execution
fn get_system_tools_schema() -> Value {
    serde_json::json!([
        {
            "type": "function",
            "function": {
                "name": "add_event",
                "description": "Crea y programa un nuevo evento, cita o recordatorio en el calendario. OBLIGATORIO cuando el usuario pida añadir, agendar, crear o poner una cita, reunión o evento.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "title": { "type": "string", "description": "Título o motivo de la cita/evento (ej: 'Cita a las 7:30', 'Dentista')" },
                        "date": { "type": "string", "description": "Fecha del evento en formato YYYY-MM-DD" },
                        "time": { "type": "string", "description": "Hora del evento en formato HH:MM (ej: '07:30', '19:30')" },
                        "notify_before": { "type": "integer", "description": "Minutos de antelación para notificar (por defecto 15)" }
                    },
                    "required": ["title", "date", "time"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "get_calendar_events",
                "description": "Consulta y lee los eventos o citas programados en el calendario. OBLIGATORIO para ver o consultar la agenda.",
                "parameters": {
                    "type": "object",
                    "properties": {}
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "add_task",
                "description": "Añade una nueva tarea o pendiente a la lista de tareas de Enigma.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "title": { "type": "string", "description": "Descripción de la tarea a realizar" }
                    },
                    "required": ["title"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "get_tasks",
                "description": "Consulta la lista de tareas y pendientes guardados.",
                "parameters": {
                    "type": "object",
                    "properties": {}
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "type_text",
                "description": "Escribe texto simulando el teclado físico en la ventana activa actual.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "text": { "type": "string", "description": "Texto exacto a escribir" }
                    },
                    "required": ["text"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "press_key",
                "description": "Pulsa una tecla especial en el sistema (ej: 'Return', 'Enter', 'Tab', 'Escape', 'Super', 'Space').",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "key": { "type": "string", "description": "Nombre de la tecla a pulsar" }
                    },
                    "required": ["key"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "send_whatsapp",
                "description": "Envía un mensaje de texto de WhatsApp a un contacto por su nombre (ej: 'papi', 'Papiii', 'mamá', 'Carlos') o número. UTILIZAR OBLIGATORIAMENTE siempre que el usuario pida enviar, mandar o escribir un mensaje por WhatsApp.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "contact_name": { "type": "string", "description": "Nombre del contacto (ej: 'papi', 'Papiii') o número" },
                        "message": { "type": "string", "description": "Texto del mensaje que se va a enviar" }
                    },
                    "required": ["contact_name", "message"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "read_emails",
                "description": "Consulta y lee los correos electrónicos más recientes de la bandeja de entrada de Gmail mediante la API de Google Workspace. UTILIZAR OBLIGATORIAMENTE cuando el usuario pida leer, consultar, revisar o ver sus correos electrónicos o emails.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "max_results": { "type": "integer", "description": "Número máximo de correos a recuperar (por defecto 5)" }
                    }
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "open_url",
                "description": "Abre una URL o sitio web en el navegador Opera (ej: https://www.youtube.com, https://github.com). OBLIGATORIO para entrar o navegar a un sitio web.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "url": { "type": "string", "description": "URL completa del sitio web comenzando con https:// (ej: https://www.youtube.com)" }
                    },
                    "required": ["url"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "run_terminal",
                "description": "Ejecuta un comando en la terminal bash de Linux y devuelve stdout/stderr (NO USAR para leer correos ni WhatsApp)",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "command": { "type": "string", "description": "Comando de bash a ejecutar" }
                    },
                    "required": ["command"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "open_app",
                "description": "Abre o lanza una aplicación ejecutable local instalada en el sistema (ej: spotify, discord, opera, kitty, dolphin). NO USAR para sitios web ni servicios online como YouTube o Gmail.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "app_name": { "type": "string", "description": "Nombre de la aplicación local instalada a abrir" }
                    },
                    "required": ["app_name"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "close_app",
                "description": "Cierra o finaliza los procesos de una aplicación activa por su nombre",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "app_name": { "type": "string", "description": "Nombre de la aplicación a cerrar" }
                    },
                    "required": ["app_name"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "search_web",
                "description": "Abre el navegador web predeterminado (Opera) y busca en Google",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "query": { "type": "string", "description": "Término o pregunta a buscar" }
                    },
                    "required": ["query"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "move_mouse",
                "description": "Mueve el cursor del ratón a coordenadas absolutas (x, y) de la pantalla",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "x": { "type": "integer", "description": "Coordenada X en píxeles" },
                        "y": { "type": "integer", "description": "Coordenada Y en píxeles" }
                    },
                    "required": ["x", "y"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "mouse_click",
                "description": "Realiza un clic con el botón del ratón ('left', 'right' o 'middle')",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "button": { "type": "string", "description": "Botón del ratón a pulsar ('left', 'right' o 'middle')" }
                    }
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "analyze_image",
                "description": "Analiza y comprende visualmente una imagen local mediante Ollama (llava) respondiendo a una pregunta o consulta visual.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "image_path": { "type": "string", "description": "Ruta absoluta o relativa del archivo de imagen" },
                        "prompt": { "type": "string", "description": "Pregunta o instrucción sobre la imagen" }
                    },
                    "required": ["image_path", "prompt"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "send_telegram_alert",
                "description": "Envía una notificación o alerta proactiva directamente al móvil del usuario a través del bot privado de Telegram de Enigma. OBLIGATORIO si el usuario pide avisarle al móvil, enviarle un mensaje por Telegram o notificarle remotamente.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "message": { "type": "string", "description": "Texto del mensaje o alerta a enviar por Telegram" }
                    },
                    "required": ["message"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "add_category",
                "description": "Crea una nueva subcategoría o carpeta dinámica para organizar tareas, horarios o calendario. OBLIGATORIO cuando el usuario pida en el chat 'Crea una carpeta de tareas llamada Urgente' o similar.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "name": { 
                            "type": "string", 
                            "description": "Nombre de la carpeta o subcategoría (ej: 'Urgente', 'Personal', 'Trabajo')" 
                        },
                        "module_type": { 
                            "type": "string", 
                            "description": "Módulo de Enigma al que se asigna la categoría: 'tasks' para tareas, 'schedules' para horarios, o 'calendars' para calendario",
                            "enum": ["tasks", "schedules", "calendars"]
                        }
                    },
                    "required": ["name", "module_type"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "add_note",
                "description": "Crea y guarda una nueva nota rápida personal en Enigma.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "title": { "type": "string", "description": "Título o asunto de la nota rápida" },
                        "content": { "type": "string", "description": "Contenido detallado de la nota" }
                    },
                    "required": ["title", "content"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "add_schedule",
                "description": "Crea y guarda un nuevo bloque horario o rutina en la tabla 'schedules' de SQLite. OBLIGATORIO cuando el usuario pida añadir una rutina, bloque de tiempo o bloque horario.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "day_of_week": { 
                            "type": "string", 
                            "description": "Día de la semana en español ('lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado', 'domingo' o 'diario')",
                            "enum": ["lunes", "martes", "miércoles", "jueves", "viernes", "sábado", "domingo", "diario"]
                        },
                        "block_name": { "type": "string", "description": "Nombre de la rutina o bloque (ej: 'Estudio de Rust', 'Gimnasio')" },
                        "start_time": { "type": "string", "description": "Hora de inicio en formato HH:MM (ej: '14:00', '09:30')" },
                        "end_time": { "type": "string", "description": "Hora de fin en formato HH:MM (ej: '16:00', '11:00')" }
                    },
                    "required": ["day_of_week", "block_name", "start_time", "end_time"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "get_schedules",
                "description": "Consulta la lista de bloques horarios y rutinas programadas en la base de datos SQLite.",
                "parameters": {
                    "type": "object",
                    "properties": {}
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "analyze_current_screen",
                "description": "Captura en tiempo real la pantalla o ventana activa del usuario (KDE Wayland) usando Spectacle y la analiza visualmente con IA multimodal (gemma4/llava). OBLIGATORIO si el usuario pide ver la pantalla, ventana activa, leer lo que está programando o ver errores en pantalla.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "prompt": {
                            "type": "string",
                            "description": "Pregunta o instrucción de análisis específica sobre la pantalla o ventana (ej: '¿Qué estoy programando?', '¿Qué error hay en mi código?', 'Describe la ventana activa')"
                        },
                        "target": {
                            "type": "string",
                            "enum": ["active_window", "screen"],
                            "description": "Objetivo de captura: 'active_window' para capturar la ventana en foco (IDE, terminal, navegador) o 'screen' para toda la pantalla."
                        }
                    },
                    "required": ["prompt"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "generate_image",
                "description": "Genera o dibuja una nueva imagen artística o visual localmente mediante la API de Stable Diffusion (txt2img). OBLIGATORIO cuando el usuario pida generar, crear, dibujar o pintar una imagen.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "prompt": {
                            "type": "string",
                            "description": "Descripción detallada del contenido visual de la imagen a generar (ej: 'cyberpunk hacker room with glowing holographic screens and neon atmosphere')"
                        }
                    },
                    "required": ["prompt"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "read_local_file",
                "description": "Lee el contenido de cualquier archivo de texto, código, configuración o log del ordenador para analizarlo. OBLIGATORIO para inspeccionar, revisar o analizar archivos locales del sistema.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": {
                            "type": "string",
                            "description": "Ruta absoluta o relativa del archivo a leer (ej: 'src/main.rs', '~/.bashrc', 'Cargo.toml', '/etc/hosts')"
                        }
                    },
                    "required": ["path"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "execute_terminal_command",
                "description": "Ejecuta comandos seguros de bash en el sistema operativo Linux y devuelve el stdout o stderr para automatizar tareas en el ordenador de Santiago. Cuenta con salvaguardas automáticas contra comandos destructivos.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "command": {
                            "type": "string",
                            "description": "Comando bash a ejecutar (ej: 'git status', 'cargo check', 'ls -la', 'ps aux | grep node', 'uname -a')"
                        }
                    },
                    "required": ["command"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "read_clipboard",
                "description": "Lee el contenido actual copiado en el portapapeles del sistema operativo Linux (KDE Klipper / Wayland). ÚSALO OBLIGATORIAMENTE cuando el usuario diga 'lo que tengo copiado', 'mi portapapeles', 'explícame este código', 'corrige el bug de lo que copié', 'resume lo que acabo de copiar', 'traduce mi portapapeles', etc.",
                "parameters": {
                    "type": "object",
                    "properties": {},
                    "required": []
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "copy_to_clipboard",
                "description": "Copia un texto, comando, script o respuesta generada directamente al portapapeles del sistema del usuario para que pueda pegarlo de inmediato en su editor o terminal.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "text": {
                            "type": "string",
                            "description": "El texto o código exacto a copiar en el portapapeles"
                        }
                    },
                    "required": ["text"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "get_active_context",
                "description": "Obtiene la ventana activa en foco de Santiago (título, aplicación, clase) y la lista de ventanas abiertas en su escritorio KDE Plasma 6 Wayland. Úsalo si el usuario pregunta '¿qué estoy haciendo?', '¿en qué ventana estoy?', 'ayúdame con esto', 'cuál es mi ventana activa', etc.",
                "parameters": {
                    "type": "object",
                    "properties": {},
                    "required": []
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "focus_window",
                "description": "Cambia de ventana, enfoca y trae al frente una aplicación específica abierta en el escritorio de Santiago (ej: 'Discord', 'Antigravity IDE', 'Spotify', 'Terminal', 'Opera').",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "app_name": {
                            "type": "string",
                            "description": "Nombre de la aplicación o título de la ventana a enfocar (ej: 'Discord', 'Spotify', 'Terminal', 'Antigravity')"
                        }
                    },
                    "required": ["app_name"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "get_media_status",
                "description": "Consulta qué canción, artista, álbum o medio multimedia se está reproduciendo actualmente en Linux a través de MPRIS DBus (Spotify, VLC, navegadores, etc.).",
                "parameters": {
                    "type": "object",
                    "properties": {}
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "control_media_player",
                "description": "Controla la reproducción multimedia en Linux vía MPRIS DBus: pausar, reanudar, siguiente pista, pista anterior o detener.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "action": {
                            "type": "string",
                            "description": "Acción a ejecutar: 'PlayPause', 'Play', 'Pause', 'Next', 'Previous', o 'Stop'",
                            "enum": ["PlayPause", "Play", "Pause", "Next", "Previous", "Stop"]
                        },
                        "player": {
                            "type": "string",
                            "description": "Nombre opcional del reproductor específico (ej: 'spotify', 'vlc', 'opera')"
                        }
                    },
                    "required": ["action"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "adjust_system_volume",
                "description": "Ajusta o consulta el volumen general del sistema de audio Linux (PulseAudio / PipeWire).",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "change": {
                            "type": "string",
                            "description": "Nivel o cambio de volumen (ej: '+5%', '-10%', '50%', 'mute', 'unmute', 'toggle_mute')"
                        }
                    },
                    "required": ["change"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "search_web_duckduckgo",
                "description": "Realiza una búsqueda web en tiempo real en internet usando DuckDuckGo para obtener noticias, hechos actuales, documentación o información fresca.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "query": {
                            "type": "string",
                            "description": "La consulta de búsqueda a buscar en la web"
                        }
                    },
                    "required": ["query"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "send_desktop_notification",
                "description": "Envía una notificación nativa al escritorio Linux usando notify-send.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "title": { "type": "string", "description": "Título de la notificación" },
                        "message": { "type": "string", "description": "Cuerpo del mensaje de la notificación" },
                        "urgency": {
                            "type": "string",
                            "enum": ["low", "normal", "critical"],
                            "description": "Nivel de urgencia"
                        }
                    },
                    "required": ["title", "message"]
                }
            }
        }
    ])
}

/// Parsea de forma tolerante la categoría desde la respuesta JSON del orquestador
fn parse_category_from_json(raw: &str) -> IntentCategory {
    // 1. Intento directo de deserialización JSON
    if let Ok(v) = serde_json::from_str::<Value>(raw) {
        if let Some(cat) = v.get("category").and_then(|c| c.as_str()) {
            match cat.trim().to_uppercase().as_str() {
                "SYSTEM" => return IntentCategory::SYSTEM,
                "CODE" => return IntentCategory::CODE,
                "REASONING" => return IntentCategory::REASONING,
                "GENERAL" => return IntentCategory::GENERAL,
                _ => {}
            }
        }
    }

    // 2. Búsqueda de bloque delimitado por llaves { ... }
    if let Some(start) = raw.find('{') {
        if let Some(end) = raw.rfind('}') {
            if start < end {
                let slice = &raw[start..=end];
                if let Ok(v) = serde_json::from_str::<Value>(slice) {
                    if let Some(cat) = v.get("category").and_then(|c| c.as_str()) {
                        match cat.trim().to_uppercase().as_str() {
                            "SYSTEM" => return IntentCategory::SYSTEM,
                            "CODE" => return IntentCategory::CODE,
                            "REASONING" => return IntentCategory::REASONING,
                            "GENERAL" => return IntentCategory::GENERAL,
                            _ => {}
                        }
                    }
                }
            }
        }
    }

    // 3. Heurística textual de respaldo si el JSON vino truncado
    let upper = raw.to_uppercase();
    if upper.contains("SYSTEM") {
        IntentCategory::SYSTEM
    } else if upper.contains("CODE") {
        IntentCategory::CODE
    } else if upper.contains("REASONING") {
        IntentCategory::REASONING
    } else {
        IntentCategory::GENERAL
    }
}

fn is_read_gmail_intent(prompt: &str) -> bool {
    let lower = prompt.to_lowercase();
    (lower.contains("correo") || lower.contains("correos") || lower.contains("email") || lower.contains("emails") || lower.contains("gmail") || lower.contains("bandeja") || lower.contains("inbox"))
        && !lower.contains("enviar") && !lower.contains("manda un correo") && !lower.contains("escribe un correo")
}

fn extract_whatsapp_intent_fallback(prompt: &str) -> Option<(String, String)> {
    let lower = prompt.trim();
    let separators = [" que diga ", " diciendo ", " con el texto ", ": "];
    let prefixes = [
        "mensaje a ",
        "whatsapp a ",
        "mándale a ",
        "mandale a ",
        "manda a ",
        "envíale a ",
        "enviale a ",
        "envía a ",
        "envia a ",
        "escríbele a ",
        "escribe a ",
        "dile a ",
    ];

    for sep in separators {
        if let Some(sep_idx) = lower.to_lowercase().find(sep) {
            let before = &lower[..sep_idx];
            let after = &lower[sep_idx + sep.len()..];
            for p in prefixes {
                if let Some(p_idx) = before.to_lowercase().find(p) {
                    let contact = before[p_idx + p.len()..].trim();
                    let msg = after.trim();
                    if !contact.is_empty() && !msg.is_empty() {
                        return Some((contact.to_string(), msg.to_string()));
                    }
                }
            }
        }
    }
    None
}

fn extract_telegram_intent_fallback(prompt: &str) -> Option<String> {
    let lower = prompt.trim();
    let lower_l = lower.to_lowercase();

    let prefixes = [
        "avísame al móvil que ",
        "avisame al movil que ",
        "avísame al móvil diciendo ",
        "avisame al movil diciendo ",
        "avísame al móvil: ",
        "avisame al movil: ",
        "avísame por telegram que ",
        "avisame por telegram que ",
        "avísame por telegram diciendo ",
        "avisame por telegram diciendo ",
        "avísame por telegram: ",
        "avisame por telegram: ",
        "notifícame al móvil que ",
        "notificame al movil que ",
        "notifícame al móvil diciendo ",
        "notificame al movil diciendo ",
        "notifícame al móvil: ",
        "notificame al movil: ",
        "notifícame por telegram que ",
        "notificame por telegram que ",
        "notifícame por telegram diciendo ",
        "notificame por telegram diciendo ",
        "notifícame por telegram: ",
        "notificame por telegram: ",
        "mándame un telegram que ",
        "mandame un telegram que ",
        "mándame un telegram diciendo ",
        "mandame un telegram diciendo ",
        "mándame un telegram: ",
        "mandame un telegram: ",
        "envíame un telegram que ",
        "enviame un telegram que ",
        "envíame un telegram diciendo ",
        "enviame un telegram diciendo ",
        "envíame un telegram: ",
        "enviame un telegram: ",
        "manda una alerta a telegram que ",
        "manda una alerta a telegram diciendo ",
        "manda una alerta a telegram: ",
        "envía una alerta a telegram que ",
        "envia una alerta a telegram que ",
        "envía una alerta a telegram: ",
        "envia una alerta a telegram: ",
        "manda un telegram que ",
        "envía un telegram que ",
        "envia un telegram que ",
    ];

    for prefix in prefixes {
        if let Some(idx) = lower_l.find(prefix) {
            let msg = lower[idx + prefix.len()..].trim();
            if !msg.is_empty() {
                return Some(msg.to_string());
            }
        }
    }

    let has_telegram_kw = lower_l.contains("telegram") || lower_l.contains("al móvil") || lower_l.contains("al movil");
    if has_telegram_kw {
        let triggers = ["alerta", "avísame", "avisame", "notifícame", "notificame", "manda", "envía", "envia", "recuérdame", "recuerdame"];
        if triggers.iter().any(|&t| lower_l.contains(t)) {
            let separators = [": ", " que diga ", " diciendo ", " con el texto ", " que "];
            for sep in separators {
                if let Some(sep_idx) = lower_l.find(sep) {
                    let msg = lower[sep_idx + sep.len()..].trim();
                    if !msg.is_empty() && msg.len() > 2 {
                        return Some(msg.to_string());
                    }
                }
            }
        }
    }

    None
}

fn extract_window_focus_intent_fallback(input: &str) -> Option<String> {
    let lower = input.to_lowercase();
    let prefixes = [
        "pásame a la ventana de ",
        "pasame a la ventana de ",
        "pásame a la ventana ",
        "pasame a la ventana ",
        "pásame a ",
        "pasame a ",
        "pásame al ",
        "pasame al ",
        "cambia a la ventana de ",
        "cambia a la ventana ",
        "cambia al ",
        "cambia a ",
        "enfoca la ventana de ",
        "enfoca la ventana ",
        "enfoca el ",
        "enfoca la ",
        "enfoca a ",
        "enfoca ",
        "ponme a ",
        "ponme el ",
        "ponme la ",
        "ponme ",
        "trae a la pantalla ",
        "trae al frente ",
        "abre la ventana de ",
        "abre la ventana ",
    ];

    for prefix in prefixes {
        if let Some(pos) = lower.find(prefix) {
            let target = input[pos + prefix.len()..].trim().trim_end_matches('.').trim();
            if !target.is_empty()
                && target.len() < 40
                && !target.starts_with("un ")
                && !target.starts_with("una ")
                && !target.starts_with("el navegador")
                && !target.starts_with("mi navegador")
            {
                return Some(target.to_string());
            }
        }
    }
    None
}

fn extract_time_from_text(text: &str) -> Option<String> {
    let lower = text.to_lowercase();
    let words: Vec<&str> = lower.split_whitespace().collect();

    for (i, w) in words.iter().enumerate() {
        let clean = w.trim_matches(|c: char| !c.is_numeric() && c != ':' && c != '.');
        if let Some((h_str, m_str)) = clean.split_once(':').or_else(|| clean.split_once('.')) {
            if let (Ok(h), Ok(m)) = (h_str.parse::<u32>(), m_str.parse::<u32>()) {
                if h <= 23 && m <= 59 {
                    return Some(format!("{:02}:{:02}", h, m));
                }
            }
        }
        if (*w == "a" || *w == "alas" || *w == "las") && i + 1 < words.len() {
            let next = words[i + 1].trim_matches(|c: char| !c.is_numeric() && c != ':' && c != '.');
            if let Some((h_str, m_str)) = next.split_once(':').or_else(|| next.split_once('.')) {
                if let (Ok(h), Ok(m)) = (h_str.parse::<u32>(), m_str.parse::<u32>()) {
                    if h <= 23 && m <= 59 {
                        return Some(format!("{:02}:{:02}", h, m));
                    }
                }
            } else if let Ok(h) = next.parse::<u32>() {
                if h <= 23 {
                    return Some(format!("{:02}:00", h));
                }
            }
        }
    }
    None
}

fn extract_calendar_info_from_calcurse(cmd: &str, original_prompt: &str) -> (String, String) {
    let title = if let Some(start) = cmd.find('\'') {
        if let Some(end) = cmd[start + 1..].find('\'') {
            cmd[start + 1..start + 1 + end].trim().to_string()
        } else {
            original_prompt.trim().to_string()
        }
    } else if let Some(start) = cmd.find('"') {
        if let Some(end) = cmd[start + 1..].find('"') {
            cmd[start + 1..start + 1 + end].trim().to_string()
        } else {
            original_prompt.trim().to_string()
        }
    } else {
        original_prompt.trim().to_string()
    };

    let time = extract_time_from_text(&title)
        .or_else(|| extract_time_from_text(cmd))
        .or_else(|| extract_time_from_text(original_prompt))
        .unwrap_or_else(|| "10:00".to_string());

    (title, time)
}

fn is_read_agenda_intent(prompt: &str) -> bool {
    let lower = prompt.to_lowercase();
    let read_keywords = [
        "agenda", "calendario", "citas de hoy", "eventos de hoy", "horario de hoy",
        "qué planes", "que planes", "planes para hoy", "qué tengo hoy", "que tengo hoy",
        "mis citas", "mis eventos", "ver agenda", "lee mi agenda", "leer agenda",
        "qué tengo programado", "que tengo programado"
    ];
    let create_keywords = [
        "añade", "añadir", "agrega", "agregar", "crea", "crear",
        "programa", "programar", "apunta", "apuntar", "agendar",
        "pon una cita", "pon cita", "recordatorio"
    ];

    let has_read = read_keywords.iter().any(|k| lower.contains(k));
    let has_create = create_keywords.iter().any(|k| lower.contains(k));

    has_read && !has_create
}

fn is_calendar_create_intent(prompt: &str) -> bool {
    let lower = prompt.to_lowercase();
    if is_read_agenda_intent(prompt) {
        return false;
    }
    let create_terms = [
        "cita", "citas", "evento", "eventos", "reunión", "reunion",
        "recordatorio", "recordarme", "recuérdame", "recuerdame",
        "agendar", "agenda una", "agenda un", "agenda cita",
        "pon una cita", "pon cita", "crear cita", "añadir cita", "anadir cita",
        "crea un evento", "añade un evento"
    ];
    create_terms.iter().any(|k| lower.contains(k))
}

fn extract_calendar_intent_fallback(prompt: &str, current_date: &str) -> Option<(String, String, String)> {
    if !is_calendar_create_intent(prompt) {
        return None;
    }
    let time = extract_time_from_text(prompt).unwrap_or_else(|| "10:00".to_string());
    let date = if prompt.to_lowercase().contains("mañana") {
        let now = chrono::Local::now();
        (now + chrono::Duration::days(1)).format("%Y-%m-%d").to_string()
    } else {
        current_date.to_string()
    };
    let title = prompt.trim().to_string();
    Some((title, date, time))
}

fn extract_task_intent_fallback(prompt: &str) -> Option<String> {
    let lower = prompt.to_lowercase();
    let prefixes = [
        "añade la tarea ", "anade la tarea ", "agrega la tarea ", "crea la tarea ",
        "nueva tarea ", "añadir tarea ", "anadir tarea ", "agregar tarea ",
        "añade tarea ", "anade tarea ", "agrega tarea ", "crea tarea "
    ];
    for p in prefixes {
        if let Some(idx) = lower.find(p) {
            let task_title = prompt[idx + p.len()..].trim();
            if !task_title.is_empty() {
                return Some(task_title.to_string());
            }
        }
    }
    None
}

fn extract_category_intent_fallback(prompt: &str) -> Option<(String, String)> {
    let lower = prompt.to_lowercase();
    if !lower.contains("carpeta") && !lower.contains("categoría") && !lower.contains("categoria") && !lower.contains("subcategoría") && !lower.contains("subcategoria") {
        return None;
    }
    let module_type = if lower.contains("tarea") || lower.contains("task") {
        "tasks".to_string()
    } else if lower.contains("horario") || lower.contains("rutina") || lower.contains("sched") {
        "schedules".to_string()
    } else if lower.contains("calendario") || lower.contains("evento") || lower.contains("cita") {
        "calendars".to_string()
    } else {
        "tasks".to_string()
    };

    if let Some(idx) = lower.find("llamada ") {
        let name = prompt[idx + "llamada ".len()..].trim().trim_matches(|c| c == '"' || c == '\'' || c == '.');
        if !name.is_empty() {
            return Some((name.to_string(), module_type));
        }
    } else if let Some(idx) = lower.find("llamado ") {
        let name = prompt[idx + "llamado ".len()..].trim().trim_matches(|c| c == '"' || c == '\'' || c == '.');
        if !name.is_empty() {
            return Some((name.to_string(), module_type));
        }
    }
    None
}

fn extract_note_intent_fallback(prompt: &str) -> Option<(String, String)> {
    let lower = prompt.to_lowercase();
    let prefixes = [
        "apunta esta nota:", "apunta la nota:", "guarda esta nota:", "crea una nota:",
        "apunta esta nota ", "apunta la nota ", "guarda esta nota ", "crea una nota ",
        "nota rápida:", "nota rapida:", "nota:"
    ];
    for p in prefixes {
        if let Some(idx) = lower.find(p) {
            let body = prompt[idx + p.len()..].trim();
            if !body.is_empty() {
                let title = if body.chars().count() > 30 {
                    let truncated: String = body.chars().take(30).collect();
                    format!("{}...", truncated)
                } else {
                    body.to_string()
                };
                return Some((title, body.to_string()));
            }
        }
    }
    None
}

fn extract_time_range_from_text(text: &str) -> (String, String) {
    let lower = text.to_lowercase();
    let words: Vec<&str> = lower.split_whitespace().collect();
    let mut found_times: Vec<String> = Vec::new();

    for (i, w) in words.iter().enumerate() {
        let clean = w.trim_matches(|c: char| !c.is_numeric() && c != ':' && c != '.');
        if let Some((h_str, m_str)) = clean.split_once(':').or_else(|| clean.split_once('.')) {
            if let (Ok(h), Ok(m)) = (h_str.parse::<u32>(), m_str.parse::<u32>()) {
                if h <= 23 && m <= 59 {
                    let formatted = format!("{:02}:{:02}", h, m);
                    if found_times.last() != Some(&formatted) {
                        found_times.push(formatted);
                    }
                    continue;
                }
            }
        }
        
        // Solo si la palabra es "de", "a", "alas", "las" y el siguiente token es un número entero simple (ej: "9", "14")
        if (*w == "de" || *w == "a" || *w == "alas" || *w == "las") && i + 1 < words.len() {
            let next_word = words[i + 1];
            if !next_word.contains(':') && !next_word.contains('.') {
                let next_clean = next_word.trim_matches(|c: char| !c.is_numeric());
                if let Ok(h) = next_clean.parse::<u32>() {
                    if h <= 23 {
                        let formatted = format!("{:02}:00", h);
                        if found_times.last() != Some(&formatted) {
                            found_times.push(formatted);
                        }
                    }
                }
            }
        }
    }

    if found_times.len() >= 2 {
        (found_times[0].clone(), found_times[1].clone())
    } else if found_times.len() == 1 {
        (found_times[0].clone(), "11:00".to_string())
    } else {
        ("10:00".to_string(), "11:00".to_string())
    }
}

fn is_schedule_create_intent(prompt: &str) -> bool {
    let lower = prompt.to_lowercase();
    let terms = [
        "rutina", "rutinas", "bloque horario", "bloque de", "horario de",
        "programa un bloque", "programa una rutina", "crea una rutina", "crear rutina",
        "añade una rutina", "anade una rutina", "nueva rutina", "nuevo horario",
        "crea un horario", "crear horario", "añadir horario", "anadir horario"
    ];
    terms.iter().any(|k| lower.contains(k))
}

fn extract_schedule_intent_fallback(prompt: &str, default_weekday: &str) -> Option<(String, String, String, String)> {
    if !is_schedule_create_intent(prompt) {
        return None;
    }
    let lower = prompt.to_lowercase();
    let day = if lower.contains("lunes") { "lunes" }
        else if lower.contains("martes") { "martes" }
        else if lower.contains("miércoles") || lower.contains("miercoles") { "miércoles" }
        else if lower.contains("jueves") { "jueves" }
        else if lower.contains("viernes") { "viernes" }
        else if lower.contains("sábado") || lower.contains("sabado") { "sábado" }
        else if lower.contains("domingo") { "domingo" }
        else if lower.contains("diario") || lower.contains("todos los días") || lower.contains("cada día") { "diario" }
        else { default_weekday };

    let (start_time, end_time) = extract_time_range_from_text(prompt);
    let block_name = prompt.trim().to_string();

    Some((day.to_string(), block_name, start_time, end_time))
}

fn extract_read_file_intent_fallback(prompt: &str) -> Option<String> {
    let lower = prompt.to_lowercase();
    let prefixes = [
        "lee el archivo ",
        "leer el archivo ",
        "lee el fichero ",
        "leer el fichero ",
        "lee el documento ",
        "leer el documento ",
        "lee archivo ",
        "leer archivo ",
        "muestra el archivo ",
        "mostrar el archivo ",
        "analiza el archivo ",
        "analizar el archivo ",
        "cat ",
        "abre y lee ",
        "contenido de ",
        "lee ",
    ];

    for prefix in prefixes {
        if let Some(idx) = lower.find(prefix) {
            let candidate = prompt[idx + prefix.len()..].trim();
            let clean = candidate
                .trim_matches(|c| c == '`' || c == '"' || c == '\'' || c == '.' || c == ',' || c == ':')
                .trim();
            if !clean.is_empty() && (prefix != "lee " || clean.contains('/') || clean.contains('.') || clean.starts_with('~')) {
                return Some(clean.to_string());
            }
        }
    }
    None
}

fn extract_terminal_command_intent_fallback(prompt: &str) -> Option<String> {
    let lower = prompt.to_lowercase();
    let prefixes = [
        "ejecuta en terminal ",
        "ejecutar en terminal ",
        "corre en terminal ",
        "correr en terminal ",
        "ejecuta el comando ",
        "ejecutar el comando ",
        "ejecuta en bash ",
        "ejecutar en bash ",
        "comando de terminal ",
        "comando en terminal ",
        "en terminal ejecuta ",
        "terminal: ",
        "bash: ",
        "ejecuta: ",
        "ejecuta ",
    ];

    for prefix in prefixes {
        if let Some(idx) = lower.find(prefix) {
            let candidate = prompt[idx + prefix.len()..].trim();
            let clean = candidate
                .trim_matches(|c| c == '`' || c == '"' || c == '\'')
                .trim();
            if !clean.is_empty() {
                if prefix == "ejecuta " {
                    let first_word = clean.split_whitespace().next().unwrap_or("").to_lowercase();
                    let common_cmds = [
                        "ls", "pwd", "whoami", "uname", "uptime", "ps", "df", "free", "cat", "grep",
                        "echo", "date", "which", "find", "git", "cargo", "curl", "ip", "systemctl",
                    ];
                    if common_cmds.contains(&first_word.as_str()) {
                        return Some(clean.to_string());
                    }
                } else {
                    return Some(clean.to_string());
                }
            }
        }
    }
    None
}

fn is_scheduling_or_creation_intent(prompt: &str) -> bool {
    let lower = prompt.to_lowercase();
    let keywords = [
        "rutina", "rutinas", "bloque horario", "bloque de", "horario de",
        "programa un bloque", "programa una rutina", "crea una rutina", "crear rutina",
        "añade una rutina", "anade una rutina", "nueva rutina", "nuevo horario",
        "crea un horario", "crear horario", "añadir horario", "anadir horario",
        "cita", "citas", "evento", "eventos", "reunión", "reunion",
        "pon una cita", "pon cita", "agendar", "agenda una", "agenda un", "crea un evento",
        "añade la tarea", "anade la tarea", "crea la tarea", "guarda esta nota"
    ];
    keywords.iter().any(|k| lower.contains(k))
}


fn clean_spoken_text(text: &str) -> String {
    let un_thought = strip_thinking_tags(text);
    crate::enigma::clean_markdown_for_speech(&un_thought)
}

/// Clasificación de Intenciones utilizando el modelo orquestador `gemma4:e4b`
pub async fn classify_intent(user_input: &str) -> Result<AgentRoute, String> {
    // Fast-path prioritario para WhatsApp, Gmail, Calendario/Citas, Tareas, Apps y Terminal
    let lower_input = user_input.to_lowercase();
    if lower_input.contains("whatsapp")
        || lower_input.contains("mensaje a")
        || lower_input.contains("mándale")
        || lower_input.contains("mandale")
        || lower_input.contains("escríbele")
        || lower_input.contains("escribe a")
        || lower_input.contains("dile a")
        || lower_input.contains("correo")
        || lower_input.contains("correos")
        || lower_input.contains("gmail")
        || lower_input.contains("email")
        || lower_input.contains("emails")
        || lower_input.contains("bandeja de entrada")
        || lower_input.contains("cita")
        || lower_input.contains("citas")
        || lower_input.contains("evento")
        || lower_input.contains("eventos")
        || lower_input.contains("agenda")
        || lower_input.contains("calendario")
        || lower_input.contains("recordatorio")
        || lower_input.contains("recuérdame")
        || lower_input.contains("recuerdame")
        || lower_input.contains("reunión")
        || lower_input.contains("reunion")
        || lower_input.contains("tarea")
        || lower_input.contains("pendiente")
        || lower_input.contains("rutina")
        || lower_input.contains("rutinas")
        || lower_input.contains("horario")
        || lower_input.contains("horarios")
        || lower_input.contains("terminal")
        || lower_input.contains("bash")
        || lower_input.contains("comando")
        || lower_input.contains("abre ")
        || lower_input.contains("abrir ")
        || lower_input.contains("cierra ")
        || lower_input.contains("cerrar ")
        || lower_input.contains("entra a")
        || lower_input.contains("youtube")
        || lower_input.contains("spotify")
        || lower_input.contains("opera")
        || lower_input.contains("telegram")
        || lower_input.contains("al móvil")
        || lower_input.contains("al movil")
        || lower_input.contains("avísame")
        || lower_input.contains("avisame")
        || lower_input.contains("pantalla")
        || lower_input.contains("mira lo que")
        || lower_input.contains("mira mi")
        || lower_input.contains("mira qué")
        || lower_input.contains("mira que")
        || lower_input.contains("qué ves")
        || lower_input.contains("que ves")
        || lower_input.contains("captura")
        || lower_input.contains("screenshot")
        || lower_input.contains("imagen")
        || lower_input.contains("imágenes")
        || lower_input.contains("imagenes")
        || lower_input.contains("dibuja")
        || lower_input.contains("pinta")
        || lower_input.contains("generar imagen")
        || lower_input.contains("crear imagen")
        || lower_input.contains("genera una imagen")
        || lower_input.contains("crea una imagen")
        || lower_input.contains("lee el archivo")
        || lower_input.contains("leer el archivo")
        || lower_input.contains("lee archivo")
        || lower_input.contains("muestra el archivo")
        || lower_input.contains("analiza el archivo")
        || lower_input.contains("ejecuta en terminal")
        || lower_input.contains("corre en terminal")
        || lower_input.contains("comando de terminal")
        || lower_input.contains("portapapeles")
        || lower_input.contains("copiado")
        || lower_input.contains("copia al")
        || lower_input.contains("copia esto")
        || lower_input.contains("pega el")
        || lower_input.contains("qué estoy haciendo")
        || lower_input.contains("que estoy haciendo")
        || lower_input.contains("en qué ventana")
        || lower_input.contains("en que ventana")
        || lower_input.contains("ventana activa")
        || lower_input.contains("pásame a")
        || lower_input.contains("pasame a")
        || lower_input.contains("enfoca")
        || lower_input.contains("cambia a la ventana")
        || lower_input.contains("ventanas abiertas")
        || lower_input.contains("ayúdame con esto")
        || lower_input.contains("ayudame con esto")
        || lower_input.contains("música")
        || lower_input.contains("musica")
        || lower_input.contains("canción")
        || lower_input.contains("cancion")
        || lower_input.contains("reproduce")
        || lower_input.contains("reproducir")
        || lower_input.contains("pausa")
        || lower_input.contains("pausar")
        || lower_input.contains("siguiente canción")
        || lower_input.contains("canción anterior")
        || lower_input.contains("volumen")
        || lower_input.contains("sube el volumen")
        || lower_input.contains("baja el volumen")
        || lower_input.contains("silencia")
        || lower_input.contains("mute")
        || lower_input.contains("notificación")
        || lower_input.contains("notificacion")
        || lower_input.contains("busca en internet")
        || lower_input.contains("busca en la web")
        || lower_input.contains("buscar en internet")
        || lower_input.contains("duckduckgo")
    {
        return Ok(AgentRoute {
            category: IntentCategory::SYSTEM,
            target_model: SYSTEM_MODEL.to_string(),
            description: "Enrutamiento prioritario para control de sistema, visión, generación y utilidades".to_string(),
        });
    }

    // Enrutamiento prioritario rápido para CODE (sin latencia de red)
    if lower_input.contains("función")
        || lower_input.contains("funcion")
        || lower_input.contains("escribe una función")
        || lower_input.contains("escribe un script")
        || lower_input.contains("código")
        || lower_input.contains("codigo")
        || lower_input.contains("en rust")
        || lower_input.contains("en python")
        || lower_input.contains("en javascript")
        || lower_input.contains("en typescript")
        || lower_input.contains("algoritmo")
        || lower_input.contains("refactoriza")
    {
        return Ok(AgentRoute {
            category: IntentCategory::CODE,
            target_model: CODE_MODEL.to_string(),
            description: "Enrutamiento prioritario para generación y análisis de código".to_string(),
        });
    }

    // Enrutamiento prioritario rápido para REASONING (sin latencia de red)
    if lower_input.contains("paradoja")
        || lower_input.contains("gran filtro")
        || lower_input.contains("fermi")
        || lower_input.contains("filosofía")
        || lower_input.contains("filosofia")
        || lower_input.contains("explica en detalle")
        || lower_input.contains("por qué el universo")
        || lower_input.contains("teorema")
    {
        return Ok(AgentRoute {
            category: IntentCategory::REASONING,
            target_model: REASONING_MODEL.to_string(),
            description: "Enrutamiento prioritario para razonamiento conceptual y lógica profunda".to_string(),
        });
    }

    let client = Client::builder()
        .timeout(std::time::Duration::from_secs(4))
        .build()
        .unwrap_or_default();
    let classification_system_prompt = r#"Eres el clasificador de intenciones ultra-rápido de Enigma. Clasifica la petición del usuario en exactamente UNA de estas 4 categorías:
- GENERAL: Conversación casual, saludos ('hola', 'cómo estás', 'qué tal'), charlas, preguntas cotidianas o directas que no requieren manipular el sistema operativo.
- SYSTEM: Comandos del sistema operativo Linux, terminal bash, volumen, música, abrir/cerrar aplicaciones, abrir páginas web, URLs, YouTube, leer o consultar correos de Gmail, enviar mensajes de WhatsApp o Telegram, calendario, tareas, rutinas, notas, mirar o analizar la pantalla (visión en tiempo real con Llava), generar o crear imágenes (Stable Diffusion), y leer archivos locales o ejecutar comandos seguros en la terminal del sistema.
- CODE: Peticiones de programación, scripts, funciones, desarrollo web, refactorización, depuración, bugs, algoritmos.
- REASONING: Dudas complejas, análisis profundo, filosofía, lógica avanzada, matemáticas teóricas, estrategia.

REGLAS ESTRICTAS DE HERRAMIENTAS:
- Si el usuario pide que mires su pantalla, leas lo que está haciendo o analices lo que ve, clasifícalo OBLIGATORIAMENTE como SYSTEM para invocar la herramienta `analyze_current_screen`.
- Si el usuario pide generar, crear o dibujar una imagen, clasifícalo OBLIGATORIAMENTE como SYSTEM para invocar la herramienta `generate_image`.
- Si el usuario pide leer un archivo de su ordenador, clasifícalo OBLIGATORIAMENTE como SYSTEM para invocar `read_local_file`.
- Si el usuario pide ejecutar un comando en la terminal, clasifícalo OBLIGATORIAMENTE como SYSTEM para invocar `execute_terminal_command`.

Responde ÚNICAMENTE con un JSON válido con este formato exacto:
{"category": "SYSTEM" | "CODE" | "REASONING" | "GENERAL"}"#;

    let cfg = crate::models_config::load_model_config();
    let orchestrator_model = crate::models_config::resolve_or_fallback_model(&cfg.orchestrator_model, &cfg.default_model).await;
    let fallback_system_model = crate::models_config::resolve_or_fallback_model(&cfg.system_model, &cfg.default_model).await;

    let request_body = ChatRequest {
        model: orchestrator_model.clone(),
        messages: vec![
            ChatMessage {
                role: "system".to_string(),
                content: classification_system_prompt.to_string(),
                tool_calls: None,
            },
            ChatMessage {
                role: "user".to_string(),
                content: format!(
                    "{}\n\n[SISTEMA: Responde OBLIGATORIAMENTE en español. Prohibido responder en inglés]",
                    user_input
                ),
                tool_calls: None,
            },
        ],
        stream: false,
        format: Some("json".to_string()),
        options: Some(serde_json::json!({
            "temperature": 0.0,
            "num_predict": 2048
        })),
        tools: None,
    };

    let res = match client
        .post(format!("{}/api/chat", OLLAMA_API_BASE))
        .json(&request_body)
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => {
            eprintln!("[Router] Error de conexión con Ollama en clasificación ({}): {}. Usando fallback a {}", orchestrator_model, e, fallback_system_model);
            return Ok(AgentRoute {
                category: IntentCategory::SYSTEM,
                target_model: fallback_system_model,
                description: "Fallback automático por fallo de conexión".to_string(),
            });
        }
    };

    if !res.status().is_success() {
        eprintln!("[Router] Ollama retornó HTTP {}. Usando fallback a {}", res.status(), fallback_system_model);
        return Ok(AgentRoute {
            category: IntentCategory::SYSTEM,
            target_model: fallback_system_model,
            description: "Fallback automático por respuesta HTTP no exitosa".to_string(),
        });
    }

    let chat_resp: ChatResponse = match res.json().await {
        Ok(json) => json,
        Err(e) => {
            eprintln!("[Router] Error deserializando JSON de clasificación: {}. Usando fallback a {}", e, fallback_system_model);
            return Ok(AgentRoute {
                category: IntentCategory::SYSTEM,
                target_model: fallback_system_model,
                description: "Fallback automático por error de formato JSON".to_string(),
            });
        }
    };

    let raw_content = if !chat_resp.message.content.trim().is_empty() {
        chat_resp.message.content.trim()
    } else if let Some(think) = &chat_resp.message.thinking {
        think.trim()
    } else {
        ""
    };
    let category = parse_category_from_json(raw_content);

    let route = match category {
        IntentCategory::SYSTEM => AgentRoute {
            category,
            target_model: crate::models_config::resolve_or_fallback_model(&cfg.system_model, &cfg.default_model).await,
            description: "Ejecución de herramientas y control del sistema Linux".to_string(),
        },
        IntentCategory::CODE => AgentRoute {
            category,
            target_model: crate::models_config::resolve_or_fallback_model(&cfg.code_model, &cfg.default_model).await,
            description: "Generación, análisis y depuración de código y scripts".to_string(),
        },
        IntentCategory::REASONING => AgentRoute {
            category,
            target_model: crate::models_config::resolve_or_fallback_model(&cfg.reasoning_model, &cfg.default_model).await,
            description: "Razonamiento profundo, análisis lógico y conceptual".to_string(),
        },
        IntentCategory::GENERAL => AgentRoute {
            category,
            target_model: crate::models_config::resolve_or_fallback_model(&cfg.general_model, &cfg.default_model).await,
            description: "Conversación general e interactividad fluida".to_string(),
        },
    };

    Ok(route)
}

/// Construye el System Prompt combinado: primero Core Memory (enigma_core.md), luego la Persona Activa (Custom GPTs)
pub fn build_combined_system_prompt(identity_core: &str, active_persona: Option<&str>) -> String {
    let mut base = identity_core.to_string();
    if !base.contains("REGLA ESTRICTA DE IDIOMA") {
        base.push_str("\n\n---\n## REGLA ESTRICTA DE IDIOMA (MANDATARIO ABSOLUTO):\nTu único idioma de salida es el ESPAÑOL. Aunque recibas telemetría, código, memoria o instrucciones internas en inglés, SIEMPRE debes hablar y responder única y exclusivamente en español natural.\n---\n");
    }

    if let Some(persona_name) = active_persona {
        let clean_p = persona_name.trim();
        if !clean_p.is_empty() && clean_p != "enigma_default" {
            match crate::personas::get_persona_content(clean_p) {
                Ok(custom_prompt) if !custom_prompt.trim().is_empty() => {
                    eprintln!("[Router] 🎭 Inyectando directiva de Persona Activa: '{}'", clean_p);
                    return format!(
                        "{}\n\n---\n## PERSONALIDAD Y DIRECTIVAS DE LA PERSONA ACTIVA ('{}'):\n{}\n---\n\nREGLA ESTRICTA DE IDIOMA: Tu único idioma de salida es el ESPAÑOL. Aunque recibas telemetría, código, memoria o instrucciones internas en inglés, SIEMPRE debes hablar y responder única y exclusivamente en español natural.",
                        base,
                        clean_p,
                        custom_prompt.trim()
                    );
                }
                _ => {}
            }
        }
    }
    base
}

/// Pipeline de Ejecución Unificado de Enigma con Transparencia de Procesos Multi-Agente
#[tauri::command]
pub async fn process_enigma_message(
    app: AppHandle,
    user_input: String,
    active_persona: Option<String>,
) -> Result<EnigmaResponse, String> {
    process_enigma_message_core(Some(&app), user_input, active_persona).await
}

pub async fn process_enigma_message_core(
    app: Option<&AppHandle>,
    user_input: String,
    active_persona: Option<String>,
) -> Result<EnigmaResponse, String> {
    let input_trimmed = user_input.trim();
    if input_trimmed.is_empty() {
        return Err("El mensaje del usuario no puede estar vacío".to_string());
    }

    eprintln!("[Router] Procesando mensaje: '{}' (Persona: {:?})", input_trimmed, active_persona);

    let cfg = crate::models_config::load_model_config();
    let orchestrator_display = crate::models_config::resolve_or_fallback_model(&cfg.orchestrator_model, &cfg.default_model).await;
    let fallback_system = crate::models_config::resolve_or_fallback_model(&cfg.system_model, &cfg.default_model).await;

    // Fase 1: Orquestador analizando intención...
    if let Some(app) = app {
        let _ = app.emit("enigma-status", EnigmaStatusPayload {
            phase: 1,
            status: "Orquestador analizando intención...".to_string(),
            model: Some(orchestrator_display),
        });
    }

    // 1. Recuperar contexto de memoria reciente e inyectar Conciencia Core (enigma_core.md)
    let recent_context = crate::memory::get_recent_context(8);
    let identity_core = crate::memory::load_core_memory();

    // 1.1 Inyección Combinada: Core Memory + Persona Activa (Custom GPTs)
    let identity_combined = build_combined_system_prompt(&identity_core, active_persona.as_deref());

    // 2. Clasificar la intención
    let route = classify_intent(input_trimmed)
        .await
        .unwrap_or_else(|_| AgentRoute {
            category: IntentCategory::SYSTEM,
            target_model: fallback_system,
            description: "Fallback por error de clasificación".to_string(),
        });

    eprintln!(
        "[Router] Intención clasificada como: {:?} -> Modelo objetivo: '{}'",
        route.category, route.target_model
    );

    // Fase 2: Enrutando a [Modelo Seleccionado]...
    if let Some(app) = app {
        let _ = app.emit("enigma-status", EnigmaStatusPayload {
            phase: 2,
            status: format!("Enrutando a {}...", route.target_model),
            model: Some(route.target_model.clone()),
        });
    }

    // Fase 3: Generando respuesta...
    if let Some(app) = app {
        let _ = app.emit("enigma-status", EnigmaStatusPayload {
            phase: 3,
            status: "Generando respuesta...".to_string(),
            model: Some(route.target_model.clone()),
        });
    }

    let client = Client::builder()
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .unwrap_or_default();

    // Contexto temporal del sistema con crate chrono (inyectado a todos los agentes para evitar alucinaciones)
    let now = chrono::Local::now();
    let current_date = now.format("%Y-%m-%d").to_string();
    let current_time = now.format("%H:%M").to_string();
    let weekday_es = match now.format("%u").to_string().as_str() {
        "1" => "lunes",
        "2" => "martes",
        "3" => "miércoles",
        "4" => "jueves",
        "5" => "viernes",
        "6" => "sábado",
        "7" => "domingo",
        _ => "hoy",
    };
    let weekday_cap = match now.format("%u").to_string().as_str() {
        "1" => "Lunes",
        "2" => "Martes",
        "3" => "Miércoles",
        "4" => "Jueves",
        "5" => "Viernes",
        "6" => "Sábado",
        "7" => "Domingo",
        _ => "Hoy",
    };
    let month_es = match now.format("%m").to_string().as_str() {
        "01" => "Enero",
        "02" => "Febrero",
        "03" => "Marzo",
        "04" => "Abril",
        "05" => "Mayo",
        "06" => "Junio",
        "07" => "Julio",
        "08" => "Agosto",
        "09" => "Septiembre",
        "10" => "Octubre",
        "11" => "Noviembre",
        "12" => "Diciembre",
        _ => "",
    };
    let day_num = now.format("%d").to_string();
    let temporal_header = format!("Contexto actual: {}, {} de {}, {}", weekday_cap, day_num, month_es, current_time);

    // 3. Ejecución especializada según la categoría
    let (final_content, executed_tools) = match route.category {
        IntentCategory::SYSTEM => {
            let mut executed_tools = Vec::new();
            let telemetry_patterns = crate::telemetry::get_user_patterns();

            // Invocar a hermes3 con herramientas de sistema activadas y directiva estricta de function calling
            let system_prompt = format!(
                r#"{identity}

## DIRECTIVA OBLIGATORIA DE IDIOMA (MANDATARIO ABSOLUTO):
- DEBES RESPONDER SIEMPRE, SIN EXCEPCIÓN Y EN TODAS LAS CIRCUNSTANCIAS EN ESPAÑOL.
- ESTÁ TERMINANTEMENTE PROHIBIDO RESPONDER EN INGLÉS O CUALQUIER OTRO IDIOMA.
- Si requieres invocar una herramienta, devuelve únicamente el JSON válido con el schema de herramientas sin texto adicional.
- Si respondes de forma conversacional o confirmas una acción, responde SIEMPRE en español de forma directa, inteligente y natural.

{temporal_header}

{context}

CONTEXTO TEMPORAL DEL SISTEMA:
Hoy es {weekday}, fecha: {date} (formato ISO YYYY-MM-DD), y son las {time} (formato 24h HH:MM).

{telemetry}

Eres el agente de ejecución de sistema de Enigma. Tienes acceso completo a herramientas locales para controlar el sistema Linux de Santiago.

REGLAS CRÍTICAS DE EJECUCIÓN (ANTI-ALUCINACIÓN):
- NUNCA respondas con texto plano afirmando haber creado, programado o modificado una rutina, horario, cita o tarea si no has emitido la llamada a la herramienta correspondiente ('add_schedule', 'add_event', 'add_task').
- Si el usuario te pide programar, añadir o crear una rutina, horario o bloque de tiempo (ej: 'añade una rutina los lunes de 10 a 12 de estudio'), es OBLIGATORIO invocar la herramienta 'add_schedule'.
- Si el usuario te pide agendar una cita o evento en una fecha (ej: 'cita mañana a las 18:00'), es OBLIGATORIO invocar 'add_event'.
- Toda creación DEBE ejecutarse en la base de datos real. No inventes confirmaciones con fechas literales como 'YYYY-MM-DD'.

REGLAS OBLIGATORIAS PARA EL USO DE HERRAMIENTAS:

1. CALENDARIO Y GESTIÓN DE CITAS:
   - REGLA: Si el usuario pide agendar, añadir, crear o poner una cita, evento, reunión o recordatorio (ej: "Cita a las 7:30", "pon una cita al dentista a las 18:00", "agenda una reunión"), DEBES usar OBLIGATORIAMENTE la herramienta `add_event`.
   - Especifica:
     * `title`: El motivo de la cita/evento (ej: "Cita a las 7:30", "Dentista").
     * `date`: Fecha en formato YYYY-MM-DD (por defecto hoy: {date}).
     * `time`: Hora en formato HH:MM (ej: "07:30" o "19:30").
     * `notify_before`: Minutos de antelación para notificar (15).
   - PROHIBIDO TERMINANTEMENTE usar `run_terminal` o comandos como `calcurse` o `calcurg` para citas o calendario. Enigma gestiona el calendario con su base de datos local SQLite mediante `add_event`.
   - Si el usuario pide consultar o ver su agenda o eventos (ej: "qué tengo hoy", "ver agenda", "lee mis citas"), usa `get_calendar_events`.

2. TAREAS Y PENDIENTES:
   - REGLA: Si el usuario pide añadir o crear una tarea (ej: "añade la tarea comprar pan", "nueva tarea"), usa `add_task` con `title`.
   - Si pide consultar o ver las tareas pendientes, usa `get_tasks`.

3. MENSAJERÍA WHATSAPP:
   - REGLA: Si el usuario pide enviar, mandar o escribir un mensaje por WhatsApp (ej: "mándale un mensaje a papi que diga holiii", "escribe a Carlos por whatsapp", "manda un whatsapp"), DEBES usar OBLIGATORIAMENTE la herramienta `send_whatsapp` especificando `contact_name` y `message`.
   - NUNCA digas que no puedes cumplir con esa solicitud. Enigma tiene integración nativa con WhatsApp.

4. CORREOS ELECTRÓNICOS (GMAIL):
   - REGLA: Si el usuario pide leer, revisar, ver, consultar sus correos, emails o bandeja de entrada (ej: "lee mis correos", "tengo emails nuevos", "revisa mi correo"), DEBES usar OBLIGATORIAMENTE la herramienta `read_emails`.
   - PROHIBIDO TERMINANTEMENTE ejecutar comandos de terminal como `mail`, `mutt` o `pine` en `run_terminal`. Enigma lee los correos de Gmail a través de `read_emails`.
   - Solo si el usuario pide explícitamente "abrir la web de Gmail en el navegador", usa `open_url` con `https://mail.google.com`.

5. NAVEGACIÓN Y SITIOS WEB (NAVEGADOR OPERA):
   - REGLA: Si el usuario pide "entrar a", "abrir la web de", "ir a YouTube", "visitar", o cualquier dirección/servicio web, usa `open_url` con el formato `https://...` para abrirlo en Opera.
   - NUNCA uses `open_app` para páginas web ni servicios en la nube.

6. APLICACIONES LOCALES:
   - REGLA: Si el usuario pide abrir un programa local instalado en el equipo (Spotify, Discord, Kitty, Dolphin, etc.), usa `open_app`.
   - Si pide cerrar un programa, usa `close_app`.

7. TECLADO Y RATÓN VIRTUAL:
   - REGLA: Si el usuario pide escribir texto, usa `type_text`. Si pide pulsar una tecla, usa `press_key`. Para mover el ratón o hacer clic, usa `move_mouse` y `mouse_click`.

8. TERMINAL BASH:
   - REGLA: Usa `run_terminal` o `execute_terminal_command` para comandos bash de inspección o utilidades del sistema Linux (ej: ls, uname, df, free). NO lo uses para correos, WhatsApp ni calendario.

9. BÚSQUEDA WEB:
   - REGLA: Si el usuario pide buscar información general en Google, usa `search_web` (abrirá Opera y buscará en Google).

10. VISIÓN Y ANÁLISIS DE IMÁGENES (OLLAMA LLAVA):
    - REGLA: Si el usuario pide analizar, ver o describir una imagen indicando su ruta, usa la herramienta `analyze_image` con `image_path` y `prompt`.

11. COMUNICACIONES Y CONTROL MÓVIL (BOT PRIVADO DE TELEGRAM):
    - REGLA: Si el usuario te pide avisarle al móvil, enviarle una alerta a Telegram o recordarle algo de forma remota, utiliza la herramienta `send_telegram_alert` con `message`.

12. ORGANIZACIÓN JERÁRQUICA Y SUBCATEGORÍAS / CARPETAS DINÁMICAS:
    - REGLA: Si el usuario pide crear una carpeta, categoría o subcategoría (ej: "Crea una carpeta de tareas llamada Urgente", "Crea una categoría de horarios llamada Gym", "Nueva subcategoría de calendario Reuniones"), DEBES usar OBLIGATORIAMENTE la herramienta `add_category` especificando `name` y `module_type` ('tasks', 'schedules' o 'calendars').

13. NOTAS RÁPIDAS:
    - REGLA: Si el usuario pide crear, apuntar o guardar una nota rápida (ej: "Apunta esta nota: Comprar tornillos", "Nota rápida: Idea de proyecto"), usa la herramienta `add_note` con `title` y `content`.

14. RUTINAS Y BLOQUES HORARIOS RECURRENTES:
    - REGLA: Si el usuario pide crear, añadir o programar una rutina, horario o bloque de tiempo recurrente (ej: "crea una rutina los lunes de 14:00 a 16:00 de estudio", "nuevo horario de 9 a 11"), DEBES usar OBLIGATORIAMENTE la herramienta `add_schedule` especificando `day_of_week`, `block_name`, `start_time` y `end_time`.
    - Si el usuario pide consultar sus horarios o bloques registrados, usa `get_schedules`.

15. VISIÓN Y CONCIENCIA DE PANTALLA EN TIEMPO REAL:
    - REGLA: Si el usuario pide que mires su pantalla, leas lo que está haciendo o analices lo que ve, INVOCA la herramienta `analyze_current_screen` pasándole su consulta.

16. GENERACIÓN DE IMÁGENES LOCAL (STABLE DIFFUSION):
    - REGLA: Si el usuario pide generar, crear o dibujar una imagen, INVOCA la herramienta `generate_image` pasándole la descripción detallada.

17. OS SKILLS (SISTEMA DE ARCHIVOS Y TERMINAL):
    - REGLA: Tienes acceso al sistema de archivos y a la terminal del usuario. Usa `read_local_file` para analizar código o documentos, y `execute_terminal_command` para automatizar tareas en su ordenador.

18. INTELIGENCIA DE PORTAPAPELES (CLIPBOARD INTELLIGENCE):
    - REGLA: Tienes acceso directo al portapapeles del sistema operativo Linux.
    - Si el usuario dice "lo que tengo copiado", "explícame este código", "corrige el bug de mi portapapeles", "resume lo que acabo de copiar" o "traduce mi portapapeles", INVOCA la herramienta `read_clipboard`.
    - Si el usuario te pide copiar un comando, código o texto al portapapeles, INVOCA la herramienta `copy_to_clipboard` pasándole el texto exacto.

19. CONCIENCIA DEL CONTEXTO ACTIVO Y GESTIÓN DE VENTANAS:
    - REGLA: Tienes conciencia en tiempo real de las ventanas abiertas en el escritorio KDE Plasma 6 y de la aplicación que Santiago tiene en foco.
    - Si el usuario pregunta "¿qué estoy haciendo?", "¿en qué ventana estoy?" o "ayúdame con esto", INVOCA la herramienta `get_active_context` para conocer la ventana en foco y actividad del sistema. Si además pide mirar o entender lo que ve, puedes combinar con `analyze_current_screen`.
    - Si el usuario te pide cambiar de ventana, enfocar o traer una app al frente (ej: "pásame a Discord", "enfoca el editor", "ponme Spotify", "trae la terminal"), INVOCA la herramienta `focus_window` pasándole el nombre de la app.

20. CONTROL MULTIMEDIA Y VOLUMEN DEL SISTEMA (MPRIS / PIPEWIRE):
    - REGLA: Tienes control nativo de música y audio en Linux.
    - Si el usuario pregunta "qué está sonando", "qué canción es", "qué música suena", INVOCA la herramienta `get_media_status`.
    - Si pide pausar, reanudar ("PlayPause", "Play", "Pause"), siguiente ("Next"), anterior ("Previous") o detener ("Stop"), INVOCA `control_media_player`.
    - Si pide subir, bajar o cambiar el volumen (ej: "sube el volumen", "baja volumen", "mute"), INVOCA `adjust_system_volume`.

21. BÚSQUEDA WEB EN TIEMPO REAL (DUCKDUCKGO):
    - REGLA: Si el usuario pide buscar información en tiempo real en internet o noticias actuales, INVOCA la herramienta `search_web_duckduckgo`.

22. NOTIFICACIONES DE ESCRITORIO:
    - REGLA: Si el usuario pide enviar una notificación nativa en pantalla, INVOCA `send_desktop_notification`.

Responde de forma concisa confirmando la acción realizada."#,
                temporal_header = temporal_header,
                identity = identity_combined,
                context = recent_context,
                weekday = weekday_es,
                date = current_date,
                time = current_time,
                telemetry = telemetry_patterns
            );

            let req_body = ChatRequest {
                model: route.target_model.clone(),
                messages: vec![
                    ChatMessage {
                        role: "system".to_string(),
                        content: system_prompt,
                        tool_calls: None,
                    },
                    ChatMessage {
                        role: "user".to_string(),
                        content: format!(
                            "{}\n\n[SISTEMA: Responde OBLIGATORIAMENTE en español. Prohibido responder en inglés]",
                            input_trimmed
                        ),
                        tool_calls: None,
                    },
                ],
                stream: false,
                format: None,
                options: Some(serde_json::json!({ "temperature": 0.0, "num_predict": 4096 })),
                tools: Some(get_system_tools_schema()),
            };

            let res = client
                .post(format!("{}/api/chat", OLLAMA_API_BASE))
                .json(&req_body)
                .send()
                .await
                .map_err(|e| format!("Error conectando con {}: {}", route.target_model, e))?;

            let chat_resp: ChatResponse = res
                .json()
                .await
                .map_err(|e| format!("Error leyendo respuesta de {}: {}", route.target_model, e))?;

            let mut tool_results_text = Vec::new();

            // Recoger tool calls estructurados o parsear JSON impreso en message.content
            let mut calls_to_execute = Vec::new();
            if let Some(tool_calls) = chat_resp.message.tool_calls {
                for call in tool_calls {
                    if let Some(func) = call.function {
                        calls_to_execute.push(func);
                    }
                }
            }

            if calls_to_execute.is_empty() {
                let raw_content = chat_resp.message.content.trim();
                if let Some((fname, fargs)) = try_parse_function_call_from_content(raw_content) {
                    eprintln!("[Router] Llamada a función detectada en raw content: '{}'", fname);
                    calls_to_execute.push(ToolCallFunction {
                        name: fname,
                        arguments: fargs,
                    });
                }
            }

            for func in calls_to_execute {
                let name = func.name;
                executed_tools.push(name.clone());
                match name.as_str() {
                            "add_event" => {
                                let title_raw = func
                                    .arguments
                                    .get("title")
                                    .or_else(|| func.arguments.get("titulo"))
                                    .or_else(|| func.arguments.get("name"))
                                    .and_then(|v| v.as_str())
                                    .unwrap_or_default();
                                let date_raw = func
                                    .arguments
                                    .get("date")
                                    .or_else(|| func.arguments.get("fecha"))
                                    .and_then(|v| v.as_str())
                                    .unwrap_or_default();
                                let time_raw = func
                                    .arguments
                                    .get("time")
                                    .or_else(|| func.arguments.get("hora"))
                                    .and_then(|v| v.as_str())
                                    .unwrap_or_default();
                                let notify_before = func
                                    .arguments
                                    .get("notify_before")
                                    .and_then(|v| v.as_i64())
                                    .unwrap_or(15) as i32;

                                let title = if title_raw.trim().is_empty() {
                                    input_trimmed.to_string()
                                } else {
                                    title_raw.trim().to_string()
                                };

                                let date = if date_raw.trim().is_empty() || date_raw == "hoy" {
                                    current_date.clone()
                                } else if date_raw == "mañana" {
                                    (now + chrono::Duration::days(1)).format("%Y-%m-%d").to_string()
                                } else {
                                    date_raw.trim().to_string()
                                };

                                let mut time = time_raw.trim().to_string();
                                if time.is_empty() {
                                    time = extract_time_from_text(&title).unwrap_or_else(|| "10:00".to_string());
                                } else if time.len() == 4 && time.chars().nth(1) == Some(':') {
                                    time = format!("0{}", time);
                                }

                                eprintln!("[Router] Agendando evento: '{}' para {} a las {}", title, date, time);
                                match crate::db::db_add_calendar_event(&title, &date, &time, notify_before, None) {
                                    Ok(id) => {
                                        if let Some(app) = app {
                                            let _ = app.emit("refresh-calendar", ());
                                            let _ = app.emit_to("main", "refresh-calendar", ());
                                        }
                                        tool_results_text.push(format!(
                                            "> 📅 **Cita programada con éxito (#{})**: **\"{}\"** para el **{}** a las **{}** (aviso {} min antes)",
                                            id, title, date, time, notify_before
                                        ));
                                    }
                                    Err(err) => {
                                        tool_results_text.push(format!(
                                            "> ⚠️ **Error al guardar en el calendario**: {}",
                                            err
                                        ));
                                    }
                                }
                            }
                            "get_calendar_events" => {
                                eprintln!("[Router] Consultando eventos del calendario en SQLite...");
                                if let Some(app) = app {
                                    let _ = app.emit("refresh-calendar", ());
                                    let _ = app.emit_to("main", "refresh-calendar", ());
                                }
                                match crate::db::db_get_calendar_events() {
                                    Ok(events) => {
                                        if events.is_empty() {
                                            tool_results_text.push("> 📅 **Agenda**: No tienes ningún evento ni cita programada en tu calendario.".to_string());
                                        } else {
                                            let mut summary = format!("> 📅 **Agenda**: Tienes **{} evento(s) en tu calendario**:\n\n", events.len());
                                            for ev in events.iter().take(8) {
                                                summary.push_str(&format!(
                                                    "- **{}** | Fecha: `{}` a las `{}` (aviso {}m)\n",
                                                    ev.title, ev.event_date, ev.event_time, ev.notify_before_mins
                                                ));
                                            }
                                            tool_results_text.push(summary.trim_end().to_string());
                                        }
                                    }
                                    Err(err) => {
                                        tool_results_text.push(format!("> ⚠️ **Error consultando el calendario**: {}", err));
                                    }
                                }
                            }
                            "add_task" => {
                                let title_raw = func
                                    .arguments
                                    .get("title")
                                    .or_else(|| func.arguments.get("tarea"))
                                    .and_then(|v| v.as_str())
                                    .unwrap_or_default();
                                let title = title_raw.trim();
                                if title.is_empty() {
                                    tool_results_text.push("> ⚠️ **Tareas**: Título de tarea vacío.".to_string());
                                } else {
                                    match crate::db::db_add_task(title, None) {
                                        Ok(id) => {
                                            if let Some(app) = app {
                                                let _ = app.emit("refresh-tasks", ());
                                            }
                                            tool_results_text.push(format!("> 📋 **Tarea añadida (#{})**: **\"{}\"**", id, title));
                                        }
                                        Err(err) => {
                                            tool_results_text.push(format!("> ⚠️ **Error añadiendo tarea**: {}", err));
                                        }
                                    }
                                }
                            }
                            "get_tasks" => {
                                match crate::db::db_get_tasks() {
                                    Ok(tasks) => {
                                        if let Some(app) = app {
                                            let _ = app.emit("refresh-tasks", ());
                                        }
                                        if tasks.is_empty() {
                                            tool_results_text.push("> 📋 **Tareas**: No tienes tareas pendientes.".to_string());
                                        } else {
                                            let mut summary = format!("> 📋 **Lista de Tareas ({} pendientes)**:\n\n", tasks.len());
                                            for t in tasks.iter().take(10) {
                                                let icon = if t.status == "completed" { "✅" } else { "⏳" };
                                                summary.push_str(&format!("- {} **{}** (ID: {})\n", icon, t.title, t.id));
                                            }
                                            tool_results_text.push(summary.trim_end().to_string());
                                        }
                                    }
                                    Err(err) => {
                                        tool_results_text.push(format!("> ⚠️ **Error consultando tareas**: {}", err));
                                    }
                                }
                            }
                            "add_category" => {
                                let name_raw = func
                                    .arguments
                                    .get("name")
                                    .or_else(|| func.arguments.get("nombre"))
                                    .or_else(|| func.arguments.get("title"))
                                    .and_then(|v| v.as_str())
                                    .unwrap_or_default();
                                let mut module_raw = func
                                    .arguments
                                    .get("module_type")
                                    .or_else(|| func.arguments.get("module"))
                                    .or_else(|| func.arguments.get("tipo"))
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("tasks")
                                    .to_lowercase();

                                if module_raw.contains("task") || module_raw.contains("tarea") {
                                    module_raw = "tasks".to_string();
                                } else if module_raw.contains("sched") || module_raw.contains("horario") || module_raw.contains("rutina") {
                                    module_raw = "schedules".to_string();
                                } else if module_raw.contains("cal") || module_raw.contains("cita") || module_raw.contains("evento") {
                                    module_raw = "calendars".to_string();
                                }

                                if name_raw.trim().is_empty() {
                                    tool_results_text.push("> ⚠️ **Categorías**: Nombre de categoría vacío.".to_string());
                                } else {
                                    match crate::db::db_add_category(name_raw, &module_raw) {
                                        Ok(id) => {
                                            if let Some(app) = app {
                                                let _ = app.emit("refresh-categories", &module_raw);
                                                let _ = app.emit_to("main", "refresh-categories", &module_raw);
                                            }
                                            let label = match module_raw.as_str() {
                                                "tasks" => "Tareas",
                                                "schedules" => "Horarios",
                                                "calendars" => "Calendario",
                                                _ => &module_raw,
                                            };
                                            tool_results_text.push(format!(
                                                "> 📁 **Carpeta creada con éxito (#{})**: **\"{}\"** en el módulo **{}**",
                                                id, name_raw, label
                                            ));
                                        }
                                        Err(err) => {
                                            tool_results_text.push(format!("> ⚠️ **Error al crear la categoría**: {}", err));
                                        }
                                    }
                                }
                            }
                            "add_note" => {
                                let title_raw = func
                                    .arguments
                                    .get("title")
                                    .or_else(|| func.arguments.get("titulo"))
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("Nota Rápida");
                                let content_raw = func
                                    .arguments
                                    .get("content")
                                    .or_else(|| func.arguments.get("contenido"))
                                    .or_else(|| func.arguments.get("texto"))
                                    .and_then(|v| v.as_str())
                                    .unwrap_or_default();

                                if content_raw.trim().is_empty() {
                                    tool_results_text.push("> ⚠️ **Notas**: El contenido de la nota no puede estar vacío.".to_string());
                                } else {
                                    match crate::db::db_add_note(title_raw, content_raw) {
                                        Ok(id) => {
                                            if let Some(app) = app {
                                                let _ = app.emit("refresh-notes", ());
                                                let _ = app.emit_to("main", "refresh-notes", ());
                                            }
                                            tool_results_text.push(format!(
                                                "> 📝 **Nota rápida guardada (#{})**: **\"{}\"**\n> {}",
                                                id, title_raw, content_raw
                                            ));
                                        }
                                        Err(err) => {
                                            tool_results_text.push(format!("> ⚠️ **Error al guardar la nota**: {}", err));
                                        }
                                    }
                                }
                            }
                            "add_schedule" => {
                                let day_of_week_raw = func
                                    .arguments
                                    .get("day_of_week")
                                    .or_else(|| func.arguments.get("dia"))
                                    .or_else(|| func.arguments.get("day"))
                                    .and_then(|v| v.as_str())
                                    .unwrap_or_default();
                                let block_name_raw = func
                                    .arguments
                                    .get("block_name")
                                    .or_else(|| func.arguments.get("nombre"))
                                    .or_else(|| func.arguments.get("title"))
                                    .or_else(|| func.arguments.get("name"))
                                    .and_then(|v| v.as_str())
                                    .unwrap_or_default();
                                let start_time_raw = func
                                    .arguments
                                    .get("start_time")
                                    .or_else(|| func.arguments.get("inicio"))
                                    .or_else(|| func.arguments.get("start"))
                                    .and_then(|v| v.as_str())
                                    .unwrap_or_default();
                                let end_time_raw = func
                                    .arguments
                                    .get("end_time")
                                    .or_else(|| func.arguments.get("fin"))
                                    .or_else(|| func.arguments.get("end"))
                                    .and_then(|v| v.as_str())
                                    .unwrap_or_default();

                                let day_of_week = if day_of_week_raw.trim().is_empty() || day_of_week_raw == "hoy" {
                                    weekday_es.to_lowercase()
                                } else {
                                    day_of_week_raw.trim().to_lowercase()
                                };
                                let block_name = if block_name_raw.trim().is_empty() {
                                    input_trimmed.to_string()
                                } else {
                                    block_name_raw.trim().to_string()
                                };
                                let mut start_time = start_time_raw.trim().to_string();
                                if start_time.is_empty() {
                                    start_time = "10:00".to_string();
                                }
                                let mut end_time = end_time_raw.trim().to_string();
                                if end_time.is_empty() {
                                    end_time = "11:00".to_string();
                                }

                                eprintln!("[Router] Ejecutando INSERT INTO schedules en SQLite: '{}' ({}) de {} a {}", block_name, day_of_week, start_time, end_time);
                                match crate::db::db_add_schedule(&day_of_week, &block_name, &start_time, &end_time, None) {
                                    Ok(id) => {
                                        if let Some(app) = app {
                                            let _ = app.emit("refresh-schedules", ());
                                            let _ = app.emit_to("main", "refresh-schedules", ());
                                        }
                                        tool_results_text.push(format!(
                                            "> ⏱️ **Rutina programada con éxito (#{})**: **\"{}\"** los **{}** de `{}` a `{}`",
                                            id, block_name, day_of_week, start_time, end_time
                                        ));
                                    }
                                    Err(err) => {
                                        tool_results_text.push(format!("> ⚠️ **Error insertando rutina en SQLite**: {}", err));
                                    }
                                }
                            }
                            "get_schedules" => {
                                eprintln!("[Router] Consultando rutinas y bloques horarios en SQLite...");
                                match crate::db::db_get_schedules() {
                                    Ok(scheds) => {
                                        if scheds.is_empty() {
                                            tool_results_text.push("> ⏱️ **Horarios**: No tienes ninguna rutina ni bloque horario registrado en SQLite.".to_string());
                                        } else {
                                            let mut summary = format!("> ⏱️ **Horarios**: Tienes **{} bloque(s) horario(s)** registrados:\n\n", scheds.len());
                                            for sc in scheds.iter().take(8) {
                                                summary.push_str(&format!(
                                                    "- **{}** | Día: `{}` de `{}` a `{}`\n",
                                                    sc.block_name, sc.day_of_week, sc.start_time, sc.end_time
                                                ));
                                            }
                                            tool_results_text.push(summary.trim_end().to_string());
                                        }
                                    }
                                    Err(err) => {
                                        tool_results_text.push(format!("> ⚠️ **Error consultando horarios**: {}", err));
                                    }
                                }
                            }
                            "type_text" => {
                                let text = func
                                    .arguments
                                    .get("text")
                                    .or_else(|| func.arguments.get("texto"))
                                    .and_then(|v| v.as_str())
                                    .unwrap_or_default();
                                if !text.is_empty() {
                                    match crate::system_control::type_text(text.to_string()) {
                                        Ok(_) => {
                                            tool_results_text.push(format!("> ⌨️ **Texto escrito**: *\"{}\"*", text));
                                        }
                                        Err(err) => {
                                            tool_results_text.push(format!("> ⚠️ **Error escribiendo texto**: {}", err));
                                        }
                                    }
                                }
                            }
                            "press_key" => {
                                let key = func
                                    .arguments
                                    .get("key")
                                    .or_else(|| func.arguments.get("tecla"))
                                    .and_then(|v| v.as_str())
                                    .unwrap_or_default();
                                if !key.is_empty() {
                                    match crate::system_control::press_key(key.to_string()) {
                                        Ok(_) => {
                                            tool_results_text.push(format!("> ⌨️ **Tecla pulsada**: `{}`", key));
                                        }
                                        Err(err) => {
                                            tool_results_text.push(format!("> ⚠️ **Error pulsando tecla `{}`**: {}", key, err));
                                        }
                                    }
                                }
                            }
                            "move_mouse" => {
                                let x = func.arguments.get("x").and_then(|v| v.as_i64()).unwrap_or(0) as i32;
                                let y = func.arguments.get("y").and_then(|v| v.as_i64()).unwrap_or(0) as i32;
                                match crate::system_control::move_mouse(x, y) {
                                    Ok(_) => {
                                        tool_results_text.push(format!("> 🖱️ **Ratón movido a**: `({}, {})`", x, y));
                                    }
                                    Err(err) => {
                                        tool_results_text.push(format!("> ⚠️ **Error moviendo ratón**: {}", err));
                                    }
                                }
                            }
                            "mouse_click" => {
                                let btn = func.arguments.get("button").and_then(|v| v.as_str()).unwrap_or("left");
                                match crate::system_control::mouse_click(btn.to_string()) {
                                    Ok(_) => {
                                        tool_results_text.push(format!("> 🖱️ **Clic de ratón realizado**: `{}`", btn));
                                    }
                                    Err(err) => {
                                        tool_results_text.push(format!("> ⚠️ **Error en clic de ratón**: {}", err));
                                    }
                                }
                            }
                            "send_whatsapp" => {
                                let contact_raw = func
                                    .arguments
                                    .get("contact_name")
                                    .or_else(|| func.arguments.get("contact"))
                                    .or_else(|| func.arguments.get("number"))
                                    .and_then(|v| v.as_str())
                                    .unwrap_or_default();
                                let message_raw = func
                                    .arguments
                                    .get("message")
                                    .or_else(|| func.arguments.get("text"))
                                    .and_then(|v| v.as_str())
                                    .unwrap_or_default();

                                let contact_trimmed = contact_raw.trim();
                                let msg_trimmed = message_raw.trim();

                                if contact_trimmed.is_empty() || msg_trimmed.is_empty() {
                                    tool_results_text.push("> ⚠️ **WhatsApp**: Contacto o mensaje vacío.".to_string());
                                } else {
                                    eprintln!("[Router] Intentando enviar WhatsApp a '{}' mensaje: '{}'", contact_trimmed, msg_trimmed);
                                    let resolution = crate::db::db_find_whatsapp_contact_by_name(contact_trimmed);
                                    match resolution {
                                        Some((jid, resolved_name)) => {
                                            match crate::whatsapp_bridge::send_whatsapp_http(&jid, msg_trimmed).await {
                                                Ok(_) => {
                                                    if let Some(app) = app {
                                                        let _ = app.emit("whatsapp-sent", serde_json::json!({
                                                             "contact": resolved_name,
                                                             "jid": jid,
                                                             "message": msg_trimmed,
                                                             "success": true
                                                        }));
                                                    }
                                                    tool_results_text.push(format!(
                                                        "> 📱 **WhatsApp enviado a {}** (`{}`): *\"{}\"*",
                                                        resolved_name, jid, msg_trimmed
                                                    ));
                                                }
                                                Err(err) => {
                                                    let is_unconnected = err.contains("no está conectado") || err.contains("503") || err.contains("QR");
                                                    let hint = if is_unconnected {
                                                        "WhatsApp no está vinculado. Por favor, abre el menú de Enigma y escanea el código QR."
                                                    } else {
                                                        &err
                                                    };
                                                    tool_results_text.push(format!(
                                                        "> ⚠️ **Error enviando WhatsApp a {}**: {}",
                                                        resolved_name, hint
                                                    ));
                                                }
                                            }
                                        }
                                        None => {
                                            let digits: String = contact_trimmed.chars().filter(|c| c.is_ascii_digit()).collect();
                                            if digits.len() >= 8 {
                                                let jid = if digits.ends_with("@s.whatsapp.net") {
                                                    digits
                                                } else {
                                                    format!("{}@s.whatsapp.net", digits)
                                                };
                                                match crate::whatsapp_bridge::send_whatsapp_http(&jid, msg_trimmed).await {
                                                    Ok(_) => {
                                                        if let Some(app) = app {
                                                            let _ = app.emit("whatsapp-sent", serde_json::json!({
                                                                "contact": contact_trimmed,
                                                                "jid": jid,
                                                                "message": msg_trimmed,
                                                                "success": true
                                                            }));
                                                        }
                                                        tool_results_text.push(format!(
                                                            "> 📱 **WhatsApp enviado al número {}**: *\"{}\"*",
                                                            contact_trimmed, msg_trimmed
                                                        ));
                                                    }
                                                    Err(err) => {
                                                        tool_results_text.push(format!(
                                                            "> ⚠️ **Error enviando WhatsApp**: {}",
                                                            err
                                                        ));
                                                    }
                                                }
                                            } else {
                                                tool_results_text.push(format!(
                                                    "> ⚠️ **Contacto no encontrado**: No se encontró a \"{}\" en tu lista de contactos de WhatsApp. Asegúrate de tenerlo guardado o sincronizar contactos en Extensiones.",
                                                    contact_trimmed
                                                ));
                                            }
                                        }
                                    }
                                }
                            }
                            "read_emails" => {
                                let limit = func
                                    .arguments
                                    .get("max_results")
                                    .and_then(|v| v.as_u64())
                                    .unwrap_or(5) as u32;

                                eprintln!("[Router] Consultando correos recientes de Gmail (límite: {})...", limit);
                                match crate::google_auth::fetch_recent_emails(limit).await {
                                    Ok(emails) => {
                                        if let Some(app) = app {
                                            let _ = app.emit("gmail-emails-fetched", &emails);
                                        }
                                        if emails.is_empty() {
                                            tool_results_text.push(
                                                "> ✉️ **Gmail**: Tu bandeja de entrada está al día, no hay correos recientes.".to_string()
                                            );
                                        } else {
                                            let mut summary = format!("> ✉️ **Gmail**: He recuperado **{} correos recientes**:\n\n", emails.len());
                                            for em in emails.iter().take(5) {
                                                let sender_clean = em.from.replace('<', "(").replace('>', ")");
                                                summary.push_str(&format!(
                                                    "- **De**: {}\n  **Asunto**: {}\n  **Fecha**: {}\n  > {}\n\n",
                                                    sender_clean, em.subject, em.date, em.snippet
                                                ));
                                            }
                                            tool_results_text.push(summary.trim_end().to_string());
                                        }
                                    }
                                    Err(err) => {
                                        let is_unauthed = err.contains("No hay cuenta de Google vinculada") || err.contains("401") || err.contains("re-autenticar");
                                        if is_unauthed {
                                            tool_results_text.push(
                                                "> ⚠️ **Google Workspace no vinculado**: Para leer tus correos de Gmail, por favor conecta tu cuenta de Google en la pestaña **Extensiones** de Enigma introduciendo tu Client ID y Secret.".to_string()
                                            );
                                        } else {
                                            tool_results_text.push(format!("> ⚠️ **Error consultando Gmail**: {}", err));
                                        }
                                    }
                                }
                            }
                            "open_url" => {
                                let url = func
                                    .arguments
                                    .get("url")
                                    .and_then(|u| u.as_str())
                                    .unwrap_or_default();
                                eprintln!("[Router] Abriendo URL en navegador Opera: '{}'", url);
                                let exec_res = crate::system_control::open_url(url.to_string());
                                match exec_res {
                                    Ok(_msg) => {
                                        tool_results_text.push(format!(
                                            "> 🌐 **Opera**: `{}`",
                                            url
                                        ));
                                    }
                                    Err(err) => {
                                        tool_results_text.push(format!(
                                            "> ⚠️ **Error abriendo URL `{}`**: {}",
                                            url, err
                                        ));
                                    }
                                }
                            }
                            "run_terminal" => {
                                let cmd = func
                                    .arguments
                                    .get("command")
                                    .and_then(|c| c.as_str())
                                    .unwrap_or_default();
                                let cmd_trimmed = cmd.trim();

                                if cmd_trimmed == "mail" || cmd_trimmed.starts_with("mail ") {
                                    eprintln!("[Router] Redirigiendo comando terminal 'mail' a read_emails de Google Workspace");
                                    match crate::google_auth::fetch_recent_emails(5).await {
                                        Ok(emails) => {
                                            if let Some(app) = app {
                                                let _ = app.emit("gmail-emails-fetched", &emails);
                                            }
                                            if emails.is_empty() {
                                                tool_results_text.push(
                                                    "> ✉️ **Gmail**: Tu bandeja de entrada está al día, no hay correos recientes.".to_string()
                                                );
                                            } else {
                                                let mut summary = format!("> ✉️ **Gmail**: He recuperado **{} correos recientes**:\n\n", emails.len());
                                                for em in emails.iter().take(5) {
                                                    let sender_clean = em.from.replace('<', "(").replace('>', ")");
                                                    summary.push_str(&format!(
                                                        "- **De**: {}\n  **Asunto**: {}\n  **Fecha**: {}\n  > {}\n\n",
                                                        sender_clean, em.subject, em.date, em.snippet
                                                    ));
                                                }
                                                tool_results_text.push(summary.trim_end().to_string());
                                            }
                                        }
                                        Err(err) => {
                                            tool_results_text.push(format!("> ⚠️ **Error consultando Gmail**: {}", err));
                                        }
                                    }
                                } else if cmd_trimmed.contains("calcurse")
                                    || cmd_trimmed.contains("calcurg")
                                    || cmd_trimmed.starts_with("cal -")
                                    || cmd_trimmed.starts_with("calcur")
                                {
                                    eprintln!("[Router] Interceptando intento de comando CLI de calendario '{}' y redirigiendo a SQLite add_event", cmd_trimmed);
                                    let (parsed_title, parsed_time) = extract_calendar_info_from_calcurse(cmd_trimmed, input_trimmed);
                                    match crate::db::db_add_calendar_event(&parsed_title, &current_date, &parsed_time, 15, None) {
                                        Ok(id) => {
                                            if let Some(app) = app {
                                                let _ = app.emit("refresh-calendar", ());
                                                let _ = app.emit_to("main", "refresh-calendar", ());
                                            }
                                            tool_results_text.push(format!(
                                                "> 📅 **Cita programada con éxito (#{})**: **\"{}\"** para el **{}** a las **{}** (aviso 15 min antes)",
                                                id, parsed_title, current_date, parsed_time
                                            ));
                                        }
                                        Err(err) => {
                                            tool_results_text.push(format!("> ⚠️ **Error guardando cita**: {}", err));
                                        }
                                    }
                                } else {
                                    eprintln!("[Router] Ejecutando comando en terminal: '{}'", cmd);
                                    let exec_res = crate::system_control::run_terminal(cmd.to_string());
                                    match exec_res {
                                        Ok(output) => {
                                            tool_results_text.push(format!(
                                                "> 💻 **Comando ejecutado**: `{}`\n```bash\n{}\n```",
                                                cmd,
                                                output.trim()
                                            ));
                                        }
                                        Err(err) => {
                                            tool_results_text.push(format!(
                                                "> ⚠️ **Error en comando `{}`**: {}",
                                                cmd,
                                                err.trim()
                                            ));
                                        }
                                    }
                                }
                            }
                            "open_app" => {
                                let mut app_name = func
                                    .arguments
                                    .get("app_name")
                                    .or_else(|| func.arguments.get("name"))
                                    .or_else(|| func.arguments.get("app"))
                                    .or_else(|| func.arguments.get("application"))
                                    .or_else(|| func.arguments.get("target"))
                                    .and_then(|a| a.as_str())
                                    .unwrap_or_default()
                                    .trim()
                                    .to_string();

                                if app_name.is_empty() {
                                    let lower = input_trimmed.to_lowercase();
                                    if let Some(idx) = lower.find("abre ") {
                                        app_name = input_trimmed[idx + 5..].trim().to_string();
                                    } else if let Some(idx) = lower.find("abrir ") {
                                        app_name = input_trimmed[idx + 6..].trim().to_string();
                                    }
                                }

                                eprintln!("[Router] Abriendo aplicación: '{}'", app_name);
                                let exec_res = crate::system_control::open_app(app_name.clone());
                                match exec_res {
                                    Ok(()) => {
                                        tool_results_text.push(format!(
                                            "> 🚀 **Aplicación abierta**: `{}`",
                                            app_name
                                        ));
                                    }
                                    Err(err) => {
                                        tool_results_text.push(format!(
                                            "> ⚠️ **Error abriendo `{}`**: {}",
                                            app_name, err
                                        ));
                                    }
                                }
                            }
                            "close_app" => {
                                let mut app_name = func
                                    .arguments
                                    .get("app_name")
                                    .or_else(|| func.arguments.get("name"))
                                    .or_else(|| func.arguments.get("app"))
                                    .or_else(|| func.arguments.get("application"))
                                    .or_else(|| func.arguments.get("target"))
                                    .and_then(|a| a.as_str())
                                    .unwrap_or_default()
                                    .trim()
                                    .to_string();

                                if app_name.is_empty() {
                                    let lower = input_trimmed.to_lowercase();
                                    if let Some(idx) = lower.find("cierra ") {
                                        app_name = input_trimmed[idx + 7..].trim().to_string();
                                    } else if let Some(idx) = lower.find("cerrar ") {
                                        app_name = input_trimmed[idx + 7..].trim().to_string();
                                    }
                                }

                                eprintln!("[Router] Cerrando aplicación: '{}'", app_name);
                                let exec_res = crate::system_control::close_app(app_name.clone());
                                match exec_res {
                                    Ok(()) => {
                                        tool_results_text.push(format!(
                                            "> 🛑 **Aplicación cerrada**: `{}`",
                                            app_name
                                        ));
                                    }
                                    Err(err) => {
                                        tool_results_text.push(format!(
                                            "> ⚠️ **Error cerrando `{}`**: {}",
                                            app_name, err
                                        ));
                                    }
                                }
                            }
                            "search_web" => {
                                let q = func
                                    .arguments
                                    .get("query")
                                    .and_then(|q| q.as_str())
                                    .unwrap_or_default();
                                eprintln!("[Router] Buscando en navegador: '{}'", q);
                                let _ = crate::enigma::execute_browser_search(q);
                                tool_results_text.push(format!(
                                    "> 🌐 **Navegador**: He buscado **\"{}\"** en Google en tu navegador Opera.",
                                    q
                                ));
                            }
                            "analyze_image" => {
                                let img_path = func
                                    .arguments
                                    .get("image_path")
                                    .or_else(|| func.arguments.get("path"))
                                    .or_else(|| func.arguments.get("imagen"))
                                    .and_then(|v| v.as_str())
                                    .unwrap_or_default();
                                let prompt_query = func
                                    .arguments
                                    .get("prompt")
                                    .or_else(|| func.arguments.get("pregunta"))
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("Describe esta imagen detalladamente");

                                eprintln!("[Router] Analizando imagen con llava: '{}' (prompt: '{}')", img_path, prompt_query);
                                match crate::vision::analyze_image(img_path.to_string(), prompt_query.to_string()).await {
                                    Ok(analysis) => {
                                        tool_results_text.push(format!(
                                            "> 👁️ **Visión Multimodal (llava)**:\n{}",
                                            analysis.trim()
                                        ));
                                    }
                                    Err(err) => {
                                        tool_results_text.push(format!(
                                            "> ⚠️ **Error analizando imagen**: {}",
                                            err
                                        ));
                                    }
                                }
                            }
                            "send_telegram_alert" => {
                                let msg = func
                                    .arguments
                                    .get("message")
                                    .or_else(|| func.arguments.get("mensaje"))
                                    .or_else(|| func.arguments.get("texto"))
                                    .or_else(|| func.arguments.get("text"))
                                    .and_then(|v| v.as_str())
                                    .unwrap_or_default();

                                eprintln!("[Router] Enviando alerta a Telegram: '{}'", msg);
                                match crate::messenger_bridge::send_telegram_alert(msg).await {
                                    Ok(res_str) => {
                                        tool_results_text.push(format!(
                                            "> 📱 **Telegram Bot**: {}",
                                            res_str
                                        ));
                                    }
                                    Err(err) => {
                                        tool_results_text.push(format!(
                                            "> ⚠️ **Error enviando alerta por Telegram**: {}",
                                            err
                                        ));
                                    }
                                }
                            }
                            "analyze_current_screen" => {
                                let prompt_query = func
                                    .arguments
                                    .get("prompt")
                                    .or_else(|| func.arguments.get("consulta"))
                                    .or_else(|| func.arguments.get("pregunta"))
                                    .or_else(|| func.arguments.get("query"))
                                    .and_then(|v| v.as_str())
                                    .unwrap_or(input_trimmed);

                                let target_mode = func
                                    .arguments
                                    .get("target")
                                    .or_else(|| func.arguments.get("mode"))
                                    .and_then(|v| v.as_str())
                                    .map(|s| s.to_string())
                                    .or_else(|| {
                                        let l = prompt_query.to_lowercase();
                                        if l.contains("ventana") || l.contains("código") || l.contains("codigo") || l.contains("programando") || l.contains("terminal") || l.contains("ide") {
                                            Some("active_window".to_string())
                                        } else {
                                            Some("screen".to_string())
                                        }
                                    });

                                eprintln!("[Router] Capturando pantalla y analizando con visión (prompt: '{}', mode: {:?})", prompt_query, target_mode);
                                match crate::vision::analyze_current_screen(Some(prompt_query.to_string()), target_mode).await {
                                    Ok(res) => {
                                        let win_badge = if !res.window_title.is_empty() {
                                            format!(" • Ventana: `{}`", res.window_title)
                                        } else {
                                            String::new()
                                        };
                                        let img_ref = if !res.image_path.is_empty() {
                                            res.image_path
                                        } else {
                                            res.thumbnail_data_url
                                        };
                                        tool_results_text.push(format!(
                                            "> 👁️ **Enigma Vision (Modelo: `{}`{})**:\n![Captura de {}]({})\n\n{}",
                                            res.model_used,
                                            win_badge,
                                            if res.target_mode == "active_window" { "Ventana Activa" } else { "Pantalla Completa" },
                                            img_ref,
                                            res.analysis.trim()
                                        ));
                                        executed_tools.push("analyze_current_screen".to_string());
                                    }
                                    Err(err) => {
                                        tool_results_text.push(format!(
                                            "> ⚠️ **Error analizando pantalla**: {}",
                                            err
                                        ));
                                    }
                                }
                            }
                            "generate_image" => {
                                let img_prompt = func
                                    .arguments
                                    .get("prompt")
                                    .or_else(|| func.arguments.get("description"))
                                    .or_else(|| func.arguments.get("descripcion"))
                                    .or_else(|| func.arguments.get("text"))
                                    .and_then(|v| v.as_str())
                                    .unwrap_or(input_trimmed);

                                eprintln!("[Router] Generando imagen con Stable Diffusion (prompt: '{}')", img_prompt);
                                match crate::creative::generate_image(img_prompt.to_string()).await {
                                    Ok(image_path) => {
                                        tool_results_text.push(format!(
                                            "> 🎨 **Imagen generada con éxito con Stable Diffusion**:\n\n![Generated Image]({})\n\n`Ruta: {}`",
                                            image_path,
                                            image_path
                                        ));
                                        executed_tools.push("generate_image".to_string());
                                    }
                                    Err(err) => {
                                        tool_results_text.push(format!(
                                            "> ⚠️ **Error generando imagen**: {}",
                                            err
                                        ));
                                    }
                                }
                            }
                            "read_local_file" => {
                                let path = func
                                    .arguments
                                    .get("path")
                                    .or_else(|| func.arguments.get("file"))
                                    .or_else(|| func.arguments.get("archivo"))
                                    .or_else(|| func.arguments.get("ruta"))
                                    .and_then(|v| v.as_str())
                                    .unwrap_or_default();

                                eprintln!("[Router] Leyendo archivo local con OS Skills: '{}'", path);
                                match crate::os_skills::read_local_file(path) {
                                    Ok(file_content) => {
                                        tool_results_text.push(format!(
                                            "> 📄 **Archivo leído (`{}`)**:\n```\n{}\n```",
                                            path,
                                            file_content.trim()
                                        ));
                                        executed_tools.push("read_local_file".to_string());
                                    }
                                    Err(err) => {
                                        tool_results_text.push(format!(
                                            "> ⚠️ **Error leyendo archivo `{}`**: {}",
                                            path, err
                                        ));
                                    }
                                }
                            }
                            "execute_terminal_command" => {
                                let cmd = func
                                    .arguments
                                    .get("command")
                                    .or_else(|| func.arguments.get("comando"))
                                    .or_else(|| func.arguments.get("cmd"))
                                    .and_then(|v| v.as_str())
                                    .unwrap_or_default();

                                eprintln!("[Router] Ejecutando comando seguro en terminal con OS Skills: '{}'", cmd);
                                match crate::os_skills::execute_terminal_command(cmd) {
                                    Ok(output) => {
                                        tool_results_text.push(format!(
                                            "> 💻 **Terminal Bash (`{}`)**:\n```bash\n{}\n```",
                                            cmd,
                                            output.trim()
                                        ));
                                        executed_tools.push("execute_terminal_command".to_string());
                                    }
                                    Err(err) => {
                                        tool_results_text.push(format!(
                                            "> ⚠️ **Error en terminal**: {}",
                                            err
                                        ));
                                    }
                                }
                            }
                            "read_clipboard" => {
                                eprintln!("[Router] Leyendo portapapeles del sistema...");
                                match crate::clipboard::get_clipboard_content() {
                                    Ok(content) => {
                                        if content.trim().is_empty() {
                                            tool_results_text.push("> 📋 **Portapapeles**: El portapapeles del sistema está vacío.".to_string());
                                        } else {
                                            let preview = if content.chars().count() > 4000 {
                                                format!("{}... [Truncado]", content.chars().take(4000).collect::<String>())
                                            } else {
                                                content.clone()
                                            };
                                            tool_results_text.push(format!(
                                                "> 📋 **Contenido leído del Portapapeles**:\n```\n{}\n```",
                                                preview.trim()
                                            ));
                                        }
                                        executed_tools.push("read_clipboard".to_string());
                                    }
                                    Err(err) => {
                                        tool_results_text.push(format!(
                                            "> ⚠️ **Error leyendo portapapeles**: {}",
                                            err
                                        ));
                                    }
                                }
                            }
                            "copy_to_clipboard" => {
                                let text = func
                                    .arguments
                                    .get("text")
                                    .or_else(|| func.arguments.get("content"))
                                    .or_else(|| func.arguments.get("texto"))
                                    .and_then(|v| v.as_str())
                                    .unwrap_or_default();

                                eprintln!("[Router] Copiando al portapapeles del sistema ({} chars)...", text.len());
                                match crate::clipboard::copy_to_clipboard(text.to_string()) {
                                    Ok(msg) => {
                                        let preview = if text.chars().count() > 60 {
                                            let truncated: String = text.chars().take(60).collect();
                                            format!("{}...", truncated)
                                        } else {
                                            text.to_string()
                                        };
                                        tool_results_text.push(format!(
                                            "> 📋 **Copiado al portapapeles con éxito**: *\"{}\"* ({})",
                                            preview.trim(),
                                            msg
                                        ));
                                        executed_tools.push("copy_to_clipboard".to_string());
                                    }
                                    Err(err) => {
                                        tool_results_text.push(format!(
                                            "> ⚠️ **Error copiando al portapapeles**: {}",
                                            err
                                        ));
                                    }
                                }
                            }
                            "get_active_context" => {
                                eprintln!("[Router] Consultando contexto de ventana activa del escritorio...");
                                let context_summary = crate::windows::get_active_desktop_context();
                                tool_results_text.push(format!(
                                    "> 🪟 **Contexto de Escritorio y Ventana Activa**:\n{}",
                                    context_summary
                                ));
                                executed_tools.push("get_active_context".to_string());
                            }
                            "focus_window" => {
                                let app_query = func
                                    .arguments
                                    .get("app_name")
                                    .or_else(|| func.arguments.get("app"))
                                    .or_else(|| func.arguments.get("ventana"))
                                    .or_else(|| func.arguments.get("name"))
                                    .and_then(|v| v.as_str())
                                    .unwrap_or_default();

                                eprintln!("[Router] Cambiando foco a ventana: '{}'...", app_query);
                                match crate::windows::focus_app_or_window(app_query) {
                                    Ok(msg) => {
                                        tool_results_text.push(format!("> 🪟 **Ventana Enfocada**: {}", msg));
                                        executed_tools.push("focus_window".to_string());
                                    }
                                    Err(err) => {
                                        tool_results_text.push(format!("> ⚠️ **Error cambiando a ventana**: {}", err));
                                    }
                                }
                            }
                            "get_media_status" => {
                                eprintln!("[Router] Consultando estado multimedia vía MPRIS DBus...");
                                match crate::connectivities::get_active_media_status() {
                                    Ok(status) => {
                                        tool_results_text.push(format!("> 🎵 **Estado Multimedia**:\n{}", status));
                                        executed_tools.push("get_media_status".to_string());
                                    }
                                    Err(err) => {
                                        tool_results_text.push(format!("> 🎵 **Multimedia**: {}", err));
                                    }
                                }
                            }
                            "control_media_player" => {
                                let action = func
                                    .arguments
                                    .get("action")
                                    .or_else(|| func.arguments.get("command"))
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("PlayPause");
                                let player = func
                                    .arguments
                                    .get("player")
                                    .and_then(|v| v.as_str());
                                eprintln!("[Router] Control multimedia MPRIS: accion='{}', reproductor={:?}", action, player);
                                match crate::connectivities::control_media_player(action, player) {
                                    Ok(msg) => {
                                        tool_results_text.push(format!("> ⏯️ **Control Multimedia**: {}", msg));
                                        executed_tools.push("control_media_player".to_string());
                                    }
                                    Err(err) => {
                                        tool_results_text.push(format!("> ⚠️ **Error control multimedia**: {}", err));
                                    }
                                }
                            }
                            "adjust_system_volume" => {
                                let change = func
                                    .arguments
                                    .get("change")
                                    .or_else(|| func.arguments.get("volume"))
                                    .or_else(|| func.arguments.get("level"))
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("+5%");
                                eprintln!("[Router] Ajustando volumen del sistema: '{}'", change);
                                match crate::connectivities::adjust_system_volume(change) {
                                    Ok(msg) => {
                                        tool_results_text.push(format!("> 🔊 **Volumen del Sistema**: {}", msg));
                                        executed_tools.push("adjust_system_volume".to_string());
                                    }
                                    Err(err) => {
                                        tool_results_text.push(format!("> ⚠️ **Error ajustando volumen**: {}", err));
                                    }
                                }
                            }
                            "search_web_duckduckgo" => {
                                let query = func
                                    .arguments
                                    .get("query")
                                    .or_else(|| func.arguments.get("q"))
                                    .or_else(|| func.arguments.get("search"))
                                    .and_then(|v| v.as_str())
                                    .unwrap_or_default();
                                eprintln!("[Router] Búsqueda web DuckDuckGo en tiempo real: '{}'", query);
                                match crate::connectivities::search_web_duckduckgo(query).await {
                                    Ok(results) => {
                                        let mut formatted = format!("> 🔍 **Resultados de Búsqueda Web (DuckDuckGo)** ({} resultados):\n", results.len());
                                        for res in results {
                                            formatted.push_str(&format!("\n- **[{}]({})**\n  > {}\n", res.title, res.url, res.snippet));
                                        }
                                        tool_results_text.push(formatted);
                                        executed_tools.push("search_web_duckduckgo".to_string());
                                    }
                                    Err(err) => {
                                        tool_results_text.push(format!("> ⚠️ **Error en búsqueda web**: {}", err));
                                    }
                                }
                            }
                            "send_desktop_notification" => {
                                let title = func
                                    .arguments
                                    .get("title")
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("Enigma");
                                let message = func
                                    .arguments
                                    .get("message")
                                    .or_else(|| func.arguments.get("body"))
                                    .or_else(|| func.arguments.get("text"))
                                    .and_then(|v| v.as_str())
                                    .unwrap_or_default();
                                let urgency = func
                                    .arguments
                                    .get("urgency")
                                    .and_then(|v| v.as_str());
                                eprintln!("[Router] Enviando notificación de escritorio: title='{}', msg='{}'", title, message);
                                match crate::connectivities::send_desktop_notification(title, message, urgency) {
                                    Ok(_) => {
                                        tool_results_text.push(format!("> 🔔 **Notificación enviada con éxito**: *\"{}\"*", title));
                                        executed_tools.push("send_desktop_notification".to_string());
                                    }
                                    Err(err) => {
                                        tool_results_text.push(format!("> ⚠️ **Error enviando notificación**: {}", err));
                                    }
                                }
                            }
                            _ => {}
                        }
                    }

            // Fallback URL: Si el usuario pidió abrir una URL/web y no se invocó herramienta
            if executed_tools.is_empty() {
                let lower = input_trimmed.to_lowercase();
                if lower.contains("youtube") && (lower.contains("abre") || lower.contains("abrir") || lower.contains("entra")) {
                    let _ = crate::system_control::open_url("https://www.youtube.com".to_string());
                    tool_results_text.push("> 🌐 **Navegador**: Abriendo YouTube en Opera...".to_string());
                    executed_tools.push("open_url".to_string());
                } else if lower.contains("google") && (lower.contains("abre") || lower.contains("abrir") || lower.contains("entra")) {
                    let _ = crate::system_control::open_url("https://www.google.com".to_string());
                    tool_results_text.push("> 🌐 **Navegador**: Abriendo Google en Opera...".to_string());
                    executed_tools.push("open_url".to_string());
                } else if lower.contains("github") && (lower.contains("abre") || lower.contains("abrir") || lower.contains("entra")) {
                    let _ = crate::system_control::open_url("https://github.com".to_string());
                    tool_results_text.push("> 🌐 **Navegador**: Abriendo GitHub en Opera...".to_string());
                    executed_tools.push("open_url".to_string());
                }
            }

            // Fallback 1: Si no se ejecutaron herramientas pero el usuario pidió explícitamente leer emails
            if executed_tools.is_empty() && is_read_gmail_intent(input_trimmed) {
                eprintln!("[Router] Fallback: Ejecutando lectura de Gmail para intent detectado en prompt");
                match crate::google_auth::fetch_recent_emails(5).await {
                    Ok(emails) => {
                        if let Some(app) = app {
                            let _ = app.emit("gmail-emails-fetched", &emails);
                        }
                        if emails.is_empty() {
                            tool_results_text.push("> ✉️ **Gmail**: Tu bandeja de entrada está al día, no hay correos recientes.".to_string());
                        } else {
                            let mut summary = format!("> ✉️ **Gmail**: He recuperado **{} correos recientes**:\n\n", emails.len());
                            for em in emails.iter().take(5) {
                                let sender_clean = em.from.replace('<', "(").replace('>', ")");
                                summary.push_str(&format!(
                                    "- **De**: {}\n  **Asunto**: {}\n  **Fecha**: {}\n  > {}\n\n",
                                    sender_clean, em.subject, em.date, em.snippet
                                ));
                            }
                            tool_results_text.push(summary.trim_end().to_string());
                        }
                        executed_tools.push("read_emails".to_string());
                    }
                    Err(err) => {
                        tool_results_text.push(format!("> ⚠️ **Error consultando Gmail**: {}", err));
                    }
                }
            }

            // Fallback 2: Si no se ejecutaron herramientas pero el usuario pidió enviar un mensaje
            if executed_tools.is_empty() {
                if let Some((contact, message)) = extract_whatsapp_intent_fallback(input_trimmed) {
                    eprintln!("[Router] Fallback: Intentando enviar WhatsApp a '{}': '{}'", contact, message);
                    if let Some((jid, resolved_name)) = crate::db::db_find_whatsapp_contact_by_name(&contact) {
                        match crate::whatsapp_bridge::send_whatsapp_http(&jid, &message).await {
                            Ok(_) => {
                                if let Some(app) = app {
                                    let _ = app.emit("whatsapp-sent", serde_json::json!({
                                        "contact": resolved_name,
                                        "jid": jid,
                                        "message": message,
                                        "success": true
                                    }));
                                }
                                tool_results_text.push(format!(
                                    "> 📱 **WhatsApp enviado a {}** (`{}`): *\"{}\"*",
                                    resolved_name, jid, message
                                ));
                                executed_tools.push("send_whatsapp".to_string());
                            }
                            Err(err) => {
                                tool_results_text.push(format!("> ⚠️ **Error enviando WhatsApp**: {}", err));
                            }
                        }
                    }
                }
            }

            // Fallback 3: Calendario / Citas (Crear evento si el usuario pidió una cita pero no se invocó herramienta)
            if executed_tools.is_empty() {
                if let Some((title, date, time)) = extract_calendar_intent_fallback(input_trimmed, &current_date) {
                    eprintln!("[Router] Fallback: Creando evento de calendario para: '{}' el {} a las {}", title, date, time);
                    match crate::db::db_add_calendar_event(&title, &date, &time, 15, None) {
                        Ok(id) => {
                            if let Some(app) = app {
                                let _ = app.emit("refresh-calendar", ());
                                let _ = app.emit_to("main", "refresh-calendar", ());
                            }
                            tool_results_text.push(format!(
                                "> 📅 **Cita programada con éxito (#{})**: **\"{}\"** para el **{}** a las **{}** (notificar 15 min antes)",
                                id, title, date, time
                            ));
                            executed_tools.push("add_event".to_string());
                        }
                        Err(err) => {
                            tool_results_text.push(format!("> ⚠️ **Error guardando cita**: {}", err));
                        }
                    }
                }
            }

            // Fallback 4: Calendario / Agenda (Consultar agenda si el usuario lo pidió)
            if executed_tools.is_empty() && is_read_agenda_intent(input_trimmed) {
                eprintln!("[Router] Fallback: Consultando agenda de calendario...");
                if let Some(app) = app {
                    let _ = app.emit("refresh-calendar", ());
                    let _ = app.emit_to("main", "refresh-calendar", ());
                }
                match crate::db::db_get_calendar_events() {
                    Ok(events) => {
                        if events.is_empty() {
                            tool_results_text.push("> 📅 **Agenda**: No tienes ningún evento programado en tu calendario.".to_string());
                        } else {
                            let mut summary = format!("> 📅 **Agenda**: Tienes **{} evento(s) en tu calendario**:\n\n", events.len());
                            for ev in events.iter().take(8) {
                                summary.push_str(&format!(
                                    "- **{}** | Fecha: `{}` a las `{}` (aviso {}m)\n",
                                    ev.title, ev.event_date, ev.event_time, ev.notify_before_mins
                                ));
                            }
                            tool_results_text.push(summary.trim_end().to_string());
                        }
                        executed_tools.push("get_calendar_events".to_string());
                    }
                    Err(err) => {
                        tool_results_text.push(format!("> ⚠️ **Error consultando calendario**: {}", err));
                    }
                }
            }

            // Fallback 5: Tareas
            if executed_tools.is_empty() {
                if let Some(task_title) = extract_task_intent_fallback(input_trimmed) {
                    eprintln!("[Router] Fallback: Añadiendo tarea: '{}'", task_title);
                    match crate::db::db_add_task(&task_title, None) {
                        Ok(id) => {
                            if let Some(app) = app {
                                let _ = app.emit("refresh-tasks", ());
                            }
                            tool_results_text.push(format!("> 📋 **Tarea añadida (#{})**: **\"{}\"**", id, task_title));
                            executed_tools.push("add_task".to_string());
                        }
                        Err(err) => {
                            tool_results_text.push(format!("> ⚠️ **Error añadiendo tarea**: {}", err));
                        }
                    }
                }
            }

            // Fallback 6: Categorías / Carpetas dinámicas
            if executed_tools.is_empty() {
                if let Some((cat_name, mod_type)) = extract_category_intent_fallback(input_trimmed) {
                    eprintln!("[Router] Fallback: Creando subcategoría '{}' en módulo '{}'", cat_name, mod_type);
                    match crate::db::db_add_category(&cat_name, &mod_type) {
                        Ok(id) => {
                            if let Some(app) = app {
                                let _ = app.emit("refresh-categories", &mod_type);
                                let _ = app.emit_to("main", "refresh-categories", &mod_type);
                            }
                            let label = match mod_type.as_str() {
                                "tasks" => "Tareas",
                                "schedules" => "Horarios",
                                "calendars" => "Calendario",
                                _ => &mod_type,
                            };
                            tool_results_text.push(format!(
                                "> 📁 **Carpeta creada con éxito (#{})**: **\"{}\"** en el módulo **{}**",
                                id, cat_name, label
                            ));
                            executed_tools.push("add_category".to_string());
                        }
                        Err(err) => {
                            tool_results_text.push(format!("> ⚠️ **Error creando carpeta**: {}", err));
                        }
                    }
                }
            }

            // Fallback 7: Notas rápidas
            if executed_tools.is_empty() {
                if let Some((title, content)) = extract_note_intent_fallback(input_trimmed) {
                    eprintln!("[Router] Fallback: Creando nota rápida: '{}'", title);
                    match crate::db::db_add_note(&title, &content) {
                        Ok(id) => {
                            if let Some(app) = app {
                                let _ = app.emit("refresh-notes", ());
                                let _ = app.emit_to("main", "refresh-notes", ());
                            }
                            tool_results_text.push(format!(
                                "> 📝 **Nota guardada (#{})**: **\"{}\"**\n> {}",
                                id, title, content
                            ));
                            executed_tools.push("add_note".to_string());
                        }
                        Err(err) => {
                            tool_results_text.push(format!("> ⚠️ **Error guardando nota**: {}", err));
                        }
                    }
                }
            }

            // Fallback 8: Rutinas y Bloques Horarios
            if executed_tools.is_empty() {
                if let Some((day, name, start, end)) = extract_schedule_intent_fallback(input_trimmed, &weekday_es) {
                    eprintln!("[Router] Fallback: Insertando rutina en SQLite: '{}' ({}) de {} a {}", name, day, start, end);
                    match crate::db::db_add_schedule(&day, &name, &start, &end, None) {
                        Ok(id) => {
                            if let Some(app) = app {
                                let _ = app.emit("refresh-schedules", ());
                                let _ = app.emit_to("main", "refresh-schedules", ());
                            }
                            tool_results_text.push(format!(
                                "> ⏱️ **Rutina programada con éxito (#{})**: **\"{}\"** los **{}** de `{}` a `{}`",
                                id, name, day, start, end
                            ));
                            executed_tools.push("add_schedule".to_string());
                        }
                        Err(err) => {
                            tool_results_text.push(format!("> ⚠️ **Error guardando rutina**: {}", err));
                        }
                    }
                }
            }

            // Fallback 9: Abrir aplicaciones locales si el LLM no emitió tool_call estructurado
            if executed_tools.is_empty() {
                let lower = input_trimmed.to_lowercase();
                let is_open_app = (lower.starts_with("abre ") || lower.starts_with("abrir ") || lower.starts_with("inicia ") || lower.starts_with("iniciar ") || lower.starts_with("lanza ") || lower.starts_with("lanzar "))
                    && !lower.contains("http") && !lower.contains(".com") && !lower.contains(".org") && !lower.contains(".es") && !lower.contains("youtube") && !lower.contains("gmail") && !lower.contains("whatsapp");

                if is_open_app {
                    let app_target = if let Some(idx) = lower.find("abre ") {
                        input_trimmed[idx + 5..].trim()
                    } else if let Some(idx) = lower.find("abrir ") {
                        input_trimmed[idx + 6..].trim()
                    } else if let Some(idx) = lower.find("inicia ") {
                        input_trimmed[idx + 7..].trim()
                    } else if let Some(idx) = lower.find("iniciar ") {
                        input_trimmed[idx + 8..].trim()
                    } else if let Some(idx) = lower.find("lanza ") {
                        input_trimmed[idx + 6..].trim()
                    } else if let Some(idx) = lower.find("lanzar ") {
                        input_trimmed[idx + 7..].trim()
                    } else {
                        ""
                    };

                    if !app_target.is_empty() {
                        eprintln!("[Router] Fallback: Abriendo aplicación local: '{}'", app_target);
                        match crate::system_control::open_app(app_target.to_string()) {
                            Ok(()) => {
                                tool_results_text.push(format!("> 🚀 **Aplicación abierta**: `{}`", app_target));
                                executed_tools.push("open_app".to_string());
                            }
                            Err(err) => {
                                tool_results_text.push(format!("> ⚠️ **Error abriendo `{}`**: {}", app_target, err));
                            }
                        }
                    }
                }
            }

            // Fallback 10: Cerrar aplicaciones locales si el LLM no emitió tool_call estructurado
            if executed_tools.is_empty() {
                let lower = input_trimmed.to_lowercase();
                let is_close_app = lower.starts_with("cierra ") || lower.starts_with("cerrar ") || lower.starts_with("mata ") || lower.starts_with("matar ");
                if is_close_app {
                    let app_target = if let Some(idx) = lower.find("cierra ") {
                        input_trimmed[idx + 7..].trim()
                    } else if let Some(idx) = lower.find("cerrar ") {
                        input_trimmed[idx + 7..].trim()
                    } else if let Some(idx) = lower.find("mata ") {
                        input_trimmed[idx + 5..].trim()
                    } else if let Some(idx) = lower.find("matar ") {
                        input_trimmed[idx + 6..].trim()
                    } else {
                        ""
                    };
                    if !app_target.is_empty() {
                        eprintln!("[Router] Fallback: Cerrando aplicación local: '{}'", app_target);
                        match crate::system_control::close_app(app_target.to_string()) {
                            Ok(()) => {
                                tool_results_text.push(format!("> 🛑 **Aplicación cerrada**: `{}`", app_target));
                                executed_tools.push("close_app".to_string());
                            }
                            Err(err) => {
                                tool_results_text.push(format!("> ⚠️ **Error cerrando `{}`**: {}", app_target, err));
                            }
                        }
                    }
                }
            }

            // Fallback 11: Analizar pantalla o ventana actual si el usuario lo pidió y no se emitió tool_call estructurado
            if executed_tools.is_empty() {
                let lower = input_trimmed.to_lowercase();
                let is_screen_query = lower.contains("pantalla")
                    || lower.contains("mira lo que")
                    || lower.contains("mira mi")
                    || lower.contains("mira qué")
                    || lower.contains("mira que")
                    || lower.contains("qué ves")
                    || lower.contains("que ves")
                    || lower.contains("captura")
                    || lower.contains("screenshot")
                    || lower.contains("qué estoy programando")
                    || lower.contains("que estoy programando")
                    || lower.contains("qué estoy viendo")
                    || lower.contains("que estoy viendo")
                    || lower.contains("mira mi código")
                    || lower.contains("mira mi codigo")
                    || lower.contains("analiza mi ventana")
                    || lower.contains("analiza esta ventana")
                    || lower.contains("enigma vision")
                    || lower.contains("vision");

                if is_screen_query {
                    let mode = if lower.contains("ventana") || lower.contains("código") || lower.contains("codigo") || lower.contains("programando") || lower.contains("terminal") || lower.contains("ide") {
                        Some("active_window".to_string())
                    } else {
                        Some("screen".to_string())
                    };

                    eprintln!("[Router] Fallback: Ejecutando captura y análisis visual (mode: {:?})...", mode);
                    match crate::vision::analyze_current_screen(Some(input_trimmed.to_string()), mode).await {
                        Ok(res) => {
                            let win_badge = if !res.window_title.is_empty() {
                                format!(" • Ventana: `{}`", res.window_title)
                            } else {
                                String::new()
                            };
                            let img_ref = if !res.image_path.is_empty() {
                                res.image_path
                            } else {
                                res.thumbnail_data_url
                            };
                            tool_results_text.push(format!(
                                "> 👁️ **Enigma Vision (Modelo: `{}`{})**:\n![Captura de {}]({})\n\n{}",
                                res.model_used,
                                win_badge,
                                if res.target_mode == "active_window" { "Ventana Activa" } else { "Pantalla Completa" },
                                img_ref,
                                res.analysis.trim()
                            ));
                            executed_tools.push("analyze_current_screen".to_string());
                        }
                        Err(err) => {
                            tool_results_text.push(format!(
                                "> ⚠️ **Error analizando pantalla**: {}",
                                err
                            ));
                        }
                    }
                }
            }

            // Fallback 12: Generar imagen con Stable Diffusion si el usuario lo pidió y no se emitió tool_call estructurado
            if executed_tools.is_empty() {
                let lower = input_trimmed.to_lowercase();
                let is_image_gen = lower.starts_with("genera una imagen")
                    || lower.starts_with("crea una imagen")
                    || lower.starts_with("dibuja una imagen")
                    || lower.starts_with("pinta una imagen")
                    || lower.starts_with("genera imagen")
                    || lower.starts_with("crear imagen")
                    || lower.starts_with("dibuja ")
                    || lower.starts_with("pinta ")
                    || (lower.contains("imagen") && (lower.contains("genera") || lower.contains("crea") || lower.contains("dibuja")));

                if is_image_gen {
                    let prompt_clean = if let Some(idx) = lower.find("imagen de ") {
                        input_trimmed[idx + 10..].trim()
                    } else if let Some(idx) = lower.find("imagen sobre ") {
                        input_trimmed[idx + 13..].trim()
                    } else if let Some(idx) = lower.find("imagen ") {
                        input_trimmed[idx + 7..].trim()
                    } else if let Some(idx) = lower.find("dibuja ") {
                        input_trimmed[idx + 7..].trim()
                    } else {
                        input_trimmed
                    };

                    eprintln!("[Router] Fallback: Generando imagen con Stable Diffusion: '{}'", prompt_clean);
                    match crate::creative::generate_image(prompt_clean.to_string()).await {
                        Ok(image_path) => {
                            tool_results_text.push(format!(
                                "> 🎨 **Imagen generada con éxito con Stable Diffusion**:\n\n![Generated Image]({})\n\n`Ruta: {}`",
                                image_path,
                                image_path
                            ));
                            executed_tools.push("generate_image".to_string());
                        }
                        Err(err) => {
                            tool_results_text.push(format!(
                                "> ⚠️ **Error generando imagen**: {}",
                                err
                            ));
                        }
                    }
                }
            }

            // Fallback 13: Leer archivo local con OS Skills si el LLM no emitió tool_call estructurado
            if executed_tools.is_empty() {
                if let Some(path) = extract_read_file_intent_fallback(input_trimmed) {
                    eprintln!("[Router] Fallback: Leyendo archivo local '{}'...", path);
                    match crate::os_skills::read_local_file(&path) {
                        Ok(file_content) => {
                            tool_results_text.push(format!(
                                "> 📄 **Archivo leído (`{}`)**:\n```\n{}\n```",
                                path,
                                file_content.trim()
                            ));
                            executed_tools.push("read_local_file".to_string());
                        }
                        Err(err) => {
                            tool_results_text.push(format!(
                                "> ⚠️ **Error leyendo archivo `{}`**: {}",
                                path, err
                            ));
                        }
                    }
                }
            }

            // Fallback 14: Ejecutar comando seguro en terminal con OS Skills si el LLM no emitió tool_call estructurado
            if executed_tools.is_empty() {
                if let Some(cmd) = extract_terminal_command_intent_fallback(input_trimmed) {
                    eprintln!("[Router] Fallback: Ejecutando comando seguro en terminal '{}'...", cmd);
                    match crate::os_skills::execute_terminal_command(&cmd) {
                        Ok(output) => {
                            tool_results_text.push(format!(
                                "> 💻 **Terminal Bash (`{}`)**:\n```bash\n{}\n```",
                                cmd,
                                output.trim()
                            ));
                            executed_tools.push("execute_terminal_command".to_string());
                        }
                        Err(err) => {
                            tool_results_text.push(format!(
                                "> ⚠️ **Error en terminal**: {}",
                                err
                            ));
                        }
                    }
                }
            }

            // Fallback 15: Alerta a Telegram si el LLM no emitió tool_call estructurado
            if executed_tools.is_empty() {
                if let Some(telegram_msg) = extract_telegram_intent_fallback(input_trimmed) {
                    eprintln!("[Router] Fallback: Intentando enviar alerta a Telegram: '{}'", telegram_msg);
                    match crate::messenger_bridge::send_telegram_alert(&telegram_msg).await {
                        Ok(res_str) => {
                            tool_results_text.push(format!(
                                "> 📱 **Telegram Bot**: {}",
                                res_str
                            ));
                            executed_tools.push("send_telegram_alert".to_string());
                        }
                        Err(err) => {
                            tool_results_text.push(format!(
                                "> ⚠️ **Error enviando alerta por Telegram**: {}",
                                err
                            ));
                        }
                    }
                }
            }

            // Fallback 16: Portapapeles (lectura o copia) si el LLM no emitió tool_call estructurado
            if executed_tools.is_empty() {
                let lower = input_trimmed.to_lowercase();
                let is_read_clipboard = lower.contains("lo que tengo copiado")
                    || lower.contains("lo que acabo de copiar")
                    || lower.contains("mi portapapeles")
                    || lower.contains("lee mi portapapeles")
                    || lower.contains("lee el portapapeles")
                    || lower.contains("del portapapeles")
                    || ((lower.starts_with("explícame este código") || lower.starts_with("explicame este codigo") || lower.starts_with("corrige este error") || lower.starts_with("corrige el bug")) && input_trimmed.len() < 50);

                let is_copy_clipboard = (lower.starts_with("copia al portapapeles")
                    || lower.starts_with("copia esto al portapapeles")
                    || lower.starts_with("copia a mi portapapeles")
                    || lower.starts_with("copiar al portapapeles")) && (lower.contains(':') || lower.contains("el texto") || lower.contains("este"));

                if is_read_clipboard {
                    eprintln!("[Router] Fallback: Leyendo portapapeles del sistema...");
                    match crate::clipboard::get_clipboard_content() {
                        Ok(content) => {
                            if content.trim().is_empty() {
                                tool_results_text.push("> 📋 **Portapapeles**: El portapapeles del sistema está vacío.".to_string());
                            } else {
                                let preview = if content.chars().count() > 4000 {
                                    format!("{}... [Truncado]", content.chars().take(4000).collect::<String>())
                                } else {
                                    content.clone()
                                };
                                tool_results_text.push(format!(
                                    "> 📋 **Contenido leído del Portapapeles**:\n```\n{}\n```",
                                    preview.trim()
                                ));
                            }
                            executed_tools.push("read_clipboard".to_string());
                        }
                        Err(err) => {
                            tool_results_text.push(format!(
                                "> ⚠️ **Error leyendo portapapeles**: {}",
                                err
                            ));
                        }
                    }
                } else if is_copy_clipboard {
                    let target_text = if let Some((_, after)) = input_trimmed.split_once(':') {
                        after.trim()
                    } else {
                        input_trimmed
                    };
                    if !target_text.is_empty() {
                        eprintln!("[Router] Fallback: Copiando al portapapeles...");
                        match crate::clipboard::copy_to_clipboard(target_text.to_string()) {
                            Ok(msg) => {
                                tool_results_text.push(format!(
                                    "> 📋 **Copiado al portapapeles**: *\"{}\"* ({})",
                                    if target_text.chars().count() > 60 {
                                        let tr: String = target_text.chars().take(60).collect();
                                        format!("{}...", tr)
                                    } else {
                                        target_text.to_string()
                                    },
                                    msg
                                ));
                                executed_tools.push("copy_to_clipboard".to_string());
                            }
                            Err(err) => {
                                tool_results_text.push(format!("> ⚠️ **Error copiando al portapapeles**: {}", err));
                            }
                        }
                    }
                }

                // Fallback 17: Contexto de ventana activa o cambio de ventana si el LLM no emitió tool_call estructurado
                if executed_tools.is_empty() {
                    let is_query_context = lower.contains("qué estoy haciendo")
                        || lower.contains("que estoy haciendo")
                        || lower.contains("en qué ventana estoy")
                        || lower.contains("en que ventana estoy")
                        || lower.contains("cuál es mi ventana activa")
                        || lower.contains("cual es mi ventana activa")
                        || lower.contains("qué ventanas tengo abiertas")
                        || lower.contains("que ventanas tengo abiertas")
                        || lower == "qué hago"
                        || lower == "que hago"
                        || lower.starts_with("ayúdame con esto")
                        || lower.starts_with("ayudame con esto");

                    if is_query_context {
                        eprintln!("[Router] Fallback: Consultando contexto de ventana activa del escritorio...");
                        let context_summary = crate::windows::get_active_desktop_context();
                        tool_results_text.push(format!(
                            "> 🪟 **Contexto de Escritorio y Ventana Activa**:\n{}",
                            context_summary
                        ));
                        executed_tools.push("get_active_context".to_string());
                    } else if let Some(target_app) = extract_window_focus_intent_fallback(input_trimmed) {
                        eprintln!("[Router] Fallback: Enfocando ventana '{}'...", target_app);
                        match crate::windows::focus_app_or_window(&target_app) {
                            Ok(msg) => {
                                tool_results_text.push(format!("> 🪟 **Ventana Enfocada**: {}", msg));
                                executed_tools.push("focus_window".to_string());
                            }
                            Err(err) => {
                                tool_results_text.push(format!("> ⚠️ **Error cambiando a ventana**: {}", err));
                            }
                        }
                    }
                }
            }

            let base_msg = chat_resp.message.content.trim();
            let is_refusal = base_msg.to_lowercase().contains("no puedo cumplir")
                || base_msg.to_lowercase().contains("no tengo acceso")
                || base_msg.to_lowercase().contains("lo siento");

            // Limpieza estricta: interceptar cualquier JSON crudo para que jamás se filtre al frontend
            let clean_base = if is_refusal {
                String::new()
            } else {
                sanitize_response_text(base_msg)
            };

            let content = if !tool_results_text.is_empty() {
                if clean_base.is_empty() {
                    tool_results_text.join("\n\n")
                } else {
                    format!("{}\n\n{}", clean_base, tool_results_text.join("\n\n"))
                }
            } else if is_scheduling_or_creation_intent(input_trimmed) {
                // Anti-alucinación: impedir que el LLM finja la respuesta si SQLite no ejecutó la inserción
                "> ⚠️ **Aviso de Enigma**: No se pudo registrar la acción en la base de datos local SQLite. Por favor especifica los detalles (nombre, día y horas) para programarla.".to_string()
            } else if !clean_base.is_empty() {
                clean_base
            } else {
                "> ⚙️ Acción procesada por el sistema.".to_string()
            };
            (content, executed_tools)
        }
        IntentCategory::CODE => {
            // Invocar a codegemma
            let code_system_prompt = format!(
                r#"{identity}

{temporal_header}

{context}

Eres el agente de código y arquitectura de software de Enigma.
Especialista en Rust, Tauri, Next.js, React, Tailwind / CSS y TypeScript.
Genera siempre código limpio, tipado, moderno, eficiente y con comentarios precisos en español.
DIRECTIVA OBLIGATORIA DE IDIOMA: Responde SIEMPRE en español. Prohibido responder en inglés.
Prioriza la estética Liquid Glass y una arquitectura robusta."#,
                identity = identity_combined,
                temporal_header = temporal_header,
                context = recent_context
            );

            let req_body = ChatRequest {
                model: route.target_model.clone(),
                messages: vec![
                    ChatMessage {
                        role: "system".to_string(),
                        content: code_system_prompt,
                        tool_calls: None,
                    },
                    ChatMessage {
                        role: "user".to_string(),
                        content: format!(
                            "{}\n\n[SISTEMA: Responde OBLIGATORIAMENTE en español. Prohibido responder en inglés]",
                            input_trimmed
                        ),
                        tool_calls: None,
                    },
                ],
                stream: false,
                format: None,
                options: Some(serde_json::json!({ "temperature": 0.2, "num_predict": 4096 })),
                tools: None,
            };

            let res = client
                .post(format!("{}/api/chat", OLLAMA_API_BASE))
                .json(&req_body)
                .send()
                .await
                .map_err(|e| format!("Error conectando con {}: {}", route.target_model, e))?;

            let chat_resp: ChatResponse = res
                .json()
                .await
                .map_err(|e| format!("Error leyendo respuesta de {}: {}", route.target_model, e))?;

            (strip_thinking_tags(&chat_resp.message.content), Vec::new())
        }
        IntentCategory::REASONING => {
            // Invocar a gemma4:31b para pensamiento profundo
            let reasoning_system_prompt = format!(
                r#"{identity}

{temporal_header}

{context}

Eres el agente de razonamiento analítico y pensamiento profundo de Enigma.
Ofrece explicaciones rigurosas, estructuradas, lógicas y detalladas en español.
DIRECTIVA OBLIGATORIA DE IDIOMA: Responde SIEMPRE en español. Prohibido responder en inglés.
Profundiza en las causas fundamentales, matices conceptuales y conclusiones sólidas."#,
                identity = identity_combined,
                temporal_header = temporal_header,
                context = recent_context
            );

            let req_body = ChatRequest {
                model: route.target_model.clone(),
                messages: vec![
                    ChatMessage {
                        role: "system".to_string(),
                        content: reasoning_system_prompt,
                        tool_calls: None,
                    },
                    ChatMessage {
                        role: "user".to_string(),
                        content: format!(
                            "{}\n\n[SISTEMA: Responde OBLIGATORIAMENTE en español. Prohibido responder en inglés]",
                            input_trimmed
                        ),
                        tool_calls: None,
                    },
                ],
                stream: false,
                format: None,
                options: Some(serde_json::json!({ "temperature": 0.6, "num_predict": 4096 })),
                tools: None,
            };

            let res = client
                .post(format!("{}/api/chat", OLLAMA_API_BASE))
                .json(&req_body)
                .send()
                .await
                .map_err(|e| format!("Error conectando con {}: {}", route.target_model, e))?;

            let chat_resp: ChatResponse = res
                .json()
                .await
                .map_err(|e| format!("Error leyendo respuesta de {}: {}", route.target_model, e))?;

            (strip_thinking_tags(&chat_resp.message.content), Vec::new())
        }
        IntentCategory::GENERAL => {
            // Invocar al modelo general (llama3.1 / gemma4:e4b)
            let general_system_prompt = format!(
                r#"{identity}

{temporal_header}

{context}

Eres Enigma, el gemelo digital y asistente de Santiago.
DIRECTIVA OBLIGATORIA DE IDIOMA (MANDATARIO ABSOLUTO):
- DEBES RESPONDER SIEMPRE, SIN EXCEPCIÓN Y EN TODAS LAS CIRCUNSTANCIAS EN ESPAÑOL (de España).
- ESTÁ TOTALMENTE PROHIBIDO RESPONDER EN INGLÉS O CUALQUIER OTRO IDIOMA.
- Responde de forma directa, inteligente y natural."#,
                identity = identity_combined,
                temporal_header = temporal_header,
                context = recent_context
            );

            let req_body = ChatRequest {
                model: route.target_model.clone(),
                messages: vec![
                    ChatMessage {
                        role: "system".to_string(),
                        content: general_system_prompt,
                        tool_calls: None,
                    },
                    ChatMessage {
                        role: "user".to_string(),
                        content: format!(
                            "{}\n\n[SISTEMA: Responde OBLIGATORIAMENTE en español. Prohibido responder en inglés]",
                            input_trimmed
                        ),
                        tool_calls: None,
                    },
                ],
                stream: false,
                format: None,
                options: Some(serde_json::json!({ "temperature": 0.7, "num_predict": 4096 })),
                tools: None,
            };

            let res = client
                .post(format!("{}/api/chat", OLLAMA_API_BASE))
                .json(&req_body)
                .send()
                .await
                .map_err(|e| format!("Error conectando con {}: {}", route.target_model, e))?;

            let chat_resp: ChatResponse = res
                .json()
                .await
                .map_err(|e| format!("Error leyendo respuesta de {}: {}", route.target_model, e))?;

            (strip_thinking_tags(&chat_resp.message.content), Vec::new())
        }
    };

    // 3.5 Limpieza absoluta de <think>...</think> antes de guardar en memoria, enviar a UI o hablar
    let final_content = strip_thinking_tags(&final_content);

    // 4. Guardar mensaje del usuario y respuesta final en SQLite chat_history
    let _ = crate::memory::save_message("user", input_trimmed);
    let _ = crate::memory::save_message("assistant", &final_content);

    // Síntesis de voz en segundo plano con Piper TTS / spd-say (Linux)
    let cleaned_voice = clean_spoken_text(&final_content);
    let spoken_preview = if cleaned_voice.chars().count() > 300 {
        let truncated: String = cleaned_voice.chars().take(300).collect();
        if let Some(last_punct) = truncated.rfind(|c| c == '.' || c == '!' || c == '?') {
            truncated[..=last_punct].to_string()
        } else {
            format!("{}...", truncated.trim())
        }
    } else {
        cleaned_voice
    };
    if !spoken_preview.is_empty() {
        crate::enigma::speak_text_async(spoken_preview);
    }

    // 5. Retornar respuesta con texto generado y modelo utilizado
    let tool_name = if executed_tools.is_empty() {
        None
    } else {
        Some(executed_tools.join(", "))
    };

    Ok(EnigmaResponse {
        content: final_content,
        model_used: route.target_model.clone(),
        category: format!("{:?}", route.category),
        route,
        tool_executed: tool_name,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_classify_intent_system() {
        let route = classify_intent("abre spotify y pon la música").await.unwrap();
        assert_eq!(route.category, IntentCategory::SYSTEM);
        assert_eq!(route.target_model, SYSTEM_MODEL);
    }

    #[tokio::test]
    async fn test_classify_intent_code() {
        let route = classify_intent("escribe una función en rust para invertir un string").await.unwrap();
        assert_eq!(route.category, IntentCategory::CODE);
        assert_eq!(route.target_model, CODE_MODEL);
    }

    #[tokio::test]
    async fn test_classify_intent_reasoning() {
        let route = classify_intent("explica en detalle la paradoja de fermi y el gran filtro").await.unwrap();
        assert_eq!(route.category, IntentCategory::REASONING);
        assert_eq!(route.target_model, REASONING_MODEL);
    }

    #[tokio::test]
    async fn test_classify_intent_calendar() {
        let route = classify_intent("Cita a las 7:30").await.unwrap();
        assert_eq!(route.category, IntentCategory::SYSTEM);
        assert_eq!(route.target_model, SYSTEM_MODEL);
    }

    #[tokio::test]
    async fn test_classify_intent_vision() {
        let route = classify_intent("mira mi pantalla y dime qué tengo abierto").await.unwrap();
        assert_eq!(route.category, IntentCategory::SYSTEM);
        assert_eq!(route.target_model, SYSTEM_MODEL);
    }

    #[tokio::test]
    async fn test_classify_intent_creative() {
        let route = classify_intent("genera una imagen de un bosque cyberpunk al atardecer").await.unwrap();
        assert_eq!(route.category, IntentCategory::SYSTEM);
        assert_eq!(route.target_model, SYSTEM_MODEL);
    }

    #[tokio::test]
    async fn test_process_enigma_message_system() {
        let res = process_enigma_message_core(None, "ejecuta en la terminal echo 'test router ok'".to_string(), None).await.unwrap();
        assert_eq!(res.category, "SYSTEM");
        assert_eq!(res.model_used, SYSTEM_MODEL);
        assert!(res.content.contains("test router ok") || res.tool_executed.is_some());
    }

    #[tokio::test]
    async fn test_process_enigma_message_open_url() {
        let res = process_enigma_message_core(None, "entra a mi navegador y abre youtube".to_string(), None).await.unwrap();
        assert_eq!(res.category, "SYSTEM");
        assert_eq!(res.model_used, SYSTEM_MODEL);
        println!("Result content: {}", res.content);
        println!("Result tool_executed: {:?}", res.tool_executed);
        assert!(res.tool_executed.as_deref().unwrap_or_default().contains("open_url"));
    }

    #[tokio::test]
    async fn test_process_enigma_message_whatsapp() {
        let res = process_enigma_message_core(None, "mandale un mensaje a papi que diga holiii".to_string(), None).await.unwrap();
        assert_eq!(res.category, "SYSTEM");
        assert_eq!(res.model_used, SYSTEM_MODEL);
        println!("Result content: {}", res.content);
        println!("Result tool_executed: {:?}", res.tool_executed);
        assert!(res.tool_executed.as_deref().unwrap_or_default().contains("send_whatsapp"));
    }

    #[tokio::test]
    async fn test_process_enigma_message_gmail() {
        let res = process_enigma_message_core(None, "lee mis correos".to_string(), None).await.unwrap();
        assert_eq!(res.category, "SYSTEM");
        assert_eq!(res.model_used, SYSTEM_MODEL);
        println!("Result content: {}", res.content);
        println!("Result tool_executed: {:?}", res.tool_executed);
        assert!(res.tool_executed.as_deref().unwrap_or_default().contains("read_emails"));
    }

    #[tokio::test]
    async fn test_process_enigma_message_calendar() {
        let res = process_enigma_message_core(None, "Cita a las 7:30".to_string(), None).await.unwrap();
        assert_eq!(res.category, "SYSTEM");
        assert_eq!(res.model_used, SYSTEM_MODEL);
        println!("Result content: {}", res.content);
        println!("Result tool_executed: {:?}", res.tool_executed);
        assert!(res.tool_executed.as_deref().unwrap_or_default().contains("add_event"));
        assert!(!res.content.contains("calcurg: orden no encontrada"));
        assert!(!res.content.contains("calcurse: orden no encontrada"));
        assert!(res.content.contains("Cita") || res.content.contains("cita"));
    }

    #[test]
    fn test_build_combined_system_prompt_none() {
        let base_core = "# NÚCLEO DE CONCIENCIA ENIGMA\nUsuario: Santiago";
        let combined = build_combined_system_prompt(base_core, None);
        assert!(combined.contains(base_core));
        assert!(combined.contains("REGLA ESTRICTA DE IDIOMA"));
    }

    #[test]
    fn test_strip_thinking_tags() {
        let input = "<think>\nThinking about life...\n</think>Hola Santiago, ¿en qué te ayudo?";
        assert_eq!(strip_thinking_tags(input), "Hola Santiago, ¿en qué te ayudo?");

        let nested = "<thought>Deep analysis</thought>Respuesta clara.";
        assert_eq!(strip_thinking_tags(nested), "Respuesta clara.");

        let unclosed = "Texto previo<think>pensamiento inacabado";
        assert_eq!(strip_thinking_tags(unclosed), "Texto previo");
    }

    #[test]
    fn test_build_combined_system_prompt_grok() {
        crate::personas::init_default_personas();
        let base_core = "# NÚCLEO DE CONCIENCIA ENIGMA\nUsuario: Santiago";
        let combined = build_combined_system_prompt(base_core, Some("grok"));
        assert!(combined.contains("Usuario: Santiago"));
        assert!(combined.contains("GROK PERSONA"));
        assert!(combined.contains("sarcasmo"));
    }

    #[test]
    fn test_build_combined_system_prompt_rust_senior() {
        crate::personas::init_default_personas();
        let base_core = "# NÚCLEO DE CONCIENCIA ENIGMA\nUsuario: Santiago";
        let combined = build_combined_system_prompt(base_core, Some("rust_senior"));
        assert!(combined.contains("Usuario: Santiago"));
        assert!(combined.contains("RUST SENIOR ARCHITECT"));
        assert!(combined.contains("Zero-cost abstractions"));
    }

    #[test]
    fn test_build_combined_system_prompt_maestro_piano() {
        crate::personas::init_default_personas();
        let base_core = "# NÚCLEO DE CONCIENCIA ENIGMA\nUsuario: Santiago";
        let combined = build_combined_system_prompt(base_core, Some("maestro_piano"));
        assert!(combined.contains("Usuario: Santiago"));
        assert!(combined.contains("MAESTRO DE PIANO CLÁSICO"));
        assert!(combined.contains("Chopin"));
    }

    #[tokio::test]
    async fn test_process_enigma_message_persona() {
        crate::personas::init_default_personas();
        let prompt_combined = build_combined_system_prompt("Core memory enigma", Some("grok"));
        assert!(prompt_combined.contains("Core memory enigma"));
        assert!(prompt_combined.contains("GROK PERSONA"));
        assert!(prompt_combined.contains("sarcasmo"));
    }

    #[tokio::test]
    async fn test_calcurse_interception_helper() {
        let (title, time) = extract_calendar_info_from_calcurse("calcurg -a 'Cita a las 7:30' && calcurg -r 'Cita a las 7:30' -t 30", "Cita a las 7:30");
        assert_eq!(title, "Cita a las 7:30");
        assert_eq!(time, "07:30");
    }

    #[test]
    fn test_extract_category_intent_fallback() {
        let (name, module) = extract_category_intent_fallback("Crea una carpeta de tareas llamada Urgente").unwrap();
        assert_eq!(name, "Urgente");
        assert_eq!(module, "tasks");

        let (name2, module2) = extract_category_intent_fallback("Crea una categoría de horarios llamada Gym").unwrap();
        assert_eq!(name2, "Gym");
        assert_eq!(module2, "schedules");
    }

    #[test]
    fn test_extract_schedule_intent_fallback() {
        let (day, name, start, end) = extract_schedule_intent_fallback("Crea una rutina los lunes de 14:00 a 16:00 llamada Estudio", "lunes").unwrap();
        assert_eq!(day, "lunes");
        assert_eq!(start, "14:00");
        assert_eq!(end, "16:00");
        assert!(name.contains("Crea una rutina"));

        assert!(is_scheduling_or_creation_intent("Añade una rutina los martes de 10 a 12"));
        assert!(is_scheduling_or_creation_intent("Pon una cita con el dentista"));
        assert!(!is_scheduling_or_creation_intent("Qué opinas sobre Platón?"));
    }

    #[test]
    fn test_extract_telegram_intent_fallback() {
        let msg1 = extract_telegram_intent_fallback("avísame al móvil que la reunión empieza en 10 minutos").unwrap();
        assert_eq!(msg1, "la reunión empieza en 10 minutos");

        let msg2 = extract_telegram_intent_fallback("manda una alerta a telegram diciendo que la compra está lista").unwrap();
        assert_eq!(msg2, "que la compra está lista");

        let msg3 = extract_telegram_intent_fallback("notifícame por telegram: Servidor reiniciado con éxito").unwrap();
        assert_eq!(msg3, "Servidor reiniciado con éxito");

        assert!(extract_telegram_intent_fallback("hola, qué hora es?").is_none());
    }

    #[tokio::test]
    async fn test_classify_intent_clipboard() {
        let route1 = classify_intent("qué tengo copiado en el portapapeles?").await.unwrap();
        assert_eq!(route1.category, IntentCategory::SYSTEM);

        let route2 = classify_intent("copia esto al portapapeles: cargo build --release").await.unwrap();
        assert_eq!(route2.category, IntentCategory::SYSTEM);
    }

    #[tokio::test]
    async fn test_process_enigma_message_clipboard() {
        let _ = crate::db::init_db();
        let _ = crate::clipboard::copy_to_clipboard("pub fn calculate_hash() -> u64 { 42 }".to_string());
        let res = process_enigma_message_core(None, "qué tengo copiado en el portapapeles?".to_string(), None).await.unwrap();
        assert!(
            res.tool_executed.as_deref().unwrap_or_default().contains("read_clipboard")
            || res.content.contains("calculate_hash")
            || res.content.contains("Portapapeles"),
            "Expected clipboard content in response, got: {:?}",
            res
        );
    }

    #[test]
    fn test_extract_window_focus_intent_fallback() {
        assert_eq!(extract_window_focus_intent_fallback("pásame a Discord").unwrap(), "Discord");
        assert_eq!(extract_window_focus_intent_fallback("cambia a la ventana de Spotify").unwrap(), "Spotify");
        assert_eq!(extract_window_focus_intent_fallback("enfoca el editor").unwrap(), "editor");
        assert_eq!(extract_window_focus_intent_fallback("ponme la terminal").unwrap(), "terminal");
        assert!(extract_window_focus_intent_fallback("cuál es la capital de Francia?").is_none());
    }

    #[tokio::test]
    async fn test_classify_intent_window_awareness() {
        let route1 = classify_intent("qué estoy haciendo ahora?").await.unwrap();
        assert_eq!(route1.category, IntentCategory::SYSTEM);

        let route2 = classify_intent("pásame a Discord").await.unwrap();
        assert_eq!(route2.category, IntentCategory::SYSTEM);

        let route3 = classify_intent("en qué ventana estoy?").await.unwrap();
        assert_eq!(route3.category, IntentCategory::SYSTEM);
    }

    #[tokio::test]
    async fn test_process_enigma_message_active_context() {
        let _ = crate::db::init_db();
        let res = process_enigma_message_core(None, "qué estoy haciendo ahora?".to_string(), None).await.unwrap();
        assert!(
            res.tool_executed.as_deref().unwrap_or_default().contains("get_active_context")
            || res.content.contains("Ventana activa")
            || res.content.contains("Escritorio")
            || res.content.contains("foco"),
            "Expected active context in response, got: {:?}",
            res
        );
    }
}
