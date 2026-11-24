use crate::shell_explorer::{query_selected_file, window_class_name};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};
use windows::Win32::Foundation::HWND;
use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    GetAsyncKeyState, VK_CONTROL, VK_LWIN, VK_MENU, VK_RWIN, VK_SHIFT, VK_SPACE,
};
use windows::Win32::UI::WindowsAndMessaging::{
    GetForegroundWindow, GetGUIThreadInfo, GetWindowThreadProcessId, GUITHREADINFO,
};

/// Shared runtime state for background Explorer Spacebar QuickLook preview.
pub struct QuickLookState {
    pub enabled: Arc<AtomicBool>,
    pub last_path: Arc<Mutex<String>>,
}

impl Default for QuickLookState {
    fn default() -> Self {
        Self {
            enabled: Arc::new(AtomicBool::new(true)),
            last_path: Arc::new(Mutex::new(String::new())),
        }
    }
}

/// Start foreground Explorer watcher and STA COM selection resolver threads without global hooks.
pub fn start_quicklook_daemon(app: AppHandle, state: &QuickLookState) {
    let (tx, rx) = mpsc::channel::<(isize, isize)>();
    let enabled = Arc::clone(&state.enabled);
    let last_path = Arc::clone(&state.last_path);

    thread::spawn(move || run_com_worker(app, last_path, rx));
    thread::spawn(move || run_explorer_space_watcher(enabled, tx));
}

pub fn show_and_preview_path(app: &AppHandle, last_path: &Mutex<String>, path: &str) {
    let Some(win) = app.get_webview_window("main") else {
        return;
    };
    if let Ok(mut guard) = last_path.lock() {
        *guard = path.to_string();
    }
    let _ = app.emit("quicklook-open", path.to_string());
    let _ = win.unminimize();
    let _ = win.show();
    let _ = win.set_focus();
}

fn run_com_worker(
    app: AppHandle,
    last_path: Arc<Mutex<String>>,
    rx: mpsc::Receiver<(isize, isize)>,
) {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
    }

    while let Ok((fg_hwnd, focus_hwnd)) = rx.recv() {
        let Some(selected_file) = query_selected_file(fg_hwnd, focus_hwnd) else {
            continue;
        };
        let Some(win) = app.get_webview_window("main") else {
            continue;
        };

        let is_same_visible = win.is_visible().unwrap_or(false)
            && !win.is_minimized().unwrap_or(false)
            && last_path
                .lock()
                .map(|g| g.eq_ignore_ascii_case(&selected_file))
                .unwrap_or(false);

        if is_same_visible {
            let _ = win.emit("preview-hidden", ());
            let _ = win.hide();
        } else {
            show_and_preview_path(&app, &last_path, &selected_file);
        }
    }

    unsafe {
        CoUninitialize();
    }
}

// Watch Spacebar presses only while Windows Explorer or Desktop holds foreground focus,
// avoiding global WH_KEYBOARD_LL hooks that trigger false positives in antivirus monitors.
fn run_explorer_space_watcher(enabled: Arc<AtomicBool>, tx: Sender<(isize, isize)>) {
    let mut space_was_down = false;

    loop {
        if !enabled.load(Ordering::Relaxed) {
            space_was_down = false;
            thread::sleep(Duration::from_millis(250));
            continue;
        }

        let fg = unsafe { GetForegroundWindow() };
        let fg_raw = fg.0 as isize;
        let top_class = window_class_name(fg_raw);
        if !matches!(
            top_class.as_str(),
            "CabinetWClass" | "ExploreWClass" | "Progman" | "WorkerW"
        ) {
            space_was_down = false;
            thread::sleep(Duration::from_millis(120));
            continue;
        }

        let is_down = (unsafe { GetAsyncKeyState(VK_SPACE.0 as i32) } as u16 & 0x8000) != 0;
        if is_down && !space_was_down && !has_modifiers() {
            if let Some(targets) = detect_explorer_list_focus(fg, fg_raw) {
                let _ = tx.send(targets);
            }
        }

        space_was_down = is_down;
        thread::sleep(Duration::from_millis(18));
    }
}

fn has_modifiers() -> bool {
    let keys = [
        VK_CONTROL.0 as i32,
        VK_MENU.0 as i32,
        VK_SHIFT.0 as i32,
        VK_LWIN.0 as i32,
        VK_RWIN.0 as i32,
    ];
    keys.into_iter()
        .any(|vk| (unsafe { GetAsyncKeyState(vk) } as u16 & 0x8000) != 0)
}

/// Verify that Explorer/Desktop focus is on file items rather than an active text caret.
fn detect_explorer_list_focus(fg: HWND, fg_raw: isize) -> Option<(isize, isize)> {
    let tid = unsafe { GetWindowThreadProcessId(fg, None) };
    let mut gui = GUITHREADINFO {
        cbSize: std::mem::size_of::<GUITHREADINFO>() as u32,
        ..Default::default()
    };
    if unsafe { GetGUIThreadInfo(tid, &mut gui) }.is_err() {
        return None;
    }
    if !gui.hwndCaret.0.is_null() {
        return None;
    }

    let focus_raw = gui.hwndFocus.0 as isize;
    let focus_class = window_class_name(focus_raw);
    matches!(
        focus_class.as_str(),
        "DirectUIHWND" | "SysListView32" | "SHELLDLL_DefView"
    )
    .then_some((fg_raw, focus_raw))
}
