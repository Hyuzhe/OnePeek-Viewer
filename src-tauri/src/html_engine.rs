use encoding_rs::{GB18030, UTF_16BE, UTF_16LE, UTF_8};
use percent_encoding::percent_decode_str;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

#[derive(Default)]
pub struct ActiveHtmlState {
    pub root_dir: Mutex<Option<PathBuf>>,
}

const HTML_BRIDGE_SNIPPET: &str = r#"
<style id="__omni_html_fit">
  html, body { max-width: 100%; box-sizing: border-box; overflow-wrap: break-word; }
  img, svg, video, canvas { max-width: 100%; height: auto; }
</style>
<script>
(function() {
  if (document.head && !document.querySelector('meta[name="viewport"]')) {
    var meta = document.createElement('meta');
    meta.name = 'viewport';
    meta.content = 'width=device-width, initial-scale=1.0';
    document.head.appendChild(meta);
  }
  window.addEventListener('keydown', function(ev) {
    var t = ev.target;
    var editable = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
    if (ev.key === 'Escape') {
      ev.preventDefault();
      window.parent.postMessage({ type: 'OMNI_HTML_KEY', key: 'Escape' }, '*');
    } else if (ev.key === ' ' && !editable && !ev.ctrlKey && !ev.altKey && !ev.metaKey) {
      ev.preventDefault();
      window.parent.postMessage({ type: 'OMNI_HTML_KEY', key: ' ' }, '*');
    } else if (ev.altKey && (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight')) {
      ev.preventDefault();
      window.parent.postMessage({ type: 'OMNI_HTML_KEY', key: ev.key, altKey: true }, '*');
    }
  });
})();
</script>
"#;

/// Mount a local HTML file by anchoring its drive/share root and returning its relative URI path.
pub fn mount_local_html(file_path: &str, state: &ActiveHtmlState) -> Result<String, String> {
    let canonical = PathBuf::from(file_path);
    if !canonical.is_file() {
        return Err("HTML file does not exist".to_string());
    }

    let root = canonical
        .ancestors()
        .last()
        .map(Path::to_path_buf)
        .ok_or_else(|| "Cannot determine root directory for HTML file".to_string())?;

    let rel = canonical
        .strip_prefix(&root)
        .map_err(|e| format!("Failed resolving relative HTML path: {e}"))?;

    let posix_href = rel
        .components()
        .map(|c| c.as_os_str().to_string_lossy().into_owned())
        .collect::<Vec<_>>()
        .join("/");

    if let Ok(mut guard) = state.root_dir.lock() {
        *guard = Some(root);
    }
    Ok(posix_href)
}

/// Resolve and serve an HTML page or its relative local assets (CSS, JS, images, fonts).
pub fn read_local_html_resource(root_dir: &Path, raw_uri_path: &str) -> Result<(Vec<u8>, &'static str), String> {
    let decoded = percent_decode_str(raw_uri_path.trim_start_matches('/'))
        .decode_utf8_lossy()
        .into_owned();

    let normalized = decoded.replace('\\', "/");
    let mut clean_segments: Vec<&str> = Vec::new();
    for seg in normalized.split('/') {
        match seg {
            "" | "." => {}
            ".." => {
                clean_segments.pop();
            }
            part => clean_segments.push(part),
        }
    }

    let mut full_path = root_dir.to_path_buf();
    for seg in clean_segments {
        full_path.push(seg);
    }

    let raw_bytes = fs::read(&full_path)
        .map_err(|e| format!("Local HTML resource not found ({}): {e}", full_path.display()))?;

    let mime = guess_web_mime(&full_path);
    if mime.starts_with("text/html") {
        return Ok((prepare_html_bytes(&raw_bytes), mime));
    }
    Ok((raw_bytes, mime))
}

fn prepare_html_bytes(raw: &[u8]) -> Vec<u8> {
    let mut html = decode_html_to_utf8(raw);
    if let Some(pos) = html.to_ascii_lowercase().rfind("</body>") {
        let mut out = String::with_capacity(html.len() + HTML_BRIDGE_SNIPPET.len());
        out.push_str(&html[..pos]);
        out.push_str(HTML_BRIDGE_SNIPPET);
        out.push_str(&html[pos..]);
        return out.into_bytes();
    }
    html.push_str(HTML_BRIDGE_SNIPPET);
    html.into_bytes()
}

fn decode_html_to_utf8(buf: &[u8]) -> String {
    if buf.starts_with(&[0xEF, 0xBB, 0xBF]) {
        let (cow, _, _) = UTF_8.decode(&buf[3..]);
        return cow.into_owned();
    }
    if buf.starts_with(&[0xFF, 0xFE]) {
        let (cow, _, _) = UTF_16LE.decode(&buf[2..]);
        return cow.into_owned();
    }
    if buf.starts_with(&[0xFE, 0xFF]) {
        let (cow, _, _) = UTF_16BE.decode(&buf[2..]);
        return cow.into_owned();
    }
    if let Ok(valid) = std::str::from_utf8(buf) {
        return valid.to_string();
    }
    let (cow, _, _) = GB18030.decode(buf);
    cow.into_owned()
}

fn guess_web_mime(path: &Path) -> &'static str {
    let ext = path
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();

    match ext.as_str() {
        "html" | "htm" | "xhtml" | "shtml" => "text/html; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "js" | "mjs" => "application/javascript; charset=utf-8",
        "json" | "map" => "application/json; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" | "jfif" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "wasm" => "application/wasm",
        "xml" => "application/xml; charset=utf-8",
        "txt" | "md" | "csv" => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}
