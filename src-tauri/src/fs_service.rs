use encoding_rs::{GB18030, UTF_16BE, UTF_16LE, UTF_8};
use serde::Serialize;
use std::fs::{self, File};
use std::io::Read;
use std::path::{Path, PathBuf};

#[derive(Serialize, Clone)]
pub struct FileMeta {
    pub path: String,
    pub name: String,
    pub ext: String,
    pub size: u64,
}

#[derive(Serialize)]
pub struct FileContextPayload {
    pub current: FileMeta,
    pub siblings: Vec<FileMeta>,
    pub current_index: usize,
}

#[derive(Serialize)]
pub struct DecodedText {
    pub content: String,
    pub encoding: String,
    pub truncated: bool,
}

/// Return true if file begins with a 128-byte preamble followed by "DICM".
pub fn has_dicm_magic(path: &Path) -> bool {
    let Ok(mut file) = File::open(path) else {
        return false;
    };
    let mut buf = [0u8; 132];
    let Ok(n) = file.read(&mut buf) else {
        return false;
    };
    n == 132 && &buf[128..132] == b"DICM"
}

fn extract_ext(path: &Path) -> String {
    if let Some(name) = path.file_name().and_then(|s| s.to_str()) {
        let lower = name.to_ascii_lowercase();
        if lower.ends_with(".nii.gz") {
            return "nii.gz".to_string();
        }
        if lower.ends_with(".tar.gz") {
            return "tar.gz".to_string();
        }
    }
    let ext = path
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if (ext.is_empty() || ext.chars().all(|c| c.is_ascii_digit()))
        && path.is_file()
        && has_dicm_magic(path)
    {
        return "dcm".to_string();
    }
    ext
}

fn build_meta(path: &Path, size: u64) -> FileMeta {
    let name = path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("unknown")
        .to_string();
    FileMeta {
        path: path.to_string_lossy().to_string(),
        name,
        ext: extract_ext(path),
        size,
    }
}

/// Inspect a target file and collect sibling files in its parent directory.
pub fn inspect_with_siblings(target_path: &str) -> Result<FileContextPayload, String> {
    let canonical = PathBuf::from(target_path);
    let metadata = fs::metadata(&canonical).map_err(|e| format!("Cannot access file: {e}"))?;
    if !metadata.is_file() {
        return Err("Selected path is not a regular file".to_string());
    }

    let current = build_meta(&canonical, metadata.len());
    let mut siblings = collect_siblings(canonical.parent());
    siblings.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));

    let current_index = siblings
        .iter()
        .position(|item| item.path.eq_ignore_ascii_case(&current.path))
        .unwrap_or(0);

    if siblings.is_empty() {
        siblings.push(current.clone());
    }

    Ok(FileContextPayload {
        current,
        siblings,
        current_index,
    })
}

fn collect_siblings(parent: Option<&Path>) -> Vec<FileMeta> {
    let Some(dir) = parent else {
        return Vec::new();
    };
    // Do not treat the flat mobile staging root directory as a user folder of siblings
    if dir.file_name().and_then(|n| n.to_str()) == Some("opened_files") {
        return Vec::new();
    }
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };

    entries
        .flatten()
        .filter_map(|entry| {
            let meta = entry.metadata().ok()?;
            if !meta.is_file() {
                return None;
            }
            Some(build_meta(&entry.path(), meta.len()))
        })
        .take(3000)
        .collect()
}

/// Read raw file bytes for binary document parsers (PDF, DOCX, PPTX, XLSX).
pub fn read_raw_bytes(target_path: &str) -> Result<Vec<u8>, String> {
    fs::read(target_path).map_err(|e| format!("Failed to read file bytes: {e}"))
}

/// Decode text files automatically supporting UTF-8, UTF-16 LE/BE, and GB18030/GBK.
pub fn read_smart_text(target_path: &str, max_bytes: usize) -> Result<DecodedText, String> {
    let file = File::open(target_path).map_err(|e| format!("Failed to open text file: {e}"))?;
    let total_len = file.metadata().map(|m| m.len() as usize).unwrap_or(0);
    let limit = max_bytes.max(64 * 1024);

    let mut buf = Vec::with_capacity(total_len.min(limit));
    file.take(limit as u64)
        .read_to_end(&mut buf)
        .map_err(|e| format!("Failed to read text content: {e}"))?;

    let (content, encoding) = decode_buffer(&buf);
    Ok(DecodedText {
        content,
        encoding: encoding.to_string(),
        truncated: total_len > limit,
    })
}

fn decode_buffer(buf: &[u8]) -> (String, &'static str) {
    if buf.starts_with(&[0xEF, 0xBB, 0xBF]) {
        let (cow, _, _) = UTF_8.decode(&buf[3..]);
        return (cow.into_owned(), "UTF-8 BOM");
    }
    if buf.starts_with(&[0xFF, 0xFE]) {
        let (cow, _, _) = UTF_16LE.decode(&buf[2..]);
        return (cow.into_owned(), "UTF-16 LE");
    }
    if buf.starts_with(&[0xFE, 0xFF]) {
        let (cow, _, _) = UTF_16BE.decode(&buf[2..]);
        return (cow.into_owned(), "UTF-16 BE");
    }
    match std::str::from_utf8(buf) {
        Ok(valid_utf8) => return (valid_utf8.to_string(), "UTF-8"),
        Err(err) if err.error_len().is_none() => {
            let valid_slice = std::str::from_utf8(&buf[..err.valid_up_to()]).unwrap_or("");
            return (valid_slice.to_string(), "UTF-8");
        }
        _ => {}
    }
    let (cow, _, _) = GB18030.decode(buf);
    (cow.into_owned(), "GBK / GB18030")
}

fn normalize_companion_path(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for comp in path.components() {
        match comp {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// Resolve an explicit or stem-matched companion resource (.mtl or texture image) for 3D models.
pub fn resolve_companion_file(
    base_file_path: &str,
    reference: Option<&str>,
    fallback_exts: &[String],
) -> Option<String> {
    let base_path = Path::new(base_file_path);
    let base_dir = base_path.parent()?;

    let found = match reference.map(str::trim).filter(|s| !s.is_empty()) {
        Some(raw_ref) => resolve_explicit_ref(base_dir, raw_ref),
        None => resolve_by_stem(base_path, base_dir, fallback_exts),
    };
    found.map(|p| normalize_companion_path(&p).to_string_lossy().into_owned())
}

fn find_case_insensitive_in_dir(dir: &Path, target_lower: &str) -> Option<PathBuf> {
    let direct = dir.join(target_lower);
    if direct.is_file() {
        return Some(direct);
    }
    let entries = fs::read_dir(dir).ok()?;
    entries.flatten().find_map(|entry| {
        let path = entry.path();
        let matches = entry.file_name().to_string_lossy().to_lowercase() == target_lower;
        (matches && path.is_file()).then_some(path)
    })
}

fn resolve_explicit_ref(base_dir: &Path, raw_ref: &str) -> Option<PathBuf> {
    let cleaned = raw_ref.trim().trim_matches(|c| c == '"' || c == '\'');
    if cleaned.is_empty() {
        return None;
    }
    let normalized = cleaned.replace('/', std::path::MAIN_SEPARATOR_STR);
    let relative_hit = base_dir.join(&normalized);
    if relative_hit.is_file() {
        return Some(relative_hit);
    }
    let direct_hit = Path::new(&normalized);
    if direct_hit.is_file() {
        return Some(direct_hit.to_path_buf());
    }

    let basename = cleaned.rsplit(['/', '\\']).next()?.trim().to_lowercase();
    for subdir in [
        "",
        "textures",
        "texture",
        "maps",
        "materials",
        "../textures",
        "../texture",
        "../maps",
        "../materials",
    ] {
        let search_dir = if subdir.is_empty() {
            base_dir.to_path_buf()
        } else {
            base_dir.join(subdir)
        };
        if let Some(hit) = find_case_insensitive_in_dir(&search_dir, &basename) {
            return Some(hit);
        }
    }
    None
}

fn resolve_by_stem(base_path: &Path, base_dir: &Path, exts: &[String]) -> Option<PathBuf> {
    let stem = base_path.file_stem()?.to_str()?.to_lowercase();
    let candidates = [
        stem.clone(),
        format!("{stem}_tex"),
        format!("{stem}_texture"),
        format!("{stem}_diffuse"),
        format!("{stem}_albedo"),
        format!("{stem}_color"),
        format!("{stem}_map"),
        format!("{stem}0"),
        format!("{stem}_0"),
    ];

    for subdir in [
        "",
        "textures",
        "texture",
        "maps",
        "../textures",
        "../texture",
        "../maps",
    ] {
        let dir = if subdir.is_empty() {
            base_dir.to_path_buf()
        } else {
            base_dir.join(subdir)
        };
        if !dir.is_dir() {
            continue;
        }
        for cand in &candidates {
            for ext in exts {
                let target = format!("{cand}.{}", ext.trim_start_matches('.').to_lowercase());
                if let Some(hit) = find_case_insensitive_in_dir(&dir, &target) {
                    return Some(hit);
                }
            }
        }
    }
    None
}
