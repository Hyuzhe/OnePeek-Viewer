#[cfg(windows)]
pub mod autostart;
pub mod archive_service;
pub mod fs_service;
pub mod html_engine;
pub mod media_server;
#[cfg(windows)]
pub mod quicklook_daemon;
#[cfg(windows)]
pub mod shell_explorer;
#[cfg(windows)]
pub mod tray_service;

use archive_service::{
    extract_archive_entry as extract_zip_entry_to_cache, inspect_zip, ZipEntryInfo,
};
#[cfg(windows)]
use autostart::{is_autostart_enabled, set_autostart_enabled as apply_autostart};
use fs_service::{
    inspect_with_siblings, read_raw_bytes, read_smart_text, DecodedText, FileContextPayload,
};
use html_engine::{mount_local_html, read_local_html_resource, ActiveHtmlState};
use media_server::MediaStreamState;
#[cfg(windows)]
use quicklook_daemon::{start_quicklook_daemon, QuickLookState};
use std::path::{Path, PathBuf};
#[cfg(windows)]
use std::sync::atomic::Ordering;
use tauri::{
    http::Response as HttpResponse,
    ipc::{InvokeBody, Request as IpcRequest, Response as IpcResponse},
    Emitter, Manager, State,
};
#[cfg(windows)]
use tray_service::{
    acquire_single_instance, bind_close_to_tray, format_autostart_label, setup_system_tray,
    spawn_ipc_receiver, TrayMenuHandles,
};

#[cfg(windows)]
fn detect_cli_file_arg() -> Option<String> {
    std::env::args()
        .skip(1)
        .find(|arg| !arg.starts_with('-') && Path::new(arg).is_file())
}

#[cfg(windows)]
#[tauri::command]
fn get_startup_file() -> Option<String> {
    detect_cli_file_arg()
}

#[cfg(not(windows))]
#[tauri::command]
fn get_startup_file(app: tauri::AppHandle) -> Option<String> {
    let dir = app.path().app_data_dir().ok()?;
    for marker in [
        dir.join("pending_open_path.txt"),
        dir.join("files").join("pending_open_path.txt"),
    ] {
        let Ok(raw) = std::fs::read_to_string(&marker) else {
            continue;
        };
        let _ = std::fs::remove_file(&marker);
        let trimmed = raw.trim().to_string();
        if !trimmed.is_empty() && Path::new(&trimmed).is_file() {
            return Some(trimmed);
        }
    }
    None
}

#[cfg(windows)]
#[tauri::command]
fn open_file_context(
    path: String,
    ql_state: State<'_, QuickLookState>,
) -> Result<FileContextPayload, String> {
    let payload = inspect_with_siblings(&path)?;
    if let Ok(mut guard) = ql_state.last_path.lock() {
        *guard = payload.current.path.clone();
    }
    Ok(payload)
}

#[cfg(not(windows))]
#[tauri::command]
fn open_file_context(path: String) -> Result<FileContextPayload, String> {
    inspect_with_siblings(&path)
}

fn sanitize_staged_filename(raw: &str) -> String {
    let decoded = percent_encoding::percent_decode_str(raw).decode_utf8_lossy();
    let leaf = Path::new(decoded.as_ref())
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("picked_file.bin");
    let cleaned: String = leaf
        .chars()
        .map(|c| {
            if c.is_control() || matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') {
                '_'
            } else {
                c
            }
        })
        .collect();
    if cleaned.trim().is_empty() {
        "picked_file.bin".into()
    } else {
        cleaned
    }
}

const MAX_STAGED_CACHE_BYTES: u64 = 64 * 1024 * 1024;
const MAX_STAGED_KEEP_COUNT: usize = 2;
const MAX_STAGED_AGE_SECS: u64 = 12 * 3600;

fn path_byte_size(path: &Path) -> u64 {
    let Ok(meta) = std::fs::symlink_metadata(path) else {
        return 0;
    };
    if meta.is_file() {
        return meta.len();
    }
    if !meta.is_dir() {
        return 0;
    }
    let Ok(entries) = std::fs::read_dir(path) else {
        return 0;
    };
    entries
        .flatten()
        .map(|entry| path_byte_size(&entry.path()))
        .sum()
}

fn resolve_staged_root_entry(staging_root: &Path, active_path: Option<&str>) -> Option<PathBuf> {
    let raw = active_path?.trim();
    if raw.is_empty() {
        return None;
    }
    let canon_root = std::fs::canonicalize(staging_root).ok()?;
    let canon_active = std::fs::canonicalize(raw).ok()?;
    let rel = canon_active.strip_prefix(&canon_root).ok()?;
    let first = rel.components().next()?;
    Some(canon_root.join(first.as_os_str()))
}

fn same_path_entry(a: &Path, b: &Path) -> bool {
    match (std::fs::canonicalize(a), std::fs::canonicalize(b)) {
        (Ok(ca), Ok(cb)) => ca == cb,
        _ => a == b,
    }
}

fn remove_staged_entry(path: &Path, is_dir: bool) {
    if is_dir {
        let _ = std::fs::remove_dir_all(path);
    } else {
        let _ = std::fs::remove_file(path);
    }
}

/// Prune staged external files/batches enforcing max age, item count, and cumulative byte budget.
pub fn prune_staged_cache_bounded(
    dir: &Path,
    keep_existing: usize,
    max_bytes: u64,
    protect_entry: Option<&Path>,
) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let now = std::time::SystemTime::now();
    let max_age = std::time::Duration::from_secs(MAX_STAGED_AGE_SECS);
    let mut candidates: Vec<(std::time::SystemTime, PathBuf, bool, u64)> = Vec::new();

    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(meta) = entry.metadata() else {
            continue;
        };
        let is_dir = meta.is_dir();
        if let Some(protected) = protect_entry {
            if same_path_entry(&path, protected) {
                continue;
            }
        }
        let mtime = meta.modified().unwrap_or(std::time::UNIX_EPOCH);
        let expired = now
            .duration_since(mtime)
            .map(|age| age > max_age)
            .unwrap_or(false);
        if expired {
            remove_staged_entry(&path, is_dir);
            continue;
        }
        let size = path_byte_size(&path);
        candidates.push((mtime, path, is_dir, size));
    }

    candidates.sort_by(|a, b| b.0.cmp(&a.0));
    let mut kept_count = 0usize;
    let mut kept_bytes = 0u64;

    for (_, path, is_dir, size) in candidates {
        if kept_count < keep_existing && kept_bytes.saturating_add(size) <= max_bytes {
            kept_count += 1;
            kept_bytes = kept_bytes.saturating_add(size);
        } else {
            remove_staged_entry(&path, is_dir);
        }
    }
}

fn extract_json_byte_array(val: &serde_json::Value) -> Option<Vec<u8>> {
    let arr = match val {
        serde_json::Value::Array(items) => items,
        serde_json::Value::Object(map) => map.get("bytes")?.as_array()?,
        _ => return None,
    };
    let mut out = Vec::with_capacity(arr.len());
    for item in arr {
        let n = item.as_u64()?;
        out.push(u8::try_from(n).ok()?);
    }
    Some(out)
}

fn extract_ipc_bytes<'a>(
    body: &'a InvokeBody,
    json_storage: &'a mut Vec<u8>,
) -> Result<&'a [u8], String> {
    match body {
        InvokeBody::Raw(buf) => Ok(buf),
        InvokeBody::Json(val) => {
            *json_storage = extract_json_byte_array(val)
                .ok_or_else(|| "Expected raw binary payload or byte array".to_string())?;
            Ok(json_storage.as_slice())
        }
    }
}

/// Stage raw bytes picked from Android/mobile file chooser into app cache directory.
#[tauri::command]
fn stage_picked_file(request: IpcRequest<'_>, app: tauri::AppHandle) -> Result<String, String> {
    let mut owned_json_bytes = Vec::new();
    let bytes = extract_ipc_bytes(request.body(), &mut owned_json_bytes)?;

    let raw_name = request
        .headers()
        .get("x-file-name")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("picked_file.bin");
    let safe_name = sanitize_staged_filename(raw_name);
    let batch_id: String = request
        .headers()
        .get("x-batch-id")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-')
        .take(32)
        .collect();

    let staging_root = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("Cannot resolve app cache dir: {e}"))?
        .join("opened_files");
    std::fs::create_dir_all(&staging_root)
        .map_err(|e| format!("Cannot create staging dir: {e}"))?;

    let target_dir = if batch_id.is_empty() {
        prune_staged_cache_bounded(&staging_root, 1, MAX_STAGED_CACHE_BYTES, None);
        staging_root
    } else {
        let batch_dir = staging_root.join(format!("batch_{batch_id}"));
        if !batch_dir.exists() {
            prune_staged_cache_bounded(&staging_root, 1, MAX_STAGED_CACHE_BYTES, None);
            std::fs::create_dir_all(&batch_dir)
                .map_err(|e| format!("Cannot create batch staging dir: {e}"))?;
        }
        batch_dir
    };

    let dest = target_dir.join(&safe_name);
    std::fs::write(&dest, bytes).map_err(|e| format!("Failed staging picked file: {e}"))?;
    Ok(dest.to_string_lossy().to_string())
}

const MAX_EXPORT_BYTES: usize = 256 * 1024 * 1024;

/// Write exported PNG/PDF bytes from the viewer directly to a user-chosen destination path.
#[tauri::command]
fn write_export_file(request: IpcRequest<'_>) -> Result<String, String> {
    let mut owned_json_bytes = Vec::new();
    let bytes = extract_ipc_bytes(request.body(), &mut owned_json_bytes)?;
    if bytes.len() > MAX_EXPORT_BYTES {
        return Err("Export payload exceeds 256 MB safety limit".to_string());
    }

    let raw_path = request
        .headers()
        .get("x-export-path")
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| "Missing export target path header".to_string())?;
    let decoded = percent_encoding::percent_decode_str(raw_path).decode_utf8_lossy();
    let trimmed = decoded.trim();
    if trimmed.is_empty() {
        return Err("Export target path cannot be empty".to_string());
    }

    let dest = PathBuf::from(trimmed);
    if let Some(parent) = dest.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("Cannot create export parent folder: {e}"))?;
        }
    }
    std::fs::write(&dest, bytes).map_err(|e| format!("Failed writing export file: {e}"))?;
    Ok(dest.to_string_lossy().into_owned())
}

/// Stage exported PNG/PDF bytes inside app cache before Android MediaStore/SAF persistence.
#[tauri::command]
fn stage_export_file(request: IpcRequest<'_>, app: tauri::AppHandle) -> Result<String, String> {
    let mut owned_json_bytes = Vec::new();
    let bytes = extract_ipc_bytes(request.body(), &mut owned_json_bytes)?;
    if bytes.len() > MAX_EXPORT_BYTES {
        return Err("Export payload exceeds 256 MB safety limit".to_string());
    }

    let raw_name = request
        .headers()
        .get("x-export-name")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("export.bin");
    let decoded_name = percent_encoding::percent_decode_str(raw_name).decode_utf8_lossy();
    let safe_name = sanitize_staged_filename(&decoded_name);

    let export_dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("Cannot resolve app cache dir: {e}"))?
        .join("exports");
    std::fs::create_dir_all(&export_dir)
        .map_err(|e| format!("Cannot create export cache dir: {e}"))?;
    prune_staged_cache_bounded(&export_dir, 1, MAX_STAGED_CACHE_BYTES, None);

    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let dest = export_dir.join(format!("{now_ms}_{safe_name}"));
    std::fs::write(&dest, bytes).map_err(|e| format!("Failed staging export file: {e}"))?;
    Ok(dest.to_string_lossy().into_owned())
}

/// Open an allowlisted project website or GitHub URL in the user's default browser.
#[tauri::command]
fn open_external_url(url: String) -> Result<(), String> {
    let trimmed = url.trim();
    let allowed = trimmed == "https://onepeek.top"
        || trimmed.starts_with("https://onepeek.top/")
        || trimmed == "https://github.com/Hyuzhe/OnePeek-Viewer"
        || trimmed.starts_with("https://github.com/Hyuzhe/OnePeek-Viewer/");
    if !allowed || trimmed.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return Err("URL is outside allowed domains".to_string());
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        std::process::Command::new("rundll32")
            .args(["url.dll,FileProtocolHandler", trimmed])
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map_err(|e| format!("Failed launching system browser: {e}"))?;
        Ok(())
    }
    #[cfg(not(windows))]
    {
        Err("fallback-window-open".to_string())
    }
}

#[tauri::command]
async fn read_binary_file(path: String) -> Result<IpcResponse, String> {
    let bytes = tauri::async_runtime::spawn_blocking(move || read_raw_bytes(&path))
        .await
        .map_err(|e| format!("File reader thread error: {e}"))??;
    Ok(IpcResponse::new(bytes))
}

#[tauri::command]
fn read_text_file(path: String, max_bytes: Option<usize>) -> Result<DecodedText, String> {
    read_smart_text(&path, max_bytes.unwrap_or(5 * 1024 * 1024))
}

#[tauri::command]
fn list_archive_entries(path: String) -> Result<Vec<ZipEntryInfo>, String> {
    inspect_zip(&path)
}

#[tauri::command]
fn extract_archive_entry(
    archive_path: String,
    entry_index: usize,
    app: tauri::AppHandle,
) -> Result<String, String> {
    let cache_dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("Cannot resolve app cache dir: {e}"))?;
    extract_zip_entry_to_cache(&archive_path, entry_index, &cache_dir)
}

#[tauri::command]
fn mount_html_page(path: String, state: State<'_, ActiveHtmlState>) -> Result<String, String> {
    mount_local_html(&path, &state)
}

#[tauri::command]
fn mount_media_stream(path: String, state: State<'_, MediaStreamState>) -> Result<String, String> {
    state.mount_file(&path)
}

#[cfg(windows)]
#[tauri::command]
fn hide_to_tray(window: tauri::WebviewWindow) {
    let _ = window.emit("preview-hidden", ());
    let _ = window.hide();
}

#[cfg(windows)]
#[tauri::command]
fn get_quicklook_enabled(state: State<'_, QuickLookState>) -> bool {
    state.enabled.load(Ordering::Relaxed)
}

#[cfg(windows)]
#[tauri::command]
fn set_quicklook_enabled(enabled: bool, state: State<'_, QuickLookState>) -> bool {
    state.enabled.store(enabled, Ordering::Relaxed);
    enabled
}

#[cfg(windows)]
#[tauri::command]
fn get_autostart_enabled() -> bool {
    is_autostart_enabled()
}

#[cfg(windows)]
#[tauri::command]
fn set_autostart_enabled(
    enabled: bool,
    tray_handles: State<'_, TrayMenuHandles>,
) -> Result<bool, String> {
    let updated = apply_autostart(enabled)?;
    if let Ok(guard) = tray_handles.autostart_item.lock() {
        if let Some(item) = guard.as_ref() {
            let _ = item.set_text(format_autostart_label(updated));
        }
    }
    Ok(updated)
}

#[cfg(not(windows))]
#[tauri::command]
fn hide_to_tray() {}

#[cfg(not(windows))]
#[tauri::command]
fn get_quicklook_enabled() -> bool {
    false
}

#[cfg(not(windows))]
#[tauri::command]
fn set_quicklook_enabled(_enabled: bool) -> bool {
    false
}

#[cfg(not(windows))]
#[tauri::command]
fn get_autostart_enabled() -> bool {
    false
}

#[cfg(not(windows))]
#[tauri::command]
fn set_autostart_enabled(_enabled: bool) -> Result<bool, String> {
    Ok(false)
}

#[tauri::command]
fn release_preview_resources(
    active_path: Option<String>,
    active_kind: Option<String>,
    in_archive: bool,
    app: tauri::AppHandle,
    html_state: State<'_, ActiveHtmlState>,
    media_state: State<'_, MediaStreamState>,
) {
    let kind = active_kind.as_deref().unwrap_or("");
    if active_path.is_none() || kind != "html" {
        if let Ok(mut g) = html_state.root_dir.lock() {
            *g = None;
        }
    }
    if active_path.is_none() || (kind != "video" && kind != "audio") {
        media_state.clear_entries();
    }
    if let Ok(cache_dir) = app.path().app_cache_dir() {
        if !in_archive {
            archive_service::clear_archive_preview_cache(&cache_dir);
        }
        let staging_root = cache_dir.join("opened_files");
        let protect = resolve_staged_root_entry(&staging_root, active_path.as_deref());
        prune_staged_cache_bounded(
            &staging_root,
            MAX_STAGED_KEEP_COUNT,
            MAX_STAGED_CACHE_BYTES,
            protect.as_deref(),
        );
    }
}

fn build_http_response(status: u16, mime: &str, body: Vec<u8>) -> HttpResponse<Vec<u8>> {
    HttpResponse::builder()
        .status(status)
        .header("Content-Type", mime)
        .header("Access-Control-Allow-Origin", "*")
        .header("Cache-Control", "no-store")
        .body(body)
        .unwrap_or_else(|_| HttpResponse::new(Vec::new()))
}

fn configure_common_builder(builder: tauri::Builder<tauri::Wry>) -> tauri::Builder<tauri::Wry> {
    builder
        .plugin(tauri_plugin_dialog::init())
        .manage(ActiveHtmlState::default())
        .manage(MediaStreamState::default())
        .register_uri_scheme_protocol("localhtml", |ctx, request| {
            let state = ctx.app_handle().state::<ActiveHtmlState>();
            let active_root = state.root_dir.lock().ok().and_then(|g| g.clone());
            let Some(root_dir) = active_root else {
                return build_http_response(404, "text/plain", b"No active HTML mounted".to_vec());
            };

            match read_local_html_resource(&root_dir, request.uri().path()) {
                Ok((bytes, mime)) => build_http_response(200, mime, bytes),
                Err(err) => build_http_response(404, "text/plain; charset=utf-8", err.into_bytes()),
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_startup_file,
            open_file_context,
            stage_picked_file,
            write_export_file,
            stage_export_file,
            open_external_url,
            read_binary_file,
            read_text_file,
            list_archive_entries,
            extract_archive_entry,
            mount_html_page,
            mount_media_stream,
            hide_to_tray,
            get_quicklook_enabled,
            set_quicklook_enabled,
            get_autostart_enabled,
            set_autostart_enabled,
            release_preview_resources,
        ])
}

#[cfg(windows)]
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let cli_file = detect_cli_file_arg();
    let Some(ipc_listener) = acquire_single_instance(cli_file.as_deref(), false) else {
        return;
    };

    // Keep Startup folder launcher synced if portable exe moved to another folder.
    if is_autostart_enabled() {
        let _ = apply_autostart(true);
    }

    let silent_start = std::env::args().any(|a| a == "--background" || a == "--minimized");

    configure_common_builder(tauri::Builder::default())
        .manage(QuickLookState::default())
        .manage(TrayMenuHandles::default())
        .setup(move |app| {
            if let Ok(cache_dir) = app.path().app_cache_dir() {
                archive_service::clear_archive_preview_cache(&cache_dir);
                prune_staged_cache_bounded(
                    &cache_dir.join("opened_files"),
                    MAX_STAGED_KEEP_COUNT,
                    MAX_STAGED_CACHE_BYTES,
                    None,
                );
            }
            let handle = app.handle().clone();
            let ql_state = app.state::<QuickLookState>();
            setup_system_tray(&handle)?;
            bind_close_to_tray(&handle);
            spawn_ipc_receiver(ipc_listener, handle.clone());
            start_quicklook_daemon(handle.clone(), &ql_state);

            if silent_start {
                if let Some(win) = app.get_webview_window("main") {
                    let _ = win.hide();
                }
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running OnePeek Community application");
}

#[cfg(not(windows))]
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    configure_common_builder(tauri::Builder::default())
        .setup(|app| {
            let mut pending_startup: Option<String> = None;
            if let Ok(dir) = app.path().app_data_dir() {
                let _ = std::fs::create_dir_all(&dir);
                for marker in [
                    dir.join("pending_open_path.txt"),
                    dir.join("files").join("pending_open_path.txt"),
                ] {
                    if let Ok(raw) = std::fs::read_to_string(&marker) {
                        let trimmed = raw.trim().to_string();
                        if !trimmed.is_empty() {
                            pending_startup = Some(trimmed);
                            break;
                        }
                    }
                }
            }
            if let Ok(cache_dir) = app.path().app_cache_dir() {
                archive_service::clear_archive_preview_cache(&cache_dir);
                let staging_root = cache_dir.join("opened_files");
                let protect = resolve_staged_root_entry(&staging_root, pending_startup.as_deref());
                prune_staged_cache_bounded(
                    &staging_root,
                    MAX_STAGED_KEEP_COUNT,
                    MAX_STAGED_CACHE_BYTES,
                    protect.as_deref(),
                );
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running OnePeek Community application");
}

#[cfg(test)]
mod tests {
    use super::fs_service::{inspect_with_siblings, read_smart_text, resolve_companion_file};
    use super::html_engine::{mount_local_html, read_local_html_resource, ActiveHtmlState};

    #[test]
    fn test_sibling_context_and_smart_text_encoding() {
        let tmp_dir = std::env::temp_dir().join("onepeek_comm_fs_test");
        let _ = std::fs::create_dir_all(&tmp_dir);
        let a = tmp_dir.join("a_note.md");
        let b = tmp_dir.join("b_note.txt");
        let _ = std::fs::write(&a, "# OnePeek Markdown Test\n你好世界");
        // GBK bytes for "中文编码"
        let _ = std::fs::write(&b, [0xD6, 0xD0, 0xCE, 0xC4, 0xB1, 0xE0, 0xC2, 0xEB]);

        let ctx = inspect_with_siblings(&a.to_string_lossy()).expect("sibling scan");
        assert_eq!(ctx.siblings.len(), 2);
        assert_eq!(ctx.current.ext, "md");

        let utf8_doc = read_smart_text(&a.to_string_lossy(), 65536).expect("utf8 read");
        assert!(utf8_doc.content.contains("你好世界"));

        let gbk_doc = read_smart_text(&b.to_string_lossy(), 65536).expect("gbk read");
        assert_eq!(gbk_doc.content, "中文编码");

        let _ = std::fs::remove_dir_all(&tmp_dir);
    }

    #[test]
    fn test_resolve_companion_file_lookup() {
        let tmp_dir = std::env::temp_dir().join("onepeek_comm_tex_test");
        let tex_dir = tmp_dir.join("textures");
        let _ = std::fs::create_dir_all(&tex_dir);

        let model_path = tmp_dir.join("jaw_scan.ply");
        let stem_tex = tmp_dir.join("jaw_scan_texture.png");
        let sub_tex = tex_dir.join("albedo.jpg");
        let _ = std::fs::write(&model_path, b"ply");
        let _ = std::fs::write(&stem_tex, b"png");
        let _ = std::fs::write(&sub_tex, b"jpg");

        let model_str = model_path.to_string_lossy();
        let exts = vec!["png".to_string(), "jpg".to_string()];

        let hit_stale = resolve_companion_file(
            &model_str,
            Some(r"Z:\OtherPC\Export\albedo.jpg"),
            &exts,
        );
        assert_eq!(hit_stale.as_deref(), Some(sub_tex.to_string_lossy().as_ref()));

        let hit_stem = resolve_companion_file(&model_str, None, &exts);
        assert_eq!(hit_stem.as_deref(), Some(stem_tex.to_string_lossy().as_ref()));

        let nested_dir = tmp_dir.join("models");
        let _ = std::fs::create_dir_all(&nested_dir);
        let nested_model = nested_dir.join("part.obj");
        let _ = std::fs::write(&nested_model, b"");
        let nested_str = nested_model.to_string_lossy().to_string();

        let hit_sibling_name = resolve_companion_file(&nested_str, Some("albedo.jpg"), &exts)
            .expect("resolve sibling folder by filename");
        assert!(!hit_sibling_name.contains(".."));
        assert_eq!(hit_sibling_name, sub_tex.to_string_lossy());

        let hit_sibling_rel = resolve_companion_file(&nested_str, Some("../textures/albedo.jpg"), &exts)
            .expect("resolve sibling folder by relative ref");
        assert!(!hit_sibling_rel.contains(".."));
        assert_eq!(hit_sibling_rel, sub_tex.to_string_lossy());

        let _ = std::fs::remove_dir_all(&tmp_dir);
    }

    #[test]
    fn test_local_html_mount_and_relative_assets() {
        let tmp_dir = std::env::temp_dir().join("onepeek_comm_html_test");
        let css_dir = tmp_dir.join("assets");
        let _ = std::fs::create_dir_all(&css_dir);

        let html_path = tmp_dir.join("index.html");
        let css_path = css_dir.join("style.css");
        let _ = std::fs::write(
            &html_path,
            b"<!DOCTYPE html><html><body><h1>Hello</h1></body></html>",
        );
        let _ = std::fs::write(&css_path, b"body { color: red; }");

        let state = ActiveHtmlState::default();
        let entry_href = mount_local_html(&html_path.to_string_lossy(), &state).expect("mount html");
        let root_dir = state.root_dir.lock().unwrap().clone().unwrap();

        let (html_bytes, html_mime) =
            read_local_html_resource(&root_dir, &format!("/{entry_href}")).expect("read html");
        assert!(html_mime.starts_with("text/html"));
        assert!(String::from_utf8_lossy(&html_bytes).contains("OMNI_HTML_KEY"));

        let parent_href = entry_href.rsplit_once('/').map(|(p, _)| p).unwrap_or("");
        let css_uri = format!("/{parent_href}/assets/style.css");
        let (css_bytes, css_mime) =
            read_local_html_resource(&root_dir, &css_uri).expect("read relative css");
        assert!(css_mime.starts_with("text/css"));
        assert_eq!(css_bytes, b"body { color: red; }");

        let _ = std::fs::remove_dir_all(&tmp_dir);
    }

    #[test]
    fn test_opened_files_root_ignores_history_but_batch_dir_lists_siblings() {
        let base = std::env::temp_dir().join("onepeek_comm_staging_test");
        let _ = std::fs::remove_dir_all(&base);
        let root_opened = base.join("opened_files");
        let batch_dir = root_opened.join("batch_100");
        std::fs::create_dir_all(&batch_dir).unwrap();

        let hist_a = root_opened.join("old1.txt");
        let hist_b = root_opened.join("old2.txt");
        std::fs::write(&hist_a, b"a").unwrap();
        std::fs::write(&hist_b, b"b").unwrap();

        let root_ctx = inspect_with_siblings(&hist_a.to_string_lossy()).expect("root ctx");
        assert_eq!(root_ctx.siblings.len(), 1);

        let batch_a = batch_dir.join("1.pdf");
        let batch_b = batch_dir.join("2.pdf");
        std::fs::write(&batch_a, b"p1").unwrap();
        std::fs::write(&batch_b, b"p2").unwrap();

        let batch_ctx = inspect_with_siblings(&batch_a.to_string_lossy()).expect("batch ctx");
        assert_eq!(batch_ctx.siblings.len(), 2);

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn test_prune_staged_cache_enforces_byte_budget_and_protects_active_batch() {
        let base = std::env::temp_dir().join("onepeek_comm_prune_budget_test");
        let _ = std::fs::remove_dir_all(&base);
        let root = base.join("opened_files");
        let old_dir = root.join("batch_old");
        let big_dir = root.join("batch_big");
        let active_dir = root.join("batch_active");
        std::fs::create_dir_all(&old_dir).unwrap();
        std::fs::create_dir_all(&big_dir).unwrap();
        std::fs::create_dir_all(&active_dir).unwrap();

        std::fs::write(old_dir.join("small.bin"), vec![1u8; 40]).unwrap();
        std::fs::write(big_dir.join("huge.bin"), vec![2u8; 100]).unwrap();
        let active_child = active_dir.join("current.txt");
        std::fs::write(&active_child, vec![3u8; 90]).unwrap();

        let protect = super::resolve_staged_root_entry(&root, Some(&active_child.to_string_lossy()));
        assert!(protect.is_some());
        super::prune_staged_cache_bounded(&root, 2, 80, protect.as_deref());

        assert!(active_dir.exists());
        assert!(!big_dir.exists());
        assert!(old_dir.exists());

        let _ = std::fs::remove_dir_all(&base);
    }
}
