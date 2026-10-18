//! Native FreeDesktop Notifications D-Bus Service for KDE / Wayland
//!
//! Provides the standard `org.freedesktop.Notifications` service on the session bus.
//! This ensures that when Antigravity IDE, Electron, browsers, or system utilities send
//! notifications, they return IMMEDIATELY (< 1ms) rather than hanging on KDE's default
//! `plasma_waitforname` (which blocks for 25-30s when plasmashell is not running).

use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use tauri::{AppHandle, Emitter};

static NOTIFICATION_COUNTER: AtomicU32 = AtomicU32::new(1);

pub struct NotificationServer {
    app_handle: AppHandle,
}

impl NotificationServer {
    pub fn new(app_handle: AppHandle) -> Self {
        Self { app_handle }
    }
}

static DBUS_CONN: tokio::sync::OnceCell<zbus::Connection> = tokio::sync::OnceCell::const_new();

fn get_string_hint(hints: &HashMap<String, zbus::zvariant::OwnedValue>, key: &str) -> Option<String> {
    hints.get(key).and_then(|v| {
        <&str>::try_from(v).ok().map(|s| s.to_string())
    })
}

#[zbus::interface(name = "org.freedesktop.Notifications")]
impl NotificationServer {
    async fn get_server_information(&self) -> (String, String, String, String) {
        (
            "EnigmaOS".to_string(),
            "EnigmaOS Team".to_string(),
            "1.0.0".to_string(),
            "1.2".to_string(),
        )
    }

    async fn get_capabilities(&self) -> Vec<String> {
        vec![
            "body".to_string(),
            "body-markup".to_string(),
            "body-images".to_string(),
            "actions".to_string(),
            "icon-static".to_string(),
            "persistence".to_string(),
            "x-kde-origin-name".to_string(),
        ]
    }

    #[zbus(signal)]
    async fn action_invoked(emitter: &zbus::object_server::SignalEmitter<'_>, id: u32, action_key: &str) -> zbus::Result<()>;

    #[zbus(signal)]
    async fn notification_closed(emitter: &zbus::object_server::SignalEmitter<'_>, id: u32, reason: u32) -> zbus::Result<()>;

    #[zbus(signal)]
    async fn activation_token(emitter: &zbus::object_server::SignalEmitter<'_>, id: u32, token: &str) -> zbus::Result<()>;

    #[zbus(signal)]
    async fn notification_replied(emitter: &zbus::object_server::SignalEmitter<'_>, id: u32, text: &str) -> zbus::Result<()>;

    #[allow(clippy::too_many_arguments)]
    async fn notify(
        &self,
        app_name: String,
        replaces_id: u32,
        app_icon: String,
        summary: String,
        body: String,
        actions: Vec<String>,
        hints: HashMap<String, zbus::zvariant::OwnedValue>,
        expire_timeout: i32,
    ) -> u32 {
        let id = if replaces_id != 0 {
            replaces_id
        } else {
            NOTIFICATION_COUNTER.fetch_add(1, Ordering::Relaxed)
        };

        let image_path = get_string_hint(&hints, "image-path")
            .or_else(|| get_string_hint(&hints, "image_path"))
            .unwrap_or_default();
        let origin_name = get_string_hint(&hints, "x-kde-origin-name").unwrap_or_default();
        let desktop_entry = get_string_hint(&hints, "desktop-entry").unwrap_or_default();

        eprintln!(
            "[DesktopNotifications] #{} [{}] (origin: '{}', img: '{}') {} - {}",
            id, app_name, origin_name, image_path, summary, body
        );

        // Emit to frontend (Notch / Topbar) so it can display the banner if desired
        let _ = self.app_handle.emit(
            "desktop-notification",
            serde_json::json!({
                "id": id,
                "app_name": app_name,
                "app_icon": app_icon,
                "summary": summary,
                "body": body,
                "actions": actions,
                "expire_timeout": expire_timeout,
                "image_path": image_path,
                "origin_name": origin_name,
                "desktop_entry": desktop_entry,
            }),
        );

        id
    }

    async fn close_notification(&self, id: u32) {
        eprintln!("[DesktopNotifications] Closed #{}", id);
        let _ = emit_notification_closed(id, 2).await;
    }
}

pub async fn emit_action_invoked(id: u32, action_key: &str) -> Result<(), String> {
    if let Some(conn) = DBUS_CONN.get() {
        let _ = conn.emit_signal(
            None::<()>,
            "/org/freedesktop/Notifications",
            "org.freedesktop.Notifications",
            "ActionInvoked",
            &(id, action_key),
        )
        .await
        .map_err(|e| e.to_string());
    }
    Ok(())
}

pub async fn emit_notification_closed(id: u32, reason: u32) -> Result<(), String> {
    if let Some(conn) = DBUS_CONN.get() {
        let _ = conn.emit_signal(
            None::<()>,
            "/org/freedesktop/Notifications",
            "org.freedesktop.Notifications",
            "NotificationClosed",
            &(id, reason),
        )
        .await
        .map_err(|e| e.to_string());
    }
    Ok(())
}

#[tauri::command]
pub async fn invoke_desktop_notification_action(id: u32, action: String) -> Result<(), String> {
    emit_action_invoked(id, &action).await
}

#[tauri::command]
pub async fn close_desktop_notification(id: u32) -> Result<(), String> {
    emit_notification_closed(id, 2).await
}

pub struct PortalNotificationServer {
    app_handle: AppHandle,
}

impl PortalNotificationServer {
    pub fn new(app_handle: AppHandle) -> Self {
        Self { app_handle }
    }
}

#[zbus::interface(name = "org.freedesktop.impl.portal.Notification")]
impl PortalNotificationServer {
    async fn add_notification(
        &self,
        app_id: String,
        id: String,
        notification: HashMap<String, zbus::zvariant::OwnedValue>,
    ) -> zbus::fdo::Result<()> {
        let title = notification
            .get("title")
            .and_then(|v| <&str>::try_from(v).ok())
            .unwrap_or("Notificación")
            .to_string();
        let body = notification
            .get("body")
            .and_then(|v| <&str>::try_from(v).ok())
            .unwrap_or("")
            .to_string();
        let icon = notification
            .get("icon")
            .and_then(|v| <&str>::try_from(v).ok())
            .unwrap_or("")
            .to_string();

        let num_id = NOTIFICATION_COUNTER.fetch_add(1, Ordering::Relaxed);

        eprintln!(
            "[PortalNotifications] Add #{} app_id='{}' id='{}': '{}' - '{}'",
            num_id, app_id, id, title, body
        );

        let app_name = if !app_id.is_empty() {
            app_id
        } else {
            "Sistema".to_string()
        };

        let _ = self.app_handle.emit(
            "desktop-notification",
            serde_json::json!({
                "id": num_id,
                "app_name": app_name,
                "app_icon": icon,
                "summary": title,
                "body": body,
                "actions": vec![] as Vec<String>,
                "expire_timeout": 5000,
                "image_path": "",
                "origin_name": "",
                "desktop_entry": "",
            }),
        );

        Ok(())
    }

    async fn remove_notification(&self, app_id: String, id: String) -> zbus::fdo::Result<()> {
        eprintln!("[PortalNotifications] Remove app_id='{}' id='{}'", app_id, id);
        Ok(())
    }
}

/// Spawns the D-Bus Notification daemon and Portal Notification daemon on the session bus in a background task
pub fn start_notification_server(app_handle: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let server = NotificationServer::new(app_handle.clone());
        let portal_server = PortalNotificationServer::new(app_handle);

        match zbus::connection::Builder::session() {
            Ok(builder) => {
                match builder
                    .name("org.freedesktop.Notifications")
                    .and_then(|b| b.name("org.freedesktop.impl.portal.desktop.plasmanotify"))
                    .and_then(|b| b.serve_at("/org/freedesktop/Notifications", server))
                    .and_then(|b| b.serve_at("/org/freedesktop/portal/desktop", portal_server))
                {
                    Ok(b) => match b.build().await {
                        Ok(conn) => {
                            eprintln!("[DesktopNotifications] org.freedesktop.Notifications & org.freedesktop.impl.portal.desktop.plasmanotify ONLINE.");
                            let _ = DBUS_CONN.set(conn.clone());
                            // Hold connection open indefinitely
                            let _held = conn;
                            loop {
                                tokio::time::sleep(std::time::Duration::from_secs(3600)).await;
                            }
                        }
                        Err(e) => eprintln!("[DesktopNotifications] Failed to build D-Bus connection: {}", e),
                    },
                    Err(e) => eprintln!("[DesktopNotifications] Failed to serve notification interface: {}", e),
                }
            }
            Err(e) => eprintln!("[DesktopNotifications] Failed to create D-Bus session builder: {}", e),
        }
    });
}
