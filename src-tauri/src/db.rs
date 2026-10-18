use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use rusqlite::{params, Connection, Result};
use serde::{Deserialize, Serialize};
use tauri::Emitter;

static DB_LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CategoryItem {
    pub id: i64,
    pub name: String,
    pub module_type: String, // 'tasks' | 'schedules' | 'calendars'
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NoteRecord {
    pub id: i64,
    pub title: String,
    pub content: String,
    pub timestamp: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CalendarEvent {
    pub id: i64,
    pub title: String,
    pub event_date: String, // ISO 8601 YYYY-MM-DD
    pub event_time: String, // HH:MM
    pub notify_before_mins: i32,
    pub notified: i32,
    pub category_id: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskRecord {
    pub id: i64,
    pub title: String,
    pub status: String, // "pending" | "completed"
    pub category_id: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScheduleBlock {
    pub id: i64,
    pub day_of_week: String,
    pub block_name: String,
    pub start_time: String,
    pub end_time: String,
    pub category_id: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExtensionRecord {
    pub id: i64,
    pub service_name: String,
    pub auth_token: Option<String>,
    pub status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WhatsAppContact {
    pub id: String, // WhatsApp JID (ej: 346XXXXXXXX@s.whatsapp.net)
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClipboardRecord {
    pub id: i64,
    pub content_type: String, // "color" | "code" | "url" | "text" | "image"
    pub preview: String,
    pub full_content: String,
    pub meta_info: String,
    pub timestamp: i64,
}


/// Returns the database file path (~/.local/share/enigma/enigma_core.db)
pub fn get_db_path() -> PathBuf {
    let mut path = dirs_home().unwrap_or_else(|| PathBuf::from("/tmp"));
    path.push(".local");
    path.push("share");
    path.push("enigma");
    let _ = fs::create_dir_all(&path);
    path.push("enigma_core.db");
    path
}

fn dirs_home() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from)
}

/// Establishes connection to SQLite
pub fn get_connection() -> Result<Connection> {
    let path = get_db_path();
    Connection::open(path)
}

/// Initializes database tables and default initial data
pub fn init_db() -> Result<()> {
    let _guard = DB_LOCK.lock().unwrap();
    let conn = get_connection()?;

    // 0. categories (Dynamic subcategories for modules)
    conn.execute(
        "CREATE TABLE IF NOT EXISTS categories (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            module_type TEXT NOT NULL
        );",
        [],
    )?;
    let _ = conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_categories_module ON categories(module_type);",
        [],
    );

    // 1. calendar_events
    conn.execute(
        "CREATE TABLE IF NOT EXISTS calendar_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL,
            event_date TEXT NOT NULL,
            event_time TEXT NOT NULL,
            notify_before_mins INTEGER NOT NULL DEFAULT 15,
            notified INTEGER NOT NULL DEFAULT 0,
            category_id INTEGER REFERENCES categories(id)
        );",
        [],
    )?;

    // 2. tasks
    conn.execute(
        "CREATE TABLE IF NOT EXISTS tasks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending',
            category_id INTEGER REFERENCES categories(id)
        );",
        [],
    )?;

    // 3. schedules
    conn.execute(
        "CREATE TABLE IF NOT EXISTS schedules (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            day_of_week TEXT NOT NULL,
            block_name TEXT NOT NULL,
            start_time TEXT NOT NULL,
            end_time TEXT NOT NULL,
            category_id INTEGER REFERENCES categories(id)
        );",
        [],
    )?;

    // Migration helper: Ensure category_id column exists in existing tables
    let ensure_category_column = |table_name: &str| -> Result<()> {
        let mut stmt = conn.prepare(&format!("PRAGMA table_info({})", table_name))?;
        let cols: Vec<String> = stmt
            .query_map([], |row| row.get(1))?
            .filter_map(|r| r.ok())
            .collect();
        if !cols.iter().any(|c| c == "category_id") {
            eprintln!("[SQLite] Añadiendo columna category_id a la tabla {}...", table_name);
            let _ = conn.execute(
                &format!("ALTER TABLE {} ADD COLUMN category_id INTEGER REFERENCES categories(id);", table_name),
                [],
            );
        }
        Ok(())
    };
    let _ = ensure_category_column("calendar_events");
    let _ = ensure_category_column("tasks");
    let _ = ensure_category_column("schedules");

    // 4. extensions
    conn.execute(
        "CREATE TABLE IF NOT EXISTS extensions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            service_name TEXT NOT NULL,
            auth_token TEXT,
            status TEXT NOT NULL DEFAULT 'active'
        );",
        [],
    )?;

    let _ = conn.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_extensions_service_name ON extensions(service_name);",
        [],
    );

    // 5. whatsapp_contacts: id (TEXT PRIMARY KEY), name (TEXT)
    // Comprobar si la tabla previa usaba INTEGER id para migrarla limpiamente
    let needs_migration = {
        if let Ok(mut stmt) = conn.prepare("PRAGMA table_info(whatsapp_contacts)") {
            let col_types: Vec<(String, String)> = stmt
                .query_map([], |row| Ok((row.get(1)?, row.get(2)?)))
                .map(|rows| rows.filter_map(|r| r.ok()).collect())
                .unwrap_or_default();
            col_types.iter().any(|(name, typ)| name == "id" && typ.to_uppercase().contains("INT"))
        } else {
            false
        }
    };

    if needs_migration {
        eprintln!("[SQLite] Migrando tabla whatsapp_contacts a id TEXT PRIMARY KEY (JID)...");
        let _ = conn.execute("DROP TABLE whatsapp_contacts", []);
    }

    conn.execute(
        "CREATE TABLE IF NOT EXISTS whatsapp_contacts (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL COLLATE NOCASE
        );",
        [],
    )?;

    conn.execute(
        "CREATE TABLE IF NOT EXISTS deleted_whatsapp_contacts (
            id TEXT PRIMARY KEY,
            deleted_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );",
        [],
    )?;

    // 6. google_tokens: OAuth 2.0 (Gmail + Calendar)
    conn.execute(
        "CREATE TABLE IF NOT EXISTS google_tokens (
            id TEXT PRIMARY KEY,
            access_token TEXT NOT NULL,
            refresh_token TEXT,
            expires_at INTEGER NOT NULL,
            token_type TEXT NOT NULL DEFAULT 'Bearer',
            scope TEXT,
            client_id TEXT,
            client_secret TEXT,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );",
        [],
    )?;

    // 7. chat_history: Short-term conversation memory
    conn.execute(
        "CREATE TABLE IF NOT EXISTS chat_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            role TEXT NOT NULL,
            content TEXT NOT NULL,
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
        );",
        [],
    )?;

    // 8. usage_logs: System application telemetry
    conn.execute(
        "CREATE TABLE IF NOT EXISTS usage_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            process_name TEXT NOT NULL,
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
        );",
        [],
    )?;
    let _ = conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_usage_logs_timestamp ON usage_logs(timestamp);",
        [],
    );

    // 9. notes: Quick Notes System
    conn.execute(
        "CREATE TABLE IF NOT EXISTS notes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL,
            content TEXT NOT NULL,
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
        );",
        [],
    )?;
    let _ = conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_notes_timestamp ON notes(timestamp);",
        [],
    );

    // 10. clipboard_history: Smart Clipboard & History System
    conn.execute(
        "CREATE TABLE IF NOT EXISTS clipboard_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            content_type TEXT NOT NULL,
            preview TEXT NOT NULL,
            full_content TEXT NOT NULL,
            meta_info TEXT NOT NULL,
            timestamp INTEGER NOT NULL
        );",
        [],
    )?;
    let _ = conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_clipboard_history_ts ON clipboard_history(timestamp DESC);",
        [],
    );


    // Seed default categories if empty
    let count_cat: i64 = conn.query_row("SELECT COUNT(*) FROM categories", [], |r| r.get(0)).unwrap_or(0);
    if count_cat == 0 {
        let default_categories = [
            ("General", "tasks"),
            ("Urgente", "tasks"),
            ("Proyectos", "tasks"),
            ("Rutina", "schedules"),
            ("Trabajo", "schedules"),
            ("Personal", "schedules"),
            ("General", "calendars"),
            ("Reuniones", "calendars"),
            ("Eventos", "calendars"),
        ];
        for (name, module_type) in default_categories {
            let _ = conn.execute(
                "INSERT INTO categories (name, module_type) VALUES (?1, ?2)",
                params![name, module_type],
            );
        }
    }

    // Seed default notes if empty
    let count_notes: i64 = conn.query_row("SELECT COUNT(*) FROM notes", [], |r| r.get(0)).unwrap_or(0);
    if count_notes == 0 {
        let _ = conn.execute(
            "INSERT INTO notes (title, content) VALUES (?1, ?2)",
            params![
                "Bienvenido a las Notas Rápidas de Enigma",
                "Puedes crear notas manualmente desde esta vista o pedirle a Enigma por voz o chat: 'Apunta esta nota: ...'. También puedes pulsar el icono de Telegram para enviarlas como alertas a tu teléfono."
            ],
        );
    }

    // Seed default tasks if empty
    let count: i64 = conn.query_row("SELECT COUNT(*) FROM tasks", [], |r| r.get(0))?;
    if count == 0 {
        let default_tasks = [
            ("Optimizar pipeline de síntesis neural con Piper TTS", "completed"),
            ("Ajustar prompt de sistema en Ollama (DeepSeek-R1)", "completed"),
            ("Implementar Hub Modular reactivo en la caja de salida", "completed"),
            ("Base de datos SQLite local para eventos y tareas", "completed"),
            ("Módulo de mensajería WhatsApp (Baileys microservice)", "completed"),
            ("Supervisar latencia de tokens e inferencia local", "pending"),
        ];
        for (title, status) in default_tasks {
            conn.execute(
                "INSERT INTO tasks (title, status) VALUES (?1, ?2)",
                params![title, status],
            )?;
        }
    }

    // Seed default schedules if empty
    let count_schedules: i64 = conn.query_row("SELECT COUNT(*) FROM schedules", [], |r| r.get(0))?;
    if count_schedules == 0 {
        let default_schedules = [
            ("Lunes a Viernes", "Deep Work: Backend Rust & Piper TTS", "09:00", "11:30"),
            ("Lunes a Viernes", "UI/UX: Framer Motion & TopBar Layout", "11:30", "13:00"),
            ("Lunes a Viernes", "Almuerzo & Desconexión Activa", "13:00", "14:30"),
            ("Lunes a Viernes", "Pruebas de Inferencia: DeepSeek-R1 (14b)", "14:30", "17:00"),
            ("Lunes a Viernes", "Entrenamiento & Acondicionamiento", "17:00", "19:00"),
            ("Lunes a Viernes", "Proyectos Personales & Lectura", "20:00", "22:30"),
        ];
        for (day, name, start, end) in default_schedules {
            conn.execute(
                "INSERT INTO schedules (day_of_week, block_name, start_time, end_time) VALUES (?1, ?2, ?3, ?4)",
                params![day, name, start, end],
            )?;
        }
    }

    // Seed default extensions if empty
    let count_ext: i64 = conn.query_row("SELECT COUNT(*) FROM extensions", [], |r| r.get(0))?;
    if count_ext == 0 {
        let default_extensions = [
            ("DeepSeek-R1 (14b) Local Core", "Activo"),
            ("Piper TTS Neural Speech (Dave)", "Activo"),
            ("WhatsApp Bridge (Baileys Node.js)", "Activo"),
            ("Vosk STT Guardian (Offline)", "Activo"),
            ("KRunner Application Search", "Activo"),
            ("Google Calendar API Sync", "Disponible"),
        ];
        for (service, status) in default_extensions {
            conn.execute(
                "INSERT INTO extensions (service_name, status) VALUES (?1, ?2)",
                params![service, status],
            )?;
        }
    }

    // Seed default whatsapp_contacts if empty
    let count_contacts: i64 = conn.query_row("SELECT COUNT(*) FROM whatsapp_contacts", [], |r| r.get(0)).unwrap_or(0);
    if count_contacts == 0 {
        let default_contacts = [
            ("34611223344@s.whatsapp.net", "Grigorii"),
            ("34655443322@s.whatsapp.net", "Mamá"),
            ("34666554433@s.whatsapp.net", "Papá"),
            ("34600112233@s.whatsapp.net", "Santi"),
        ];
        for (jid, name) in default_contacts {
            let _ = conn.execute(
                "INSERT INTO whatsapp_contacts (id, name) VALUES (?1, ?2) ON CONFLICT(id) DO UPDATE SET name = excluded.name",
                params![jid, name],
            );
        }
    }

    eprintln!("[SQLite] Enigma database initialized at {:?}", get_db_path());
    Ok(())
}

// ==========================================
// CALENDAR EVENTS CRUD
// ==========================================

pub fn db_get_calendar_events() -> Result<Vec<CalendarEvent>> {
    let _guard = DB_LOCK.lock().unwrap();
    let conn = get_connection()?;
    let mut stmt = conn.prepare(
        "SELECT id, title, event_date, event_time, notify_before_mins, notified, category_id 
         FROM calendar_events ORDER BY event_date ASC, event_time ASC",
    )?;

    let event_iter = stmt.query_map([], |row| {
        Ok(CalendarEvent {
            id: row.get(0)?,
            title: row.get(1)?,
            event_date: row.get(2)?,
            event_time: row.get(3)?,
            notify_before_mins: row.get(4)?,
            notified: row.get(5)?,
            category_id: row.get(6)?,
        })
    })?;

    let mut events = Vec::new();
    for event in event_iter {
        events.push(event?);
    }
    Ok(events)
}

pub fn db_add_calendar_event(
    title: &str,
    event_date: &str,
    event_time: &str,
    notify_before_mins: i32,
    category_id: Option<i64>,
) -> Result<i64> {
    let _guard = DB_LOCK.lock().unwrap();
    let conn = get_connection()?;
    conn.execute(
        "INSERT INTO calendar_events (title, event_date, event_time, notify_before_mins, notified, category_id)
         VALUES (?1, ?2, ?3, ?4, 0, ?5)",
        params![title, event_date, event_time, notify_before_mins, category_id],
    )?;
    Ok(conn.last_insert_rowid())
}

pub fn db_delete_calendar_event(id: i64) -> Result<()> {
    let _guard = DB_LOCK.lock().unwrap();
    let conn = get_connection()?;
    conn.execute("DELETE FROM calendar_events WHERE id = ?1", params![id])?;
    Ok(())
}

// ==========================================
// TASKS CRUD
// ==========================================

pub fn db_get_tasks() -> Result<Vec<TaskRecord>> {
    let _guard = DB_LOCK.lock().unwrap();
    let conn = get_connection()?;
    let mut stmt = conn.prepare("SELECT id, title, status, category_id FROM tasks ORDER BY id DESC")?;

    let task_iter = stmt.query_map([], |row| {
        Ok(TaskRecord {
            id: row.get(0)?,
            title: row.get(1)?,
            status: row.get(2)?,
            category_id: row.get(3)?,
        })
    })?;

    let mut tasks = Vec::new();
    for task in task_iter {
        tasks.push(task?);
    }
    Ok(tasks)
}

pub fn db_add_task(title: &str, category_id: Option<i64>) -> Result<i64> {
    let _guard = DB_LOCK.lock().unwrap();
    let conn = get_connection()?;
    conn.execute(
        "INSERT INTO tasks (title, status, category_id) VALUES (?1, 'pending', ?2)",
        params![title, category_id],
    )?;
    Ok(conn.last_insert_rowid())
}

pub fn db_toggle_task(id: i64, completed: bool) -> Result<()> {
    let _guard = DB_LOCK.lock().unwrap();
    let conn = get_connection()?;
    let status = if completed { "completed" } else { "pending" };
    conn.execute(
        "UPDATE tasks SET status = ?1 WHERE id = ?2",
        params![status, id],
    )?;
    Ok(())
}

pub fn db_delete_task(id: i64) -> Result<()> {
    let _guard = DB_LOCK.lock().unwrap();
    let conn = get_connection()?;
    conn.execute("DELETE FROM tasks WHERE id = ?1", params![id])?;
    Ok(())
}

// ==========================================
// SCHEDULES & EXTENSIONS
// ==========================================

pub fn db_get_schedules() -> Result<Vec<ScheduleBlock>> {
    let _guard = DB_LOCK.lock().unwrap();
    let conn = get_connection()?;
    let mut stmt = conn.prepare(
        "SELECT id, day_of_week, block_name, start_time, end_time, category_id FROM schedules ORDER BY start_time ASC",
    )?;

    let iter = stmt.query_map([], |row| {
        Ok(ScheduleBlock {
            id: row.get(0)?,
            day_of_week: row.get(1)?,
            block_name: row.get(2)?,
            start_time: row.get(3)?,
            end_time: row.get(4)?,
            category_id: row.get(5)?,
        })
    })?;

    let mut blocks = Vec::new();
    for b in iter {
        blocks.push(b?);
    }
    Ok(blocks)
}

pub fn db_add_schedule(
    day_of_week: &str,
    block_name: &str,
    start_time: &str,
    end_time: &str,
    category_id: Option<i64>,
) -> Result<i64> {
    let _guard = DB_LOCK.lock().unwrap();
    let conn = get_connection()?;
    conn.execute(
        "INSERT INTO schedules (day_of_week, block_name, start_time, end_time, category_id) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![day_of_week, block_name, start_time, end_time, category_id],
    )?;
    Ok(conn.last_insert_rowid())
}

pub fn db_delete_schedule(id: i64) -> Result<()> {
    let _guard = DB_LOCK.lock().unwrap();
    let conn = get_connection()?;
    conn.execute("DELETE FROM schedules WHERE id = ?1", params![id])?;
    Ok(())
}

pub fn db_get_extensions() -> Result<Vec<ExtensionRecord>> {
    let _guard = DB_LOCK.lock().unwrap();
    let conn = get_connection()?;
    let mut stmt = conn.prepare("SELECT id, service_name, auth_token, status FROM extensions")?;

    let iter = stmt.query_map([], |row| {
        Ok(ExtensionRecord {
            id: row.get(0)?,
            service_name: row.get(1)?,
            auth_token: row.get(2)?,
            status: row.get(3)?,
        })
    })?;

    let mut list = Vec::new();
    for e in iter {
        list.push(e?);
    }
    Ok(list)
}

// ==========================================
// CATEGORIES CRUD (Dynamic subcategories)
// ==========================================

pub fn db_get_categories_by_module(module_type: &str) -> Result<Vec<CategoryItem>> {
    let _guard = DB_LOCK.lock().unwrap();
    let conn = get_connection()?;
    let mut stmt = conn.prepare(
        "SELECT id, name, module_type FROM categories WHERE module_type = ?1 ORDER BY id ASC",
    )?;

    let iter = stmt.query_map(params![module_type], |row| {
        Ok(CategoryItem {
            id: row.get(0)?,
            name: row.get(1)?,
            module_type: row.get(2)?,
        })
    })?;

    let mut list = Vec::new();
    for c in iter {
        list.push(c?);
    }
    Ok(list)
}

pub fn db_add_category(name: &str, module_type: &str) -> Result<i64> {
    let _guard = DB_LOCK.lock().unwrap();
    let conn = get_connection()?;
    conn.execute(
        "INSERT INTO categories (name, module_type) VALUES (?1, ?2)",
        params![name.trim(), module_type.trim()],
    )?;
    Ok(conn.last_insert_rowid())
}

pub fn db_delete_category(id: i64) -> Result<()> {
    let _guard = DB_LOCK.lock().unwrap();
    let conn = get_connection()?;
    let _ = conn.execute("UPDATE tasks SET category_id = NULL WHERE category_id = ?1", params![id]);
    let _ = conn.execute("UPDATE schedules SET category_id = NULL WHERE category_id = ?1", params![id]);
    let _ = conn.execute("UPDATE calendar_events SET category_id = NULL WHERE category_id = ?1", params![id]);
    conn.execute("DELETE FROM categories WHERE id = ?1", params![id])?;
    Ok(())
}

// ==========================================
// NOTES CRUD (Quick Notes System)
// ==========================================

pub fn db_get_notes() -> Result<Vec<NoteRecord>> {
    let _guard = DB_LOCK.lock().unwrap();
    let conn = get_connection()?;
    let mut stmt = conn.prepare(
        "SELECT id, title, content, timestamp FROM notes ORDER BY timestamp DESC, id DESC",
    )?;

    let iter = stmt.query_map([], |row| {
        Ok(NoteRecord {
            id: row.get(0)?,
            title: row.get(1)?,
            content: row.get(2)?,
            timestamp: row.get(3)?,
        })
    })?;

    let mut list = Vec::new();
    for n in iter {
        list.push(n?);
    }
    Ok(list)
}

pub fn db_add_note(title: &str, content: &str) -> Result<i64> {
    let _guard = DB_LOCK.lock().unwrap();
    let conn = get_connection()?;
    conn.execute(
        "INSERT INTO notes (title, content, timestamp) VALUES (?1, ?2, datetime('now', 'localtime'))",
        params![title.trim(), content.trim()],
    )?;
    Ok(conn.last_insert_rowid())
}

pub fn db_update_note(id: i64, title: &str, content: &str) -> Result<()> {
    let _guard = DB_LOCK.lock().unwrap();
    let conn = get_connection()?;
    conn.execute(
        "UPDATE notes SET title = ?1, content = ?2, timestamp = datetime('now', 'localtime') WHERE id = ?3",
        params![title.trim(), content.trim(), id],
    )?;
    Ok(())
}

pub fn db_delete_note(id: i64) -> Result<()> {
    let _guard = DB_LOCK.lock().unwrap();
    let conn = get_connection()?;
    conn.execute("DELETE FROM notes WHERE id = ?1", params![id])?;
    Ok(())
}

// ==========================================
// NOTIFICATION DAEMON (notify-rust)
// ==========================================

pub fn start_notification_daemon() {
    // Las notificaciones de eventos ahora son gestionadas y embellecidas de manera
    // centralizada por `scheduler.rs`, enrutándolas proactivamente a Telegram vía teloxide.
    eprintln!("[NotificationDaemon] Notificaciones de calendario centralizadas en scheduler.rs con embellecimiento IA.");
}

// ==========================================
// TAURI COMMANDS
// ==========================================

#[tauri::command]
pub fn get_calendar_events() -> std::result::Result<Vec<CalendarEvent>, String> {
    db_get_calendar_events().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn add_calendar_event(
    title: String,
    event_date: String,
    event_time: String,
    notify_before_mins: Option<i32>,
    category_id: Option<i64>,
) -> std::result::Result<i64, String> {
    db_add_calendar_event(
        &title,
        &event_date,
        &event_time,
        notify_before_mins.unwrap_or(15),
        category_id,
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_calendar_event(id: i64) -> std::result::Result<(), String> {
    db_delete_calendar_event(id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_tasks() -> std::result::Result<Vec<TaskRecord>, String> {
    db_get_tasks().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn add_task(title: String, category_id: Option<i64>) -> std::result::Result<i64, String> {
    db_add_task(&title, category_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn toggle_task(id: i64, completed: bool) -> std::result::Result<(), String> {
    db_toggle_task(id, completed).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_task(id: i64) -> std::result::Result<(), String> {
    db_delete_task(id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_schedules() -> std::result::Result<Vec<ScheduleBlock>, String> {
    db_get_schedules().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn add_schedule(
    day_of_week: String,
    block_name: String,
    start_time: String,
    end_time: String,
    category_id: Option<i64>,
) -> std::result::Result<i64, String> {
    db_add_schedule(&day_of_week, &block_name, &start_time, &end_time, category_id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_schedule(id: i64) -> std::result::Result<(), String> {
    db_delete_schedule(id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_extensions() -> std::result::Result<Vec<ExtensionRecord>, String> {
    db_get_extensions().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_categories_by_module(module_type: String) -> std::result::Result<Vec<CategoryItem>, String> {
    db_get_categories_by_module(&module_type).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn add_category(app: tauri::AppHandle, name: String, module_type: String) -> std::result::Result<i64, String> {
    let id = db_add_category(&name, &module_type).map_err(|e| e.to_string())?;
    let _ = app.emit("refresh-categories", &module_type);
    Ok(id)
}

#[tauri::command]
pub fn delete_category(app: tauri::AppHandle, id: i64) -> std::result::Result<(), String> {
    db_delete_category(id).map_err(|e| e.to_string())?;
    let _ = app.emit("refresh-categories", ());
    Ok(())
}

#[tauri::command]
pub fn get_notes() -> std::result::Result<Vec<NoteRecord>, String> {
    db_get_notes().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn add_note(app: tauri::AppHandle, title: String, content: String) -> std::result::Result<i64, String> {
    let id = db_add_note(&title, &content).map_err(|e| e.to_string())?;
    let _ = app.emit("refresh-notes", ());
    Ok(id)
}

#[tauri::command]
pub fn update_note(
    app: tauri::AppHandle,
    id: i64,
    title: String,
    content: String,
) -> std::result::Result<(), String> {
    db_update_note(id, &title, &content).map_err(|e| e.to_string())?;
    let _ = app.emit("refresh-notes", ());
    Ok(())
}

#[tauri::command]
pub fn delete_note(app: tauri::AppHandle, id: i64) -> std::result::Result<(), String> {
    db_delete_note(id).map_err(|e| e.to_string())?;
    let _ = app.emit("refresh-notes", ());
    Ok(())
}

// ==========================================
// WHATSAPP CONTACTS CRUD & RESOLUTION
// ==========================================

pub fn db_get_whatsapp_contacts() -> Result<Vec<WhatsAppContact>> {
    let _guard = DB_LOCK.lock().unwrap();
    let conn = get_connection()?;
    let mut stmt = conn.prepare("SELECT id, name FROM whatsapp_contacts ORDER BY name ASC")?;
    let iter = stmt.query_map([], |row| {
        Ok(WhatsAppContact {
            id: row.get(0)?,
            name: row.get(1)?,
        })
    })?;
    let mut contacts = Vec::new();
    for c in iter {
        contacts.push(c?);
    }
    Ok(contacts)
}

pub fn db_upsert_whatsapp_contact(id: &str, name: &str) -> Result<()> {
    let _guard = DB_LOCK.lock().unwrap();
    let conn = get_connection()?;
    conn.execute(
        "INSERT INTO whatsapp_contacts (id, name) VALUES (?1, ?2)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name",
        params![id, name],
    )?;
    Ok(())
}

pub fn db_upsert_whatsapp_contacts_batch(contacts: &[WhatsAppContact]) -> Result<usize> {
    let _guard = DB_LOCK.lock().unwrap();
    let mut conn = get_connection()?;
    let tx = conn.transaction()?;
    let mut count = 0;
    {
        let mut check_stmt = tx.prepare("SELECT 1 FROM deleted_whatsapp_contacts WHERE id = ?1")?;
        let mut stmt = tx.prepare(
            "INSERT INTO whatsapp_contacts (id, name) VALUES (?1, ?2)
             ON CONFLICT(id) DO UPDATE SET name = excluded.name",
        )?;
        for c in contacts {
            let trimmed_id = c.id.trim();
            let trimmed_name = c.name.trim();
            if !trimmed_id.is_empty() && !trimmed_name.is_empty() {
                let is_deleted = check_stmt.exists(params![trimmed_id]).unwrap_or(false);
                if !is_deleted {
                    let _ = stmt.execute(params![trimmed_id, trimmed_name]);
                    count += 1;
                }
            }
        }
    }
    tx.commit()?;
    Ok(count)
}

pub fn db_delete_whatsapp_contact(id: &str) -> Result<()> {
    let _guard = DB_LOCK.lock().unwrap();
    let conn = get_connection()?;
    let alt_id = if id.contains("@c.us") {
        id.replace("@c.us", "@s.whatsapp.net")
    } else if id.contains("@s.whatsapp.net") {
        id.replace("@s.whatsapp.net", "@c.us")
    } else {
        id.to_string()
    };
    let _ = conn.execute(
        "INSERT OR IGNORE INTO deleted_whatsapp_contacts (id) VALUES (?1), (?2)",
        params![id, &alt_id],
    );
    conn.execute(
        "DELETE FROM whatsapp_contacts WHERE id = ?1 OR id = ?2",
        params![id, &alt_id],
    )?;
    Ok(())
}

pub fn db_delete_whatsapp_contacts_batch(ids: &[String]) -> Result<usize> {
    if ids.is_empty() {
        return Ok(0);
    }
    let _guard = DB_LOCK.lock().unwrap();
    let mut conn = get_connection()?;
    let tx = conn.transaction()?;
    let mut deleted = 0;
    {
        let mut ins_stmt = tx.prepare("INSERT OR IGNORE INTO deleted_whatsapp_contacts (id) VALUES (?1)")?;
        let mut del_stmt = tx.prepare("DELETE FROM whatsapp_contacts WHERE id = ?1 OR id = ?2")?;
        for id in ids {
            let alt_id = if id.contains("@c.us") {
                id.replace("@c.us", "@s.whatsapp.net")
            } else if id.contains("@s.whatsapp.net") {
                id.replace("@s.whatsapp.net", "@c.us")
            } else {
                id.clone()
            };
            let _ = ins_stmt.execute(params![id]);
            let _ = ins_stmt.execute(params![&alt_id]);
            deleted += del_stmt.execute(params![id, &alt_id])?;
        }
    }
    tx.commit()?;
    Ok(deleted)
}

/// Resolución Inteligente: SELECT id, name FROM whatsapp_contacts WHERE name LIKE '%Query%' LIMIT 1
pub fn db_find_whatsapp_contact_by_name(query: &str) -> Option<(String, String)> {
    let raw = query.trim();
    if raw.is_empty() {
        return None;
    }

    // Si ya viene con @s.whatsapp.net o @g.us
    if raw.ends_with("@s.whatsapp.net") || raw.ends_with("@g.us") {
        return Some((raw.to_string(), raw.to_string()));
    }

    // Si es un número de teléfono directo (>= 9 dígitos)
    let digits: String = raw.chars().filter(|c| c.is_ascii_digit()).collect();
    if digits.len() >= 9 {
        let jid = if digits.len() == 9 && (digits.starts_with('6') || digits.starts_with('7')) {
            format!("34{}@s.whatsapp.net", digits)
        } else {
            format!("{}@s.whatsapp.net", digits)
        };
        return Some((jid, raw.to_string()));
    }

    let _guard = DB_LOCK.lock().unwrap();
    let conn = get_connection().ok()?;

    // Consulta exacta requerida: SELECT id, name FROM whatsapp_contacts WHERE name LIKE '%Name%' LIMIT 1
    let pattern = format!("%{}%", raw);
    let mut stmt = conn
        .prepare("SELECT id, name FROM whatsapp_contacts WHERE name LIKE ?1 LIMIT 1")
        .ok()?;

    let mut rows = stmt.query(params![pattern]).ok()?;
    if let Some(row) = rows.next().ok().flatten() {
        let jid: String = row.get(0).ok()?;
        let name: String = row.get(1).ok()?;
        return Some((jid, name));
    }

    None
}

#[tauri::command]
pub fn get_whatsapp_contacts() -> std::result::Result<Vec<WhatsAppContact>, String> {
    db_get_whatsapp_contacts().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn add_whatsapp_contact(id: String, name: String) -> std::result::Result<(), String> {
    let jid = if !id.contains('@') {
        let digits: String = id.chars().filter(|c| c.is_ascii_digit()).collect();
        if digits.len() == 9 && (digits.starts_with('6') || digits.starts_with('7')) {
            format!("34{}@s.whatsapp.net", digits)
        } else {
            format!("{}@s.whatsapp.net", digits)
        }
    } else {
        id
    };
    db_upsert_whatsapp_contact(&jid, &name).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_whatsapp_contact(id: String) -> std::result::Result<(), String> {
    db_delete_whatsapp_contact(&id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_whatsapp_contacts_batch(ids: Vec<String>) -> std::result::Result<usize, String> {
    db_delete_whatsapp_contacts_batch(&ids).map_err(|e| e.to_string())
}

// ==========================================
// CLIPBOARD HISTORY CRUD
// ==========================================

pub fn db_insert_clipboard(
    content_type: &str,
    preview: &str,
    full_content: &str,
    meta_info: &str,
) -> Result<ClipboardRecord> {
    let _guard = DB_LOCK.lock().unwrap();
    let conn = get_connection()?;
    let now = chrono::Utc::now().timestamp_millis();
    conn.execute(
        "INSERT INTO clipboard_history (content_type, preview, full_content, meta_info, timestamp) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![content_type, preview, full_content, meta_info, now],
    )?;
    let id = conn.last_insert_rowid();

    // Mantener un historial máximo de 100 elementos
    let _ = conn.execute(
        "DELETE FROM clipboard_history WHERE id NOT IN (SELECT id FROM clipboard_history ORDER BY timestamp DESC LIMIT 100)",
        [],
    );

    Ok(ClipboardRecord {
        id,
        content_type: content_type.to_string(),
        preview: preview.to_string(),
        full_content: full_content.to_string(),
        meta_info: meta_info.to_string(),
        timestamp: now,
    })
}

pub fn db_get_clipboard_history(limit: usize) -> Result<Vec<ClipboardRecord>> {
    let _guard = DB_LOCK.lock().unwrap();
    let conn = get_connection()?;
    let mut stmt = conn.prepare(
        "SELECT id, content_type, preview, full_content, meta_info, timestamp FROM clipboard_history ORDER BY timestamp DESC LIMIT ?1"
    )?;
    let rows = stmt.query_map(params![limit as i64], |row| {
        Ok(ClipboardRecord {
            id: row.get(0)?,
            content_type: row.get(1)?,
            preview: row.get(2)?,
            full_content: row.get(3)?,
            meta_info: row.get(4)?,
            timestamp: row.get(5)?,
        })
    })?;
    let mut list = Vec::new();
    for r in rows {
        if let Ok(item) = r {
            list.push(item);
        }
    }
    Ok(list)
}

pub fn db_get_clipboard_item(id: i64) -> Result<ClipboardRecord> {
    let _guard = DB_LOCK.lock().unwrap();
    let conn = get_connection()?;
    let mut stmt = conn.prepare(
        "SELECT id, content_type, preview, full_content, meta_info, timestamp FROM clipboard_history WHERE id = ?1"
    )?;
    stmt.query_row(params![id], |row| {
        Ok(ClipboardRecord {
            id: row.get(0)?,
            content_type: row.get(1)?,
            preview: row.get(2)?,
            full_content: row.get(3)?,
            meta_info: row.get(4)?,
            timestamp: row.get(5)?,
        })
    })
}

pub fn db_delete_clipboard_item(id: i64) -> Result<()> {
    let _guard = DB_LOCK.lock().unwrap();
    let conn = get_connection()?;
    conn.execute("DELETE FROM clipboard_history WHERE id = ?1", params![id])?;
    Ok(())
}

pub fn db_clear_clipboard_history() -> Result<()> {
    let _guard = DB_LOCK.lock().unwrap();
    let conn = get_connection()?;
    conn.execute("DELETE FROM clipboard_history", [])?;
    Ok(())
}

#[tauri::command]
pub fn get_clipboard_history(limit: Option<usize>) -> std::result::Result<Vec<ClipboardRecord>, String> {
    db_get_clipboard_history(limit.unwrap_or(50)).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_clipboard_item(id: i64) -> std::result::Result<(), String> {
    db_delete_clipboard_item(id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn clear_clipboard_history() -> std::result::Result<(), String> {
    db_clear_clipboard_history().map_err(|e| e.to_string())
}


#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_init_db() {
        init_db().unwrap();
        let cats = db_get_categories_by_module("tasks").unwrap();
        assert!(!cats.is_empty());
        let notes = db_get_notes().unwrap();
        assert!(!notes.is_empty());
    }
}
