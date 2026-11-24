// Local loopback HTTP/1.1 byte-range streaming server for HTML5 media seeking on Android.

use percent_encoding::{utf8_percent_encode, NON_ALPHANUMERIC};
use sha2::{Digest, Sha256};
use std::collections::VecDeque;
use std::fs::File;
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const MAX_REGISTERED_STREAMS: usize = 24;
const MAX_REQUEST_HEAD_BYTES: usize = 16 * 1024;
const STREAM_CHUNK_BYTES: usize = 64 * 1024;

struct MediaRegistry {
    next_id: u64,
    items: VecDeque<(u64, PathBuf)>,
}

struct ServerHandle {
    port: u16,
    token: String,
}

enum ByteRange {
    Full,
    Partial(u64, u64),
    Invalid,
}

/// Manages a lazy loopback HTTP/1.1 Range server scoped by a per-session random token.
pub struct MediaStreamState {
    server: Mutex<Option<ServerHandle>>,
    entries: Arc<Mutex<MediaRegistry>>,
}

impl Default for MediaStreamState {
    fn default() -> Self {
        Self {
            server: Mutex::new(None),
            entries: Arc::new(Mutex::new(MediaRegistry {
                next_id: 1,
                items: VecDeque::with_capacity(MAX_REGISTERED_STREAMS),
            })),
        }
    }
}

impl MediaStreamState {
    /// Register a local media file and return its tokenized loopback streaming URL.
    pub fn mount_file(&self, path: &str) -> Result<String, String> {
        let target = PathBuf::from(path);
        let meta = std::fs::metadata(&target)
            .map_err(|e| format!("无法访问音视频文件: {e}"))?;
        if !meta.is_file() {
            return Err("目标路径不是有效的媒体文件".into());
        }

        let (port, token) = self.ensure_server_started()?;
        let stream_id = {
            let mut reg = self
                .entries
                .lock()
                .map_err(|_| "媒体流注册表锁定失败".to_string())?;
            let id = reg.next_id;
            reg.next_id = reg.next_id.saturating_add(1);
            if reg.items.len() >= MAX_REGISTERED_STREAMS {
                reg.items.pop_front();
            }
            reg.items.push_back((id, target.clone()));
            id
        };

        let raw_name = target
            .file_name()
            .and_then(|s| s.to_str())
            .filter(|s| !s.is_empty())
            .unwrap_or("media.bin");
        let encoded_name = utf8_percent_encode(raw_name, NON_ALPHANUMERIC).to_string();
        Ok(format!(
            "http://127.0.0.1:{port}/stream/{token}/{stream_id}/{encoded_name}"
        ))
    }

    /// Clear all registered streaming file handles when leaving media preview.
    pub fn clear_entries(&self) {
        if let Ok(mut reg) = self.entries.lock() {
            reg.items.clear();
        }
    }

    fn ensure_server_started(&self) -> Result<(u16, String), String> {
        let mut guard = self
            .server
            .lock()
            .map_err(|_| "媒体服务状态锁定失败".to_string())?;
        if let Some(handle) = guard.as_ref() {
            return Ok((handle.port, handle.token.clone()));
        }

        let listener = TcpListener::bind("127.0.0.1:0")
            .map_err(|e| format!("启动本地媒体流服务失败: {e}"))?;
        let port = listener
            .local_addr()
            .map_err(|e| format!("读取媒体流端口失败: {e}"))?
            .port();
        let token = generate_session_token(port);

        let entries = Arc::clone(&self.entries);
        let server_token = token.clone();
        std::thread::Builder::new()
            .name("onepeek-media-accept".into())
            .spawn(move || accept_loop(listener, entries, server_token))
            .map_err(|e| format!("启动媒体监听线程失败: {e}"))?;

        *guard = Some(ServerHandle {
            port,
            token: token.clone(),
        });
        Ok((port, token))
    }
}

fn generate_session_token(port: u16) -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let stack_addr = &port as *const u16 as usize;
    let mut hasher = Sha256::new();
    hasher.update(nanos.to_le_bytes());
    hasher.update(stack_addr.to_le_bytes());
    hasher.update(port.to_le_bytes());
    let digest = hasher.finalize();
    digest[..16].iter().map(|b| format!("{b:02x}")).collect()
}

fn accept_loop(listener: TcpListener, entries: Arc<Mutex<MediaRegistry>>, token: String) {
    for incoming in listener.incoming() {
        let Ok(stream) = incoming else {
            continue;
        };
        let entries_ref = Arc::clone(&entries);
        let token_ref = token.clone();
        let _ = std::thread::Builder::new()
            .name("onepeek-media-conn".into())
            .spawn(move || handle_connection(stream, &entries_ref, &token_ref));
    }
}

fn handle_connection(
    mut stream: TcpStream,
    entries: &Arc<Mutex<MediaRegistry>>,
    expected_token: &str,
) {
    let _ = stream.set_nodelay(true);
    let _ = stream.set_read_timeout(Some(Duration::from_secs(15)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(600)));

    let Some(raw_head) = read_request_head(&mut stream) else {
        return;
    };
    let mut lines = raw_head.split("\r\n");
    let Some(request_line) = lines.next() else {
        let _ = write_error_response(&mut stream, 400, "Bad Request");
        return;
    };

    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or("");
    let target = parts.next().unwrap_or("");

    if method.eq_ignore_ascii_case("OPTIONS") {
        let _ = write_options_response(&mut stream);
        return;
    }

    let is_head = method.eq_ignore_ascii_case("HEAD");
    if !is_head && !method.eq_ignore_ascii_case("GET") {
        let _ = write_error_response(&mut stream, 405, "Method Not Allowed");
        return;
    }

    let range_header = find_header_value(lines, "range");
    let path_only = target.split('?').next().unwrap_or(target);
    let stream_id = match authorize_and_parse_id(path_only, expected_token) {
        Ok(id) => id,
        Err((status, reason)) => {
            let _ = write_error_response(&mut stream, status, reason);
            return;
        }
    };

    let Some(file_path) = lookup_stream_path(entries, stream_id) else {
        let _ = write_error_response(&mut stream, 404, "Not Found");
        return;
    };

    serve_media_file(&mut stream, &file_path, is_head, range_header.as_deref());
}

fn read_request_head(stream: &mut TcpStream) -> Option<String> {
    let mut buf = Vec::with_capacity(1024);
    let mut chunk = [0u8; 1024];
    loop {
        let n = stream.read(&mut chunk).ok()?;
        if n == 0 {
            break;
        }
        buf.extend_from_slice(&chunk[..n]);
        if let Some(pos) = find_header_end(&buf) {
            return Some(String::from_utf8_lossy(&buf[..pos]).into_owned());
        }
        if buf.len() >= MAX_REQUEST_HEAD_BYTES {
            return None;
        }
    }
    None
}

fn find_header_end(buf: &[u8]) -> Option<usize> {
    buf.windows(4).position(|w| w == b"\r\n\r\n")
}

fn find_header_value<'a>(lines: impl Iterator<Item = &'a str>, name: &str) -> Option<String> {
    for line in lines {
        if let Some((k, v)) = line.split_once(':') {
            if k.trim().eq_ignore_ascii_case(name) {
                return Some(v.trim().to_string());
            }
        }
    }
    None
}

fn authorize_and_parse_id(path: &str, expected_token: &str) -> Result<u64, (u16, &'static str)> {
    let mut segs = path.trim_start_matches('/').split('/');
    let prefix = segs.next().unwrap_or("");
    let token = segs.next().unwrap_or("");
    let id_str = segs.next().unwrap_or("");
    if prefix != "stream" || token.is_empty() || id_str.is_empty() {
        return Err((404, "Not Found"));
    }
    if token != expected_token {
        return Err((403, "Forbidden"));
    }
    id_str.parse::<u64>().map_err(|_| (404, "Not Found"))
}

fn lookup_stream_path(entries: &Arc<Mutex<MediaRegistry>>, id: u64) -> Option<PathBuf> {
    let reg = entries.lock().ok()?;
    reg.items
        .iter()
        .rev()
        .find(|(item_id, _)| *item_id == id)
        .map(|(_, path)| path.clone())
}

fn serve_media_file(
    stream: &mut TcpStream,
    file_path: &Path,
    is_head: bool,
    range_header: Option<&str>,
) {
    let Ok(mut file) = File::open(file_path) else {
        let _ = write_error_response(stream, 404, "Not Found");
        return;
    };
    let Ok(meta) = file.metadata() else {
        let _ = write_error_response(stream, 500, "Internal Server Error");
        return;
    };
    let total_len = meta.len();
    let mime = media_mime_for_path(file_path);

    let parsed = match range_header {
        Some(raw) => parse_byte_range(raw, total_len),
        None => ByteRange::Full,
    };

    match parsed {
        ByteRange::Invalid => {
            let _ = write_range_not_satisfiable(stream, total_len);
        }
        ByteRange::Full => {
            if write_stream_headers(stream, 200, "OK", mime, total_len, None).is_err() {
                return;
            }
            if !is_head && total_len > 0 {
                let _ = stream_file_slice(stream, &mut file, total_len);
            }
        }
        ByteRange::Partial(start, end) => {
            let len = end - start + 1;
            let content_range = format!("bytes {start}-{end}/{total_len}");
            if write_stream_headers(
                stream,
                206,
                "Partial Content",
                mime,
                len,
                Some(&content_range),
            )
            .is_err()
            {
                return;
            }
            if !is_head && file.seek(SeekFrom::Start(start)).is_ok() {
                let _ = stream_file_slice(stream, &mut file, len);
            }
        }
    }
}

fn parse_byte_range(header: &str, total_len: u64) -> ByteRange {
    if total_len == 0 {
        return ByteRange::Invalid;
    }
    let trimmed = header.trim();
    let Some((unit, spec)) = trimmed.split_once('=') else {
        return ByteRange::Invalid;
    };
    if !unit.trim().eq_ignore_ascii_case("bytes") {
        return ByteRange::Invalid;
    }

    let first = spec.split(',').next().unwrap_or("").trim();
    let Some((start_str, end_str)) = first.split_once('-') else {
        return ByteRange::Invalid;
    };
    let start_str = start_str.trim();
    let end_str = end_str.trim();

    if start_str.is_empty() {
        let Ok(suffix) = end_str.parse::<u64>() else {
            return ByteRange::Invalid;
        };
        if suffix == 0 {
            return ByteRange::Invalid;
        }
        let start = total_len.saturating_sub(suffix);
        return ByteRange::Partial(start, total_len - 1);
    }

    let Ok(start) = start_str.parse::<u64>() else {
        return ByteRange::Invalid;
    };
    if start >= total_len {
        return ByteRange::Invalid;
    }

    let end = if end_str.is_empty() {
        total_len - 1
    } else {
        let Ok(parsed_end) = end_str.parse::<u64>() else {
            return ByteRange::Invalid;
        };
        parsed_end.min(total_len - 1)
    };

    if end < start {
        ByteRange::Invalid
    } else {
        ByteRange::Partial(start, end)
    }
}

fn media_mime_for_path(path: &Path) -> &'static str {
    let ext = path
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match ext.as_str() {
        "mp4" | "m4v" => "video/mp4",
        "webm" => "video/webm",
        "mkv" => "video/x-matroska",
        "mov" => "video/quicktime",
        "avi" => "video/x-msvideo",
        "ogv" => "video/ogg",
        "mp3" => "audio/mpeg",
        "flac" => "audio/flac",
        "wav" => "audio/wav",
        "m4a" => "audio/mp4",
        "aac" => "audio/aac",
        "opus" | "ogg" => "audio/ogg",
        "wma" => "audio/x-ms-wma",
        _ => "application/octet-stream",
    }
}

fn write_options_response(stream: &mut TcpStream) -> io::Result<()> {
    let head = concat!(
        "HTTP/1.1 204 No Content\r\n",
        "Access-Control-Allow-Origin: *\r\n",
        "Access-Control-Allow-Methods: GET, HEAD, OPTIONS\r\n",
        "Access-Control-Allow-Headers: Range\r\n",
        "Access-Control-Expose-Headers: Content-Range, Content-Length, Accept-Ranges\r\n",
        "Connection: close\r\n\r\n"
    );
    stream.write_all(head.as_bytes())
}

fn write_error_response(stream: &mut TcpStream, status: u16, reason: &str) -> io::Result<()> {
    let head = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Length: 0\r\nAccess-Control-Allow-Origin: *\r\nConnection: close\r\n\r\n"
    );
    stream.write_all(head.as_bytes())
}

fn write_range_not_satisfiable(stream: &mut TcpStream, total_len: u64) -> io::Result<()> {
    let head = format!(
        "HTTP/1.1 416 Range Not Satisfiable\r\nContent-Range: bytes */{total_len}\r\nContent-Length: 0\r\nAccess-Control-Allow-Origin: *\r\nConnection: close\r\n\r\n"
    );
    stream.write_all(head.as_bytes())
}

fn write_stream_headers(
    stream: &mut TcpStream,
    status: u16,
    reason: &str,
    mime: &str,
    content_length: u64,
    content_range: Option<&str>,
) -> io::Result<()> {
    let mut head = format!(
        "HTTP/1.1 {status} {reason}\r\n\
        Content-Type: {mime}\r\n\
        Accept-Ranges: bytes\r\n\
        Content-Length: {content_length}\r\n\
        Access-Control-Allow-Origin: *\r\n\
        Access-Control-Expose-Headers: Content-Range, Content-Length, Accept-Ranges\r\n\
        Cache-Control: no-store\r\n\
        Connection: close\r\n"
    );
    if let Some(range) = content_range {
        head.push_str(&format!("Content-Range: {range}\r\n"));
    }
    head.push_str("\r\n");
    stream.write_all(head.as_bytes())
}

fn stream_file_slice(stream: &mut TcpStream, file: &mut File, mut remaining: u64) -> io::Result<()> {
    let mut buf = vec![0u8; STREAM_CHUNK_BYTES];
    while remaining > 0 {
        let to_read = (remaining as usize).min(buf.len());
        let n = file.read(&mut buf[..to_read])?;
        if n == 0 {
            break;
        }
        if let Err(err) = stream.write_all(&buf[..n]) {
            if matches!(
                err.kind(),
                io::ErrorKind::BrokenPipe
                    | io::ErrorKind::ConnectionReset
                    | io::ErrorKind::ConnectionAborted
            ) {
                return Ok(());
            }
            return Err(err);
        }
        remaining -= n as u64;
    }
    let _ = stream.flush();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn send_http_request(
        url: &str,
        method: &str,
        extra_headers: &[(&str, &str)],
    ) -> (String, Vec<u8>) {
        let without_scheme = url.strip_prefix("http://").expect("http url");
        let (host_port, path_part) = without_scheme.split_once('/').expect("url path");
        let mut conn = TcpStream::connect(host_port).expect("connect media server");
        let mut req = format!("{method} /{path_part} HTTP/1.1\r\nHost: {host_port}\r\n");
        for (k, v) in extra_headers {
            req.push_str(&format!("{k}: {v}\r\n"));
        }
        req.push_str("Connection: close\r\n\r\n");
        conn.write_all(req.as_bytes()).expect("write request");

        let mut raw = Vec::new();
        conn.read_to_end(&mut raw).expect("read response");
        let sep = find_header_end(&raw).expect("http header separator");
        let headers = String::from_utf8_lossy(&raw[..sep]).into_owned();
        let body = raw[sep + 4..].to_vec();
        (headers, body)
    }

    #[test]
    fn test_full_get_and_head_responses() {
        let tmp_dir = std::env::temp_dir().join("onepeek_media_head_test");
        let _ = std::fs::create_dir_all(&tmp_dir);
        let file_path = tmp_dir.join("sample.mp4");
        let payload = vec![0xABu8; 4096];
        std::fs::write(&file_path, &payload).expect("write test video");

        let state = MediaStreamState::default();
        let url = state
            .mount_file(&file_path.to_string_lossy())
            .expect("mount file");

        let (head_hdr, head_body) = send_http_request(&url, "HEAD", &[]);
        assert!(head_hdr.starts_with("HTTP/1.1 200 OK"));
        assert!(head_hdr.contains("Content-Type: video/mp4"));
        assert!(head_hdr.contains("Accept-Ranges: bytes"));
        assert!(head_hdr.contains("Content-Length: 4096"));
        assert!(head_body.is_empty());

        let (get_hdr, get_body) = send_http_request(&url, "GET", &[]);
        assert!(get_hdr.starts_with("HTTP/1.1 200 OK"));
        assert_eq!(get_body, payload);

        let _ = std::fs::remove_dir_all(&tmp_dir);
    }

    #[test]
    fn test_open_ended_range_streams_over_one_megabyte() {
        let tmp_dir = std::env::temp_dir().join("onepeek_media_large_range_test");
        let _ = std::fs::create_dir_all(&tmp_dir);
        let file_path = tmp_dir.join("large_clip.mp4");
        let total = 1_500_000usize;
        let payload: Vec<u8> = (0..total).map(|i| (i % 251) as u8).collect();
        std::fs::write(&file_path, &payload).expect("write >1MB payload");

        let state = MediaStreamState::default();
        let url = state
            .mount_file(&file_path.to_string_lossy())
            .expect("mount large file");

        let (hdr, body) = send_http_request(&url, "GET", &[("Range", "bytes=0-")]);
        assert!(hdr.starts_with("HTTP/1.1 206 Partial Content"));
        assert!(hdr.contains("Content-Range: bytes 0-1499999/1500000"));
        assert!(hdr.contains("Content-Length: 1500000"));
        assert_eq!(body.len(), total);
        assert_eq!(body, payload);

        let _ = std::fs::remove_dir_all(&tmp_dir);
    }

    #[test]
    fn test_mid_file_seek_and_suffix_range() {
        let tmp_dir = std::env::temp_dir().join("onepeek_media_seek_test");
        let _ = std::fs::create_dir_all(&tmp_dir);
        let file_path = tmp_dir.join("seek_clip.webm");
        let total = 1_200_000usize;
        let payload: Vec<u8> = (0..total).map(|i| ((i * 7) % 256) as u8).collect();
        std::fs::write(&file_path, &payload).expect("write seek payload");

        let state = MediaStreamState::default();
        let url = state
            .mount_file(&file_path.to_string_lossy())
            .expect("mount seek file");

        let (hdr, body) = send_http_request(&url, "GET", &[("Range", "bytes=500000-599999")]);
        assert!(hdr.starts_with("HTTP/1.1 206 Partial Content"));
        assert!(hdr.contains("Content-Range: bytes 500000-599999/1200000"));
        assert!(hdr.contains("Content-Length: 100000"));
        assert_eq!(body, payload[500_000..=599_999]);

        let (suf_hdr, suf_body) = send_http_request(&url, "GET", &[("Range", "bytes=-1024")]);
        assert!(suf_hdr.starts_with("HTTP/1.1 206 Partial Content"));
        assert!(suf_hdr.contains("Content-Range: bytes 1198976-1199999/1200000"));
        assert_eq!(suf_body, payload[total - 1024..]);

        let _ = std::fs::remove_dir_all(&tmp_dir);
    }

    #[test]
    fn test_invalid_token_and_unsatisfiable_range() {
        let tmp_dir = std::env::temp_dir().join("onepeek_media_err_test");
        let _ = std::fs::create_dir_all(&tmp_dir);
        let file_path = tmp_dir.join("audio.mp3");
        std::fs::write(&file_path, vec![1u8; 512]).expect("write mp3");

        let state = MediaStreamState::default();
        let url = state
            .mount_file(&file_path.to_string_lossy())
            .expect("mount mp3");

        let parts: Vec<&str> = url.split('/').collect();
        let bad_token_url = format!(
            "http://{}/stream/wrongtoken/{}/{}",
            parts[2], parts[5], parts[6]
        );
        let (forbid_hdr, _) = send_http_request(&bad_token_url, "GET", &[]);
        assert!(forbid_hdr.starts_with("HTTP/1.1 403 Forbidden"));

        let (oob_hdr, _) = send_http_request(&url, "GET", &[("Range", "bytes=9999-")]);
        assert!(oob_hdr.starts_with("HTTP/1.1 416 Range Not Satisfiable"));
        assert!(oob_hdr.contains("Content-Range: bytes */512"));

        let _ = std::fs::remove_dir_all(&tmp_dir);
    }
}
