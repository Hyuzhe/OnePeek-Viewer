use std::path::Path;
use windows::core::Interface;
use windows::Win32::Foundation::HWND;
use windows::Win32::System::Com::{
    CoCreateInstance, IDataObject, IDispatch, IServiceProvider, CLSCTX_ALL, DVASPECT_CONTENT,
    FORMATETC, TYMED_HGLOBAL,
};
use windows::Win32::System::Ole::{ReleaseStgMedium, CF_HDROP, IOleWindow};
use windows::Win32::System::Variant::VARIANT;
use windows::Win32::UI::Shell::{
    DragQueryFileW, IShellBrowser, IShellView, IShellWindows, IWebBrowserApp,
    SID_STopLevelBrowser, SVGIO_SELECTION, SWC_DESKTOP, SWFO_NEEDDISPATCH, ShellWindows, HDROP,
};
use windows::Win32::UI::WindowsAndMessaging::{GetClassNameW, IsChild, IsWindowVisible};

/// Read Win32 window class name as a Rust String.
pub fn window_class_name(hwnd_raw: isize) -> String {
    if hwnd_raw == 0 {
        return String::new();
    }
    let hwnd = HWND(hwnd_raw as *mut _);
    let mut buf = [0u16; 128];
    let len = unsafe { GetClassNameW(hwnd, &mut buf) };
    if len <= 0 {
        return String::new();
    }
    String::from_utf16_lossy(&buf[..len as usize])
}

/// Query the first selected regular file path from Explorer or Desktop.
pub fn query_selected_file(fg_hwnd: isize, focus_hwnd: isize) -> Option<String> {
    let class = window_class_name(fg_hwnd);
    let shell_windows: IShellWindows =
        unsafe { CoCreateInstance(&ShellWindows, None, CLSCTX_ALL).ok()? };

    let browser = match class.as_str() {
        "Progman" | "WorkerW" => resolve_desktop_browser(&shell_windows)?,
        "CabinetWClass" | "ExploreWClass" => {
            resolve_explorer_tab_browser(&shell_windows, fg_hwnd, focus_hwnd)?
        }
        _ => return None,
    };

    let selected = extract_selection_path(&browser)?;
    Path::new(&selected).is_file().then_some(selected)
}

fn resolve_desktop_browser(shell_windows: &IShellWindows) -> Option<IShellBrowser> {
    let mut desktop_hwnd = 0i32;
    let disp: IDispatch = unsafe {
        shell_windows
            .FindWindowSW(
                &VARIANT::default(),
                &VARIANT::default(),
                SWC_DESKTOP,
                &mut desktop_hwnd,
                SWFO_NEEDDISPATCH,
            )
            .ok()?
    };
    dispatch_to_shell_browser(&disp)
}

fn resolve_explorer_tab_browser(
    shell_windows: &IShellWindows,
    fg_hwnd: isize,
    focus_hwnd: isize,
) -> Option<IShellBrowser> {
    let count = unsafe { shell_windows.Count().ok()? };
    let mut fallback: Option<IShellBrowser> = None;

    for idx in 0..count {
        let Ok(disp) = (unsafe { shell_windows.Item(&VARIANT::from(idx)) }) else {
            continue;
        };
        let Ok(wb) = disp.cast::<IWebBrowserApp>() else {
            continue;
        };
        let Ok(wb_hwnd) = (unsafe { wb.HWND() }) else {
            continue;
        };
        if wb_hwnd.0 as isize != fg_hwnd {
            continue;
        }
        let Some(sb) = dispatch_to_shell_browser(&disp) else {
            continue;
        };

        if is_active_shell_tab(&sb, focus_hwnd) {
            return Some(sb);
        }
        if fallback.is_none() && is_visible_shell_tab(&sb) {
            fallback = Some(sb);
        }
    }
    fallback
}

fn dispatch_to_shell_browser(disp: &IDispatch) -> Option<IShellBrowser> {
    let provider: IServiceProvider = disp.cast().ok()?;
    unsafe { provider.QueryService(&SID_STopLevelBrowser).ok() }
}

fn is_active_shell_tab(sb: &IShellBrowser, focus_hwnd: isize) -> bool {
    if focus_hwnd == 0 {
        return false;
    }
    let Ok(ole_win) = sb.cast::<IOleWindow>() else {
        return false;
    };
    let Ok(tab_hwnd) = (unsafe { ole_win.GetWindow() }) else {
        return false;
    };
    let focus = HWND(focus_hwnd as *mut _);
    tab_hwnd.0 as isize == focus_hwnd || unsafe { IsChild(tab_hwnd, focus).as_bool() }
}

fn is_visible_shell_tab(sb: &IShellBrowser) -> bool {
    let Ok(ole_win) = sb.cast::<IOleWindow>() else {
        return true;
    };
    let Ok(tab_hwnd) = (unsafe { ole_win.GetWindow() }) else {
        return true;
    };
    unsafe { IsWindowVisible(tab_hwnd).as_bool() }
}

fn extract_selection_path(sb: &IShellBrowser) -> Option<String> {
    let shell_view: IShellView = unsafe { sb.QueryActiveShellView().ok()? };
    let data_obj: IDataObject = unsafe { shell_view.GetItemObject(SVGIO_SELECTION).ok()? };

    let fmt = FORMATETC {
        cfFormat: CF_HDROP.0,
        ptd: std::ptr::null_mut(),
        dwAspect: DVASPECT_CONTENT.0,
        lindex: -1,
        tymed: TYMED_HGLOBAL.0 as u32,
    };

    let mut medium = unsafe { data_obj.GetData(&fmt).ok()? };
    let path = unsafe {
        let hdrop = HDROP(medium.u.hGlobal.0);
        let count = DragQueryFileW(hdrop, 0xFFFF_FFFF, None);
        let result = if count > 0 {
            let mut buf = [0u16; 1024];
            let chars = DragQueryFileW(hdrop, 0, Some(&mut buf));
            (chars > 0).then(|| String::from_utf16_lossy(&buf[..chars as usize]))
        } else {
            None
        };
        ReleaseStgMedium(&mut medium);
        result
    };
    path
}
