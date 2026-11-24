use crate::autostart::{is_autostart_enabled, set_autostart_enabled};
use crate::quicklook_daemon::{show_and_preview_path, QuickLookState};
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::Ordering;
use std::sync::Mutex;
use std::thread;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, WindowEvent, Wry};

#[derive(Default)]
pub struct TrayMenuHandles {
    pub autostart_item: Mutex<Option<MenuItem<Wry>>>,
}

pub fn format_autostart_label(enabled: bool) -> &'static str {
    if enabled {
        "开机静默自启：已开启（点击关闭）"
    } else {
        "开机静默自启：未开启（点击开启）"
    }
}

const IPC_ADDR: &str = "127.0.0.1:45872";
const SHOW_SIGNAL: &str = "__SHOW__";

/// Ensure only one background instance runs; wait briefly when replacing after an update.
pub fn acquire_single_instance(startup_arg: Option<&str>, post_update: bool) -> Option<TcpListener> {
    let max_attempts = if post_update { 30 } else { 1 };
    for attempt in 0..max_attempts {
        if let Ok(listener) = TcpListener::bind(IPC_ADDR) {
            return Some(listener);
        }
        if post_update && attempt + 1 < max_attempts {
            thread::sleep(std::time::Duration::from_millis(100));
        }
    }

    if let Ok(mut stream) = TcpStream::connect(IPC_ADDR) {
        let payload = startup_arg.unwrap_or(SHOW_SIGNAL);
        let _ = stream.write_all(payload.as_bytes());
    }
    None
}

/// Listen for file-open or window-restore requests forwarded by secondary launches.
pub fn spawn_ipc_receiver(listener: TcpListener, app: AppHandle) {
    thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            handle_secondary_connection(stream, &app);
        }
    });
}

fn handle_secondary_connection(mut stream: TcpStream, app: &AppHandle) {
    let mut buf = Vec::new();
    if stream.read_to_end(&mut buf).is_err() {
        return;
    }
    let msg = String::from_utf8_lossy(&buf).trim().to_string();
    if msg.is_empty() || msg == SHOW_SIGNAL {
        restore_main_window(app);
    } else if std::path::Path::new(&msg).is_file() {
        let ql = app.state::<QuickLookState>();
        show_and_preview_path(app, &ql.last_path, &msg);
    } else {
        restore_main_window(app);
    }
}

pub fn restore_main_window(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.unminimize();
        let _ = win.show();
        let _ = win.set_focus();
    }
}

/// Configure close button to hide window into background tray instead of exiting.
pub fn bind_close_to_tray(app: &AppHandle) {
    let Some(win) = app.get_webview_window("main") else {
        return;
    };
    let win_clone = win.clone();
    win.on_window_event(move |event| {
        if let WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            let _ = win_clone.emit("preview-hidden", ());
            let _ = win_clone.hide();
        }
    });
}

/// Build Windows system tray icon and right-click menu.
pub fn setup_system_tray(app: &AppHandle) -> tauri::Result<()> {
    let initial_autostart = is_autostart_enabled();
    let show_item = MenuItem::with_id(app, "show", "显示主窗口", true, None::<&str>)?;
    let toggle_item =
        MenuItem::with_id(app, "toggle_ql", "空格键预览：已开启（点击切换）", true, None::<&str>)?;
    let autostart_item = MenuItem::with_id(
        app,
        "toggle_autostart",
        format_autostart_label(initial_autostart),
        true,
        None::<&str>,
    )?;
    let sep = PredefinedMenuItem::separator(app)?;
    let quit_item = MenuItem::with_id(app, "quit", "彻底退出程序", true, None::<&str>)?;

    if let Ok(mut guard) = app.state::<TrayMenuHandles>().autostart_item.lock() {
        *guard = Some(autostart_item.clone());
    }

    let menu = Menu::with_items(
        app,
        &[&show_item, &toggle_item, &autostart_item, &sep, &quit_item],
    )?;
    let toggle_ref = toggle_item.clone();
    let autostart_ref = autostart_item.clone();

    let mut builder = TrayIconBuilder::new()
        .menu(&menu)
        .tooltip("OnePeek Community（选中文件按空格秒开预览）")
        .show_menu_on_left_click(false)
        .on_menu_event(move |app_handle, event| match event.id().as_ref() {
            "show" => restore_main_window(app_handle),
            "toggle_ql" => {
                let state = app_handle.state::<QuickLookState>();
                let prev = state.enabled.load(Ordering::Relaxed);
                let next = !prev;
                state.enabled.store(next, Ordering::Relaxed);
                let label = if next {
                    "空格键预览：已开启（点击切换）"
                } else {
                    "空格键预览：已暂停（点击开启）"
                };
                let _ = toggle_ref.set_text(label);
                let _ = app_handle.emit("quicklook-status", next);
            }
            "toggle_autostart" => {
                let next = !is_autostart_enabled();
                if let Ok(updated) = set_autostart_enabled(next) {
                    let _ = autostart_ref.set_text(format_autostart_label(updated));
                    let _ = app_handle.emit("autostart-status", updated);
                }
            }
            "quit" => app_handle.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                restore_main_window(tray.app_handle());
            }
        });

    if let Some(icon) = app.default_window_icon().cloned() {
        builder = builder.icon(icon);
    }
    builder.build(app)?;
    Ok(())
}
