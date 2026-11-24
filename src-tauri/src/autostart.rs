// Autostart manager using user Startup folder shortcut (.lnk) to avoid antivirus registry alerts.

use std::fs;
use std::path::{Path, PathBuf};
use windows::core::{Interface, PCWSTR};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoUninitialize, IPersistFile, CLSCTX_INPROC_SERVER,
    COINIT_APARTMENTTHREADED,
};
use windows::Win32::System::Registry::{
    RegCloseKey, RegDeleteValueW, RegOpenKeyExW, RegQueryValueExW, HKEY, HKEY_CURRENT_USER,
    KEY_READ, KEY_SET_VALUE,
};
use windows::Win32::UI::Shell::{IShellLinkW, ShellLink};

const LEGACY_RUN_SUBKEY: &str = "Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const APP_NAME: &str = "OnePeekCommunity";

struct ComApartmentGuard(bool);

impl Drop for ComApartmentGuard {
    fn drop(&mut self) {
        if self.0 {
            unsafe {
                CoUninitialize();
            }
        }
    }
}

fn to_wide_null(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

fn startup_lnk_path() -> Option<PathBuf> {
    let appdata = std::env::var_os("APPDATA")?;
    Some(
        PathBuf::from(appdata)
            .join("Microsoft")
            .join("Windows")
            .join("Start Menu")
            .join("Programs")
            .join("Startup")
            .join(format!("{APP_NAME}.lnk")),
    )
}

fn has_legacy_registry_run() -> bool {
    unsafe {
        let subkey = to_wide_null(LEGACY_RUN_SUBKEY);
        let value_name = to_wide_null(APP_NAME);
        let mut hkey = HKEY::default();

        if RegOpenKeyExW(HKEY_CURRENT_USER, PCWSTR(subkey.as_ptr()), Some(0), KEY_READ, &mut hkey)
            .is_err()
        {
            return false;
        }

        let mut byte_len: u32 = 0;
        let exists = RegQueryValueExW(
            hkey,
            PCWSTR(value_name.as_ptr()),
            None,
            None,
            None,
            Some(&mut byte_len),
        )
        .is_ok()
            && byte_len > 2;

        let _ = RegCloseKey(hkey);
        exists
    }
}

fn clear_legacy_registry_run() {
    if !has_legacy_registry_run() {
        return;
    }
    unsafe {
        let subkey = to_wide_null(LEGACY_RUN_SUBKEY);
        let value_name = to_wide_null(APP_NAME);
        let mut hkey = HKEY::default();

        if RegOpenKeyExW(
            HKEY_CURRENT_USER,
            PCWSTR(subkey.as_ptr()),
            Some(0),
            KEY_SET_VALUE,
            &mut hkey,
        )
        .is_ok()
        {
            let _ = RegDeleteValueW(hkey, PCWSTR(value_name.as_ptr()));
            let _ = RegCloseKey(hkey);
        }
    }
}

fn create_shortcut_lnk(lnk_path: &Path, target_exe: &Path, args: &str) -> Result<(), String> {
    if let Some(parent) = lnk_path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Failed to create Startup dir: {e}"))?;
    }

    let target_w = to_wide_null(&target_exe.to_string_lossy());
    let args_w = to_wide_null(args);
    let desc_w = to_wide_null("OnePeek QuickLook Background Tray");
    let work_dir = target_exe
        .parent()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();
    let work_dir_w = to_wide_null(&work_dir);
    let lnk_w = to_wide_null(&lnk_path.to_string_lossy());

    unsafe {
        let co_hr = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        let _guard = ComApartmentGuard(co_hr.is_ok());

        let shell_link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER)
            .map_err(|e| format!("Failed creating ShellLink COM object: {e}"))?;

        shell_link
            .SetPath(PCWSTR(target_w.as_ptr()))
            .map_err(|e| format!("Failed setting shortcut target: {e}"))?;
        shell_link
            .SetArguments(PCWSTR(args_w.as_ptr()))
            .map_err(|e| format!("Failed setting shortcut args: {e}"))?;
        shell_link
            .SetWorkingDirectory(PCWSTR(work_dir_w.as_ptr()))
            .map_err(|e| format!("Failed setting shortcut workdir: {e}"))?;
        shell_link
            .SetDescription(PCWSTR(desc_w.as_ptr()))
            .map_err(|e| format!("Failed setting shortcut description: {e}"))?;

        let persist: IPersistFile = shell_link
            .cast()
            .map_err(|e| format!("Failed querying IPersistFile: {e}"))?;
        persist
            .Save(PCWSTR(lnk_w.as_ptr()), true)
            .map_err(|e| format!("Failed saving shortcut .lnk file: {e}"))?;
    }

    Ok(())
}

/// Check whether OnePeek autostart shortcut or legacy Run entry is configured.
pub fn is_autostart_enabled() -> bool {
    startup_lnk_path().is_some_and(|p| p.is_file()) || has_legacy_registry_run()
}

/// Enable or remove silent Startup shortcut (.lnk) launch without touching Run registry on enable.
pub fn set_autostart_enabled(enable: bool) -> Result<bool, String> {
    let lnk = startup_lnk_path().ok_or_else(|| "Cannot resolve Startup folder path".to_string())?;

    if enable {
        let exe = std::env::current_exe()
            .map_err(|e| format!("Cannot locate executable path: {e}"))?;
        create_shortcut_lnk(&lnk, &exe, "--background")?;
        clear_legacy_registry_run();
        Ok(true)
    } else {
        if lnk.exists() {
            fs::remove_file(&lnk).map_err(|e| format!("Failed removing Startup shortcut: {e}"))?;
        }
        clear_legacy_registry_run();
        Ok(false)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_create_and_remove_shortcut_lnk() {
        let temp_lnk = std::env::temp_dir().join("onepeek_test_autostart.lnk");
        let exe = std::env::current_exe().expect("current_exe should exist");

        let _ = fs::remove_file(&temp_lnk);
        create_shortcut_lnk(&temp_lnk, &exe, "--background").expect("create .lnk should succeed");

        let meta = fs::metadata(&temp_lnk).expect("created .lnk metadata should exist");
        assert!(meta.is_file());
        assert!(meta.len() > 0);

        fs::remove_file(&temp_lnk).expect("cleanup test .lnk should succeed");
    }
}
