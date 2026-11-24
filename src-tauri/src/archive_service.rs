use encoding_rs::GB18030;
use flate2::read::GzDecoder;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{self, Read, Write};
use std::path::{Component, Path, PathBuf};
use std::time::UNIX_EPOCH;
use zip::ZipArchive;

const MAX_LIST_ENTRIES: usize = 5000;
const MAX_EXTRACT_BYTES: u64 = 512 * 1024 * 1024;
const MAX_COMPANION_BYTES: u64 = 256 * 1024 * 1024;
const MAX_COMPANION_TOTAL: u64 = 512 * 1024 * 1024;
const KEEP_ARCHIVE_SESSIONS: usize = 2;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ArchiveFormat {
    Zip,
    SevenZ,
    Rar,
    Tar,
    TarGz,
}

#[derive(Serialize)]
pub struct ZipEntryInfo {
    pub index: usize,
    pub name: String,
    pub size: u64,
    pub compressed_size: u64,
    pub is_dir: bool,
}

struct ExtractTarget {
    index: usize,
    raw_name: String,
    dest_path: PathBuf,
    declared_size: u64,
    max_bytes: u64,
}

/// Detect archive container format using magic header bytes with extension fallback.
pub fn detect_archive_format_from_head_and_name(head: &[u8], target_path: &str) -> ArchiveFormat {
    if head.len() >= 6 && head[..6] == [b'7', b'z', 0xBC, 0xAF, 0x27, 0x1C] {
        return ArchiveFormat::SevenZ;
    }
    if head.len() >= 6 && head[..6] == [b'R', b'a', b'r', b'!', 0x1A, 0x07] {
        return ArchiveFormat::Rar;
    }
    if head.len() >= 2 && head[0] == 0x1F && head[1] == 0x8B {
        return ArchiveFormat::TarGz;
    }
    if head.len() >= 4
        && head[0] == b'P'
        && head[1] == b'K'
        && matches!((head[2], head[3]), (0x03, 0x04) | (0x05, 0x06) | (0x07, 0x08))
    {
        return ArchiveFormat::Zip;
    }

    let lower = target_path.to_ascii_lowercase();
    if lower.ends_with(".7z") {
        ArchiveFormat::SevenZ
    } else if lower.ends_with(".rar") {
        ArchiveFormat::Rar
    } else if lower.ends_with(".tar.gz") || lower.ends_with(".tgz") {
        ArchiveFormat::TarGz
    } else if lower.ends_with(".tar") {
        ArchiveFormat::Tar
    } else {
        ArchiveFormat::Zip
    }
}

fn detect_archive_format(target_path: &str) -> ArchiveFormat {
    let mut head = [0u8; 8];
    let n = File::open(target_path)
        .and_then(|mut f| f.read(&mut head))
        .unwrap_or(0);
    detect_archive_format_from_head_and_name(&head[..n], target_path)
}

fn decode_archive_name(raw: &[u8]) -> String {
    let decoded = match std::str::from_utf8(raw) {
        Ok(valid) => valid.to_string(),
        Err(_) => GB18030.decode(raw).0.into_owned(),
    };
    decoded.replace('\\', "/")
}

fn sanitize_segment(raw: &str) -> String {
    let cleaned: String = raw
        .chars()
        .map(|c| {
            if c.is_control() || matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') {
                '_'
            } else {
                c
            }
        })
        .collect();
    cleaned.trim_matches('.').trim().to_string()
}

/// Sanitize an archive internal path to defend against path traversal (Zip-Slip).
pub fn sanitize_archive_rel_path(name: &str) -> PathBuf {
    let mut rel = PathBuf::new();
    for comp in Path::new(&name.replace('\\', "/")).components() {
        if let Component::Normal(part) = comp {
            let clean = sanitize_segment(&part.to_string_lossy());
            if !clean.is_empty() && clean != "." && clean != ".." {
                rel.push(clean);
            }
        }
    }
    if rel.as_os_str().is_empty() {
        rel.push("entry.bin");
    }
    rel
}

/// Inspect archive contents across ZIP, 7z, RAR, TAR, and TAR.GZ without extracting to disk.
pub fn inspect_zip(target_path: &str) -> Result<Vec<ZipEntryInfo>, String> {
    match detect_archive_format(target_path) {
        ArchiveFormat::Zip => inspect_zip_container(target_path),
        ArchiveFormat::SevenZ => inspect_sevenz_container(target_path),
        ArchiveFormat::Rar => inspect_rar_container(target_path),
        ArchiveFormat::Tar => inspect_tar_reader(
            File::open(target_path).map_err(|e| format!("Cannot open archive: {e}"))?,
        ),
        ArchiveFormat::TarGz => {
            let file = File::open(target_path).map_err(|e| format!("Cannot open archive: {e}"))?;
            inspect_tar_reader(GzDecoder::new(file))
        }
    }
}

fn inspect_zip_container(target_path: &str) -> Result<Vec<ZipEntryInfo>, String> {
    let file = File::open(target_path).map_err(|e| format!("Cannot open archive: {e}"))?;
    let mut archive = ZipArchive::new(file).map_err(|e| format!("Invalid ZIP archive: {e}"))?;
    let total = archive.len().min(MAX_LIST_ENTRIES);
    let mut items = Vec::with_capacity(total);

    for idx in 0..total {
        if let Ok(entry) = archive.by_index(idx) {
            items.push(ZipEntryInfo {
                index: idx,
                name: decode_archive_name(entry.name_raw()),
                size: entry.size(),
                compressed_size: entry.compressed_size(),
                is_dir: entry.is_dir(),
            });
        }
    }
    Ok(items)
}

fn inspect_sevenz_container(target_path: &str) -> Result<Vec<ZipEntryInfo>, String> {
    let mut file = File::open(target_path).map_err(|e| format!("Cannot open 7z archive: {e}"))?;
    let archive = sevenz_rust2::Archive::read(&mut file, &sevenz_rust2::Password::empty())
        .map_err(|e| format!("Cannot read 7z archive (encrypted or unsupported): {e}"))?;
    Ok(archive
        .files
        .iter()
        .enumerate()
        .take(MAX_LIST_ENTRIES)
        .map(|(idx, entry)| ZipEntryInfo {
            index: idx,
            name: entry.name.replace('\\', "/"),
            size: entry.size,
            compressed_size: entry.compressed_size,
            is_dir: entry.is_directory,
        })
        .collect())
}

fn inspect_rar_container(target_path: &str) -> Result<Vec<ZipEntryInfo>, String> {
    let archive = rars::ArchiveReader::read_path(target_path)
        .map_err(|e| format!("Cannot read RAR archive (encrypted or unsupported): {e}"))?;
    Ok(archive
        .members()
        .enumerate()
        .take(MAX_LIST_ENTRIES)
        .map(|(idx, member)| ZipEntryInfo {
            index: idx,
            name: decode_archive_name(&member.meta.name),
            size: member.meta.unpacked_size,
            compressed_size: member.meta.packed_size,
            is_dir: member.meta.is_directory,
        })
        .collect())
}

fn inspect_tar_reader<R: Read>(reader: R) -> Result<Vec<ZipEntryInfo>, String> {
    let mut archive = tar::Archive::new(reader);
    let entries = archive
        .entries()
        .map_err(|e| format!("Cannot read TAR archive: {e}"))?;
    let mut items = Vec::new();

    for (idx, item) in entries.enumerate() {
        if idx >= MAX_LIST_ENTRIES {
            break;
        }
        let entry = item.map_err(|e| format!("Invalid TAR entry: {e}"))?;
        let name = decode_archive_name(&entry.path_bytes());
        let is_dir = entry.header().entry_type().is_dir();
        let size = entry.size();
        items.push(ZipEntryInfo {
            index: idx,
            name,
            size,
            compressed_size: size,
            is_dir,
        });
    }
    Ok(items)
}

fn build_session_dir(archive_path: &str, preview_root: &Path) -> Result<PathBuf, String> {
    let meta = fs::metadata(archive_path).map_err(|e| format!("Cannot access archive: {e}"))?;
    let mtime_secs = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);

    let mut hasher = Sha256::new();
    hasher.update(archive_path.as_bytes());
    hasher.update(b":");
    hasher.update(meta.len().to_le_bytes());
    hasher.update(mtime_secs.to_le_bytes());
    let digest = format!("{:x}", hasher.finalize());

    prune_preview_sessions(preview_root, KEEP_ARCHIVE_SESSIONS.saturating_sub(1));
    let session_dir = preview_root.join(format!("arc_{}", &digest[..16]));
    fs::create_dir_all(&session_dir)
        .map_err(|e| format!("Cannot create archive preview directory: {e}"))?;
    Ok(session_dir)
}

fn prune_preview_sessions(preview_root: &Path, keep_existing: usize) {
    let Ok(entries) = fs::read_dir(preview_root) else {
        return;
    };
    let mut dirs: Vec<(std::time::SystemTime, PathBuf)> = entries
        .flatten()
        .filter_map(|entry| {
            let meta = entry.metadata().ok()?;
            if !meta.is_dir() {
                return None;
            }
            let mtime = meta.modified().unwrap_or(UNIX_EPOCH);
            Some((mtime, entry.path()))
        })
        .collect();

    if dirs.len() <= keep_existing {
        return;
    }
    dirs.sort_by_key(|(t, _)| *t);
    let drop_count = dirs.len() - keep_existing;
    for (_, dir_path) in dirs.into_iter().take(drop_count) {
        let _ = fs::remove_dir_all(dir_path);
    }
}

/// Remove all extracted archive preview subdirectories under the given cache directory.
pub fn clear_archive_preview_cache(cache_dir: &Path) {
    let preview_root = cache_dir.join("archive_preview");
    if preview_root.exists() {
        let _ = fs::remove_dir_all(preview_root);
    }
}

fn is_already_cached(dest_path: &Path, declared_size: u64) -> bool {
    fs::metadata(dest_path)
        .map(|existing| existing.is_file() && existing.len() == declared_size)
        .unwrap_or(false)
}

fn validate_entry_size(declared_size: u64, max_bytes: u64) -> Result<(), String> {
    if declared_size > max_bytes {
        return Err(format!(
            "Entry size ({} MB) exceeds safety extraction limit ({} MB)",
            declared_size / (1024 * 1024),
            max_bytes / (1024 * 1024)
        ));
    }
    Ok(())
}

fn write_bounded_entry<R: Read>(
    reader: R,
    declared_size: u64,
    dest_path: &Path,
    max_bytes: u64,
) -> Result<(), String> {
    validate_entry_size(declared_size, max_bytes)?;

    if is_already_cached(dest_path, declared_size) {
        return Ok(());
    }

    if let Some(parent) = dest_path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Cannot create output directory: {e}"))?;
    }

    let mut out = File::create(dest_path).map_err(|e| format!("Cannot write extracted file: {e}"))?;
    let mut limited = reader.take(max_bytes + 1);
    let written = std::io::copy(&mut limited, &mut out)
        .map_err(|e| format!("Failed reading archive entry stream: {e}"))?;
    if written > max_bytes {
        drop(out);
        let _ = fs::remove_file(dest_path);
        return Err("Extracted archive entry exceeded safety byte limit and was aborted".to_string());
    }
    Ok(())
}

struct BoundedFileWriter {
    file: File,
    written: u64,
    max_bytes: u64,
}

impl BoundedFileWriter {
    fn create(dest_path: &Path, max_bytes: u64) -> Result<Self, String> {
        if let Some(parent) = dest_path.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("Cannot create output directory: {e}"))?;
        }
        let file = File::create(dest_path)
            .map_err(|e| format!("Cannot write extracted file: {e}"))?;
        Ok(Self {
            file,
            written: 0,
            max_bytes,
        })
    }
}

impl Write for BoundedFileWriter {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        let next_total = self.written.saturating_add(buf.len() as u64);
        if next_total > self.max_bytes {
            return Err(io::Error::other(
                "Extracted archive entry exceeded safety byte limit",
            ));
        }
        let n = self.file.write(buf)?;
        self.written = self.written.saturating_add(n as u64);
        Ok(n)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.file.flush()
    }
}

fn is_3d_model_ext(ext: &str) -> bool {
    matches!(ext, "obj" | "ply" | "gltf" | "fbx" | "dae")
}

fn is_html_ext(ext: &str) -> bool {
    matches!(ext, "html" | "htm" | "xhtml")
}

fn is_dicom_ext(ext: &str) -> bool {
    matches!(ext, "dcm" | "dicom" | "dic" | "ima")
}

fn needs_companion_entries(primary_ext: &str) -> bool {
    is_3d_model_ext(primary_ext) || is_html_ext(primary_ext) || is_dicom_ext(primary_ext)
}

fn is_possible_dicom_companion(ext: &str) -> bool {
    is_dicom_ext(ext) || ext.is_empty() || ext.chars().all(|c| c.is_ascii_digit())
}

fn is_3d_companion_ext(ext: &str) -> bool {
    matches!(
        ext,
        "mtl"
            | "bin"
            | "png"
            | "jpg"
            | "jpeg"
            | "webp"
            | "bmp"
            | "gif"
            | "tga"
            | "tif"
            | "tiff"
            | "avif"
            | "jfif"
            | "hdr"
            | "exr"
            | "ktx2"
            | "dds"
    )
}

fn entry_extension_lower(name: &str) -> String {
    let lower = name.to_ascii_lowercase();
    if lower.ends_with(".nii.gz") {
        return "nii.gz".to_string();
    }
    if lower.ends_with(".tar.gz") {
        return "tar.gz".to_string();
    }
    Path::new(name)
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
}

fn resolve_primary_ext(primary_name: &str, primary_dest: &Path) -> String {
    let ext = entry_extension_lower(primary_name);
    if (ext.is_empty() || ext.chars().all(|c| c.is_ascii_digit()))
        && crate::fs_service::has_dicm_magic(primary_dest)
    {
        return "dcm".to_string();
    }
    ext
}

fn classify_companion_priority(
    primary_ext: &str,
    parent_prefix: &str,
    comp_name: &str,
) -> Option<u8> {
    let in_same_tree = parent_prefix.is_empty() || comp_name.starts_with(parent_prefix);
    if is_3d_model_ext(primary_ext) {
        if !is_3d_companion_ext(&entry_extension_lower(comp_name)) {
            return None;
        }
        return Some(if in_same_tree { 0 } else { 1 });
    }
    if is_html_ext(primary_ext) && in_same_tree {
        return Some(0);
    }
    if is_dicom_ext(primary_ext)
        && in_same_tree
        && is_possible_dicom_companion(&entry_extension_lower(comp_name))
    {
        return Some(0);
    }
    None
}

fn select_companion_targets(
    entries: &[ZipEntryInfo],
    entry_index: usize,
    primary_name: &str,
    primary_ext: &str,
    session_dir: &Path,
) -> Vec<ExtractTarget> {
    if !needs_companion_entries(primary_ext) {
        return Vec::new();
    }
    let parent_prefix = primary_name
        .rsplit_once('/')
        .map(|(p, _)| format!("{p}/"))
        .unwrap_or_default();

    let mut ranked: Vec<(u8, usize)> = entries
        .iter()
        .filter(|item| item.index != entry_index && !item.is_dir && item.size <= MAX_COMPANION_BYTES)
        .filter_map(|item| {
            let norm = item.name.replace('\\', "/");
            classify_companion_priority(primary_ext, &parent_prefix, &norm)
                .map(|prio| (prio, item.index))
        })
        .collect();

    ranked.sort_by_key(|(prio, idx)| (*prio, *idx));

    let mut out = Vec::new();
    let mut total_companion: u64 = 0;
    for (_, idx) in ranked {
        let Some(item) = entries.get(idx) else {
            continue;
        };
        if total_companion.saturating_add(item.size) > MAX_COMPANION_TOTAL {
            continue;
        }
        total_companion += item.size;
        let norm = item.name.replace('\\', "/");
        out.push(ExtractTarget {
            index: item.index,
            raw_name: item.name.clone(),
            dest_path: session_dir.join(sanitize_archive_rel_path(&norm)),
            declared_size: item.size,
            max_bytes: MAX_COMPANION_BYTES,
        });
    }
    out
}

fn extract_zip_entry(
    archive_path: &str,
    entry_index: usize,
    session_dir: &Path,
) -> Result<String, String> {
    let file = File::open(archive_path).map_err(|e| format!("Cannot open archive: {e}"))?;
    let mut archive = ZipArchive::new(file).map_err(|e| format!("Invalid ZIP archive: {e}"))?;

    let (primary_name, primary_dest) = {
        let mut entry = archive
            .by_index(entry_index)
            .map_err(|e| format!("Archive entry #{entry_index} not found: {e}"))?;
        if entry.is_dir() {
            return Err("Selected archive entry is a directory".to_string());
        }
        let decoded_name = decode_archive_name(entry.name_raw());
        let declared_size = entry.size();
        let dest_path = session_dir.join(sanitize_archive_rel_path(&decoded_name));
        write_bounded_entry(&mut entry, declared_size, &dest_path, MAX_EXTRACT_BYTES)?;
        (decoded_name, dest_path)
    };

    let primary_ext = resolve_primary_ext(&primary_name, &primary_dest);
    if !needs_companion_entries(&primary_ext) {
        return Ok(primary_dest.to_string_lossy().into_owned());
    }

    let total = archive.len().min(MAX_LIST_ENTRIES);
    let mut listing = Vec::with_capacity(total);
    for idx in 0..total {
        if let Ok(item) = archive.by_index_raw(idx) {
            listing.push(ZipEntryInfo {
                index: idx,
                name: decode_archive_name(item.name_raw()),
                size: item.size(),
                compressed_size: item.compressed_size(),
                is_dir: item.is_dir(),
            });
        }
    }

    for target in
        select_companion_targets(&listing, entry_index, &primary_name, &primary_ext, session_dir)
    {
        if let Ok(mut comp) = archive.by_index(target.index) {
            let _ = write_bounded_entry(
                &mut comp,
                target.declared_size,
                &target.dest_path,
                target.max_bytes,
            );
        }
    }

    Ok(primary_dest.to_string_lossy().into_owned())
}

fn run_sevenz_extract_pass<R: Read + io::Seek>(
    reader: &mut sevenz_rust2::ArchiveReader<R>,
    targets: &[ExtractTarget],
) -> Result<(), String> {
    let mut wanted: HashMap<(String, u64), (PathBuf, u64, u64)> = HashMap::new();
    for target in targets {
        if !is_already_cached(&target.dest_path, target.declared_size) {
            wanted.insert(
                (target.raw_name.clone(), target.declared_size),
                (
                    target.dest_path.clone(),
                    target.declared_size,
                    target.max_bytes,
                ),
            );
        }
    }
    if wanted.is_empty() {
        return Ok(());
    }

    let mut write_err: Option<String> = None;
    reader
        .for_each_entries(|entry, data_reader| {
            let key = (entry.name.clone(), entry.size);
            if let Some((dest_path, declared_size, max_bytes)) = wanted.remove(&key) {
                if let Err(err) = write_bounded_entry(data_reader, declared_size, &dest_path, max_bytes)
                {
                    write_err = Some(err);
                    return Ok(false);
                }
            }
            Ok(!wanted.is_empty())
        })
        .map_err(|e| format!("Failed extracting 7z entry (password-protected or unsupported): {e}"))?;

    if let Some(err) = write_err {
        return Err(err);
    }
    Ok(())
}

fn extract_sevenz_entry(
    archive_path: &str,
    entry_index: usize,
    session_dir: &Path,
) -> Result<String, String> {
    let file = File::open(archive_path).map_err(|e| format!("Cannot open 7z archive: {e}"))?;
    let mut reader = sevenz_rust2::ArchiveReader::new(file, sevenz_rust2::Password::empty())
        .map_err(|e| format!("Cannot read 7z archive: {e}"))?;

    let listing: Vec<ZipEntryInfo> = reader
        .archive()
        .files
        .iter()
        .enumerate()
        .take(MAX_LIST_ENTRIES)
        .map(|(idx, f)| ZipEntryInfo {
            index: idx,
            name: f.name.replace('\\', "/"),
            size: f.size,
            compressed_size: f.compressed_size,
            is_dir: f.is_directory,
        })
        .collect();

    let raw_target = reader
        .archive()
        .files
        .get(entry_index)
        .ok_or_else(|| format!("Archive entry #{entry_index} not found"))?
        .clone();
    if raw_target.is_directory {
        return Err("Selected archive entry is a directory".to_string());
    }
    validate_entry_size(raw_target.size, MAX_EXTRACT_BYTES)?;

    let primary_name = raw_target.name.replace('\\', "/");
    let primary_dest = session_dir.join(sanitize_archive_rel_path(&primary_name));
    let declared_ext = entry_extension_lower(&primary_name);

    let mut targets = vec![ExtractTarget {
        index: entry_index,
        raw_name: raw_target.name.clone(),
        dest_path: primary_dest.clone(),
        declared_size: raw_target.size,
        max_bytes: MAX_EXTRACT_BYTES,
    }];

    if needs_companion_entries(&declared_ext) {
        for mut comp in
            select_companion_targets(&listing, entry_index, &primary_name, &declared_ext, session_dir)
        {
            if let Some(orig) = reader.archive().files.get(comp.index) {
                comp.raw_name = orig.name.clone();
            }
            targets.push(comp);
        }
    }

    run_sevenz_extract_pass(&mut reader, &targets)?;

    // Extensionless/numeric DICOM entries require magic inspection after extraction.
    let resolved_ext = resolve_primary_ext(&primary_name, &primary_dest);
    if resolved_ext != declared_ext && needs_companion_entries(&resolved_ext) {
        let mut dicom_companions = select_companion_targets(
            &listing,
            entry_index,
            &primary_name,
            &resolved_ext,
            session_dir,
        );
        for comp in &mut dicom_companions {
            if let Some(orig) = reader.archive().files.get(comp.index) {
                comp.raw_name = orig.name.clone();
            }
        }
        let _ = run_sevenz_extract_pass(&mut reader, &dicom_companions);
    }

    Ok(primary_dest.to_string_lossy().into_owned())
}

fn run_rars_extract_pass(
    archive: &rars::Archive,
    primary_index: Option<usize>,
    targets: Vec<ExtractTarget>,
    max_member_bytes: u64,
) -> Result<(), String> {
    let mut wanted: HashMap<usize, ExtractTarget> = targets
        .into_iter()
        .filter(|t| !is_already_cached(&t.dest_path, t.declared_size))
        .map(|t| (t.index, t))
        .collect();
    if wanted.is_empty() {
        return Ok(());
    }

    let mut opts = rars::ArchiveReadOptions::new();
    opts.max_member_output_bytes = Some(max_member_bytes);
    opts.max_total_output_bytes = Some(MAX_EXTRACT_BYTES + MAX_COMPANION_TOTAL);

    let mut cur_idx = 0usize;
    archive
        .extract_with_control(opts, |member| {
            let idx = cur_idx;
            cur_idx += 1;
            if wanted.is_empty() {
                return Ok(rars::ExtractionDecision::Stop);
            }
            let Some(target) = wanted.remove(&idx) else {
                return Ok(rars::ExtractionDecision::Skip);
            };
            if member.meta.is_encrypted {
                if primary_index == Some(idx) {
                    return Err(rars::Error::from(io::Error::other(
                        "Encrypted RAR entry is not supported without a password",
                    )));
                }
                return Ok(rars::ExtractionDecision::Skip);
            }
            match BoundedFileWriter::create(&target.dest_path, target.max_bytes) {
                Ok(writer) => Ok(rars::ExtractionDecision::Extract(Box::new(writer))),
                Err(msg) if primary_index != Some(idx) => {
                    let _ = msg;
                    Ok(rars::ExtractionDecision::Skip)
                }
                Err(msg) => Err(rars::Error::from(io::Error::other(msg))),
            }
        })
        .map_err(|e| format!("Failed extracting RAR entry (encrypted or unsupported): {e}"))?;

    Ok(())
}

fn extract_rar_entry(
    archive_path: &str,
    entry_index: usize,
    session_dir: &Path,
) -> Result<String, String> {
    let archive = rars::ArchiveReader::read_path(archive_path)
        .map_err(|e| format!("Cannot read RAR archive: {e}"))?;

    let listing: Vec<ZipEntryInfo> = archive
        .members()
        .enumerate()
        .take(MAX_LIST_ENTRIES)
        .map(|(idx, member)| ZipEntryInfo {
            index: idx,
            name: decode_archive_name(&member.meta.name),
            size: member.meta.unpacked_size,
            compressed_size: member.meta.packed_size,
            is_dir: member.meta.is_directory,
        })
        .collect();

    let primary_info = listing
        .get(entry_index)
        .ok_or_else(|| format!("Archive entry #{entry_index} not found"))?;
    if primary_info.is_dir {
        return Err("Selected archive entry is a directory".to_string());
    }
    validate_entry_size(primary_info.size, MAX_EXTRACT_BYTES)?;

    let primary_name = primary_info.name.clone();
    let primary_dest = session_dir.join(sanitize_archive_rel_path(&primary_name));
    let declared_ext = entry_extension_lower(&primary_name);

    let mut targets = vec![ExtractTarget {
        index: entry_index,
        raw_name: primary_name.clone(),
        dest_path: primary_dest.clone(),
        declared_size: primary_info.size,
        max_bytes: MAX_EXTRACT_BYTES,
    }];
    if needs_companion_entries(&declared_ext) {
        targets.extend(select_companion_targets(
            &listing,
            entry_index,
            &primary_name,
            &declared_ext,
            session_dir,
        ));
    }

    run_rars_extract_pass(&archive, Some(entry_index), targets, MAX_EXTRACT_BYTES)?;

    let resolved_ext = resolve_primary_ext(&primary_name, &primary_dest);
    if resolved_ext != declared_ext && needs_companion_entries(&resolved_ext) {
        let companions = select_companion_targets(
            &listing,
            entry_index,
            &primary_name,
            &resolved_ext,
            session_dir,
        );
        let _ = run_rars_extract_pass(&archive, None, companions, MAX_COMPANION_BYTES);
    }

    Ok(primary_dest.to_string_lossy().into_owned())
}

fn open_tar_boxed(archive_path: &str, gzipped: bool) -> Result<Box<dyn Read>, String> {
    let file = File::open(archive_path).map_err(|e| format!("Cannot open TAR archive: {e}"))?;
    if gzipped {
        Ok(Box::new(GzDecoder::new(file)))
    } else {
        Ok(Box::new(file))
    }
}

fn extract_tar_entry(
    archive_path: &str,
    entry_index: usize,
    session_dir: &Path,
    gzipped: bool,
) -> Result<String, String> {
    let mut listing = Vec::new();
    let mut primary_name: Option<String> = None;
    let mut primary_dest: Option<PathBuf> = None;

    {
        let reader = open_tar_boxed(archive_path, gzipped)?;
        let mut archive = tar::Archive::new(reader);
        let entries = archive
            .entries()
            .map_err(|e| format!("Cannot read TAR archive: {e}"))?;

        for (idx, item) in entries.enumerate() {
            let mut entry = item.map_err(|e| format!("Invalid TAR entry: {e}"))?;
            let name = decode_archive_name(&entry.path_bytes());
            let is_dir = entry.header().entry_type().is_dir();
            let size = entry.size();
            if idx < MAX_LIST_ENTRIES {
                listing.push(ZipEntryInfo {
                    index: idx,
                    name: name.clone(),
                    size,
                    compressed_size: size,
                    is_dir,
                });
            }
            if idx == entry_index {
                if is_dir {
                    return Err("Selected archive entry is a directory".to_string());
                }
                let dest = session_dir.join(sanitize_archive_rel_path(&name));
                write_bounded_entry(&mut entry, size, &dest, MAX_EXTRACT_BYTES)?;
                primary_name = Some(name);
                primary_dest = Some(dest);
                break;
            }
        }
    }

    let primary_name =
        primary_name.ok_or_else(|| format!("Archive entry #{entry_index} not found"))?;
    let primary_dest = primary_dest.unwrap();
    let primary_ext = resolve_primary_ext(&primary_name, &primary_dest);
    if !needs_companion_entries(&primary_ext) {
        return Ok(primary_dest.to_string_lossy().into_owned());
    }

    // Read full listing tail only when companion discovery is required.
    let full_listing = inspect_tar_reader(open_tar_boxed(archive_path, gzipped)?)?;
    let targets = select_companion_targets(
        &full_listing,
        entry_index,
        &primary_name,
        &primary_ext,
        session_dir,
    );
    let mut wanted: HashMap<usize, ExtractTarget> = targets
        .into_iter()
        .filter(|t| !is_already_cached(&t.dest_path, t.declared_size))
        .map(|t| (t.index, t))
        .collect();

    if !wanted.is_empty() {
        let reader = open_tar_boxed(archive_path, gzipped)?;
        let mut archive = tar::Archive::new(reader);
        if let Ok(entries) = archive.entries() {
            for (idx, item) in entries.enumerate() {
                if wanted.is_empty() {
                    break;
                }
                let Ok(mut entry) = item else {
                    continue;
                };
                if let Some(target) = wanted.remove(&idx) {
                    let _ = write_bounded_entry(
                        &mut entry,
                        target.declared_size,
                        &target.dest_path,
                        target.max_bytes,
                    );
                }
            }
        }
    }

    Ok(primary_dest.to_string_lossy().into_owned())
}

/// Extract a single archive entry (plus companion assets for 3D models, HTML, and DICOM) into cache.
pub fn extract_archive_entry(
    archive_path: &str,
    entry_index: usize,
    cache_base_dir: &Path,
) -> Result<String, String> {
    let preview_root = cache_base_dir.join("archive_preview");
    fs::create_dir_all(&preview_root)
        .map_err(|e| format!("Cannot create archive preview root: {e}"))?;
    let session_dir = build_session_dir(archive_path, &preview_root)?;

    match detect_archive_format(archive_path) {
        ArchiveFormat::Zip => extract_zip_entry(archive_path, entry_index, &session_dir),
        ArchiveFormat::SevenZ => extract_sevenz_entry(archive_path, entry_index, &session_dir),
        ArchiveFormat::Rar => extract_rar_entry(archive_path, entry_index, &session_dir),
        ArchiveFormat::Tar => extract_tar_entry(archive_path, entry_index, &session_dir, false),
        ArchiveFormat::TarGz => extract_tar_entry(archive_path, entry_index, &session_dir, true),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use flate2::write::GzEncoder;
    use flate2::Compression;
    use zip::write::SimpleFileOptions;

    fn replace_byte_slice(buf: &mut [u8], needle: &[u8], replacement: &[u8]) {
        assert_eq!(needle.len(), replacement.len());
        let mut idx = 0;
        while idx + needle.len() <= buf.len() {
            if &buf[idx..idx + needle.len()] == needle {
                buf[idx..idx + replacement.len()].copy_from_slice(replacement);
                idx += replacement.len();
            } else {
                idx += 1;
            }
        }
    }

    #[test]
    fn test_archive_format_detection_magic_and_ext() {
        assert_eq!(
            detect_archive_format_from_head_and_name(&[b'7', b'z', 0xBC, 0xAF, 0x27, 0x1C], "x.bin"),
            ArchiveFormat::SevenZ
        );
        assert_eq!(
            detect_archive_format_from_head_and_name(
                &[b'R', b'a', b'r', b'!', 0x1A, 0x07, 0x01, 0x00],
                "x.bin"
            ),
            ArchiveFormat::Rar
        );
        assert_eq!(
            detect_archive_format_from_head_and_name(
                &[b'R', b'a', b'r', b'!', 0x1A, 0x07, 0x00],
                "legacy.rar"
            ),
            ArchiveFormat::Rar
        );
        assert_eq!(
            detect_archive_format_from_head_and_name(&[0x1F, 0x8B, 0x08], "bundle.tar.gz"),
            ArchiveFormat::TarGz
        );
        assert_eq!(
            detect_archive_format_from_head_and_name(&[b'P', b'K', 0x03, 0x04], "doc.apk"),
            ArchiveFormat::Zip
        );
        assert_eq!(
            detect_archive_format_from_head_and_name(&[], "archive.tar"),
            ArchiveFormat::Tar
        );
        assert_eq!(
            detect_archive_format_from_head_and_name(&[], "archive.tgz"),
            ArchiveFormat::TarGz
        );
    }

    #[test]
    fn test_gbk_zip_entry_name_and_extract() {
        let tmp_dir = std::env::temp_dir().join("onepeek_arch_gbk_test");
        let _ = fs::remove_dir_all(&tmp_dir);
        fs::create_dir_all(&tmp_dir).unwrap();

        let (gbk_bytes, _, _) = GB18030.encode("中文报告.txt");
        let placeholder = "a".repeat(gbk_bytes.len());

        let mut cursor = std::io::Cursor::new(Vec::new());
        {
            let mut writer = zip::ZipWriter::new(&mut cursor);
            writer
                .start_file(&placeholder, SimpleFileOptions::default())
                .unwrap();
            writer.write_all(b"OnePeek Archive Preview").unwrap();
            writer.finish().unwrap();
        }
        let mut raw_zip = cursor.into_inner();
        replace_byte_slice(&mut raw_zip, placeholder.as_bytes(), gbk_bytes.as_ref());

        let zip_path = tmp_dir.join("gbk_sample.zip");
        fs::write(&zip_path, raw_zip).unwrap();

        let entries = inspect_zip(&zip_path.to_string_lossy()).expect("inspect gbk zip");
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].index, 0);
        assert_eq!(entries[0].name, "中文报告.txt");

        let extracted = extract_archive_entry(&zip_path.to_string_lossy(), 0, &tmp_dir)
            .expect("extract gbk entry");
        assert_eq!(fs::read(&extracted).unwrap(), b"OnePeek Archive Preview");

        let _ = fs::remove_dir_all(&tmp_dir);
    }

    #[test]
    fn test_zip_slip_traversal_sanitized() {
        let tmp_dir = std::env::temp_dir().join("onepeek_arch_slip_test");
        let _ = fs::remove_dir_all(&tmp_dir);
        fs::create_dir_all(&tmp_dir).unwrap();

        let safe_rel = sanitize_archive_rel_path("../../evil/secret.txt");
        assert_eq!(safe_rel, PathBuf::from("evil").join("secret.txt"));

        let zip_path = tmp_dir.join("slip.zip");
        let mut writer = zip::ZipWriter::new(File::create(&zip_path).unwrap());
        writer
            .start_file("../../escape/note.txt", SimpleFileOptions::default())
            .unwrap();
        writer.write_all(b"contained").unwrap();
        writer.finish().unwrap();

        let cache_dir = tmp_dir.join("cache");
        let extracted = extract_archive_entry(&zip_path.to_string_lossy(), 0, &cache_dir)
            .expect("safe extraction");
        let extracted_path = Path::new(&extracted);
        assert!(extracted_path.starts_with(cache_dir.join("archive_preview")));
        assert!(!tmp_dir.join("escape").exists());
        assert_eq!(fs::read(extracted_path).unwrap(), b"contained");

        let _ = fs::remove_dir_all(&tmp_dir);
    }

    #[test]
    fn test_companion_extraction_for_obj_and_html() {
        let tmp_dir = std::env::temp_dir().join("onepeek_arch_comp_test");
        let _ = fs::remove_dir_all(&tmp_dir);
        fs::create_dir_all(&tmp_dir).unwrap();

        let zip_path = tmp_dir.join("model_bundle.zip");
        let mut writer = zip::ZipWriter::new(File::create(&zip_path).unwrap());
        writer
            .start_file("scan/jaw.obj", SimpleFileOptions::default())
            .unwrap();
        writer.write_all(b"mtllib jaw.mtl\nv 0 0 0\n").unwrap();
        writer
            .start_file("scan/jaw.mtl", SimpleFileOptions::default())
            .unwrap();
        writer.write_all(b"newmtl m\nmap_Kd textures/albedo.png\n").unwrap();
        writer
            .start_file("scan/textures/albedo.png", SimpleFileOptions::default())
            .unwrap();
        writer.write_all(b"pngbytes").unwrap();
        writer.finish().unwrap();

        let obj_path = extract_archive_entry(&zip_path.to_string_lossy(), 0, &tmp_dir)
            .expect("extract obj with companions");
        let obj_dir = Path::new(&obj_path).parent().unwrap();
        assert!(obj_dir.join("jaw.mtl").is_file());
        assert!(obj_dir.join("textures").join("albedo.png").is_file());

        let _ = fs::remove_dir_all(&tmp_dir);
    }

    #[test]
    fn test_obj_companion_filters_siblings_and_supports_sibling_texture_dir() {
        assert!(MAX_COMPANION_BYTES >= 64 * 1024 * 1024);

        let tmp_dir = std::env::temp_dir().join("onepeek_arch_obj_filter_test");
        let _ = fs::remove_dir_all(&tmp_dir);
        fs::create_dir_all(&tmp_dir).unwrap();

        let zip_path = tmp_dir.join("model_split.zip");
        let mut writer = zip::ZipWriter::new(File::create(&zip_path).unwrap());
        writer
            .start_file("models/dubo.obj", SimpleFileOptions::default())
            .unwrap();
        writer.write_all(b"mtllib dubo.mtl\nv 0 0 0\n").unwrap();
        writer
            .start_file("models/dubo.mtl", SimpleFileOptions::default())
            .unwrap();
        writer.write_all(b"newmtl m1\nmap_Kd ../textures/dubo.png\n").unwrap();
        writer
            .start_file("textures/dubo.png", SimpleFileOptions::default())
            .unwrap();
        writer.write_all(b"hd-texture-bytes").unwrap();
        writer
            .start_file("models/other.stl", SimpleFileOptions::default())
            .unwrap();
        writer.write_all(b"solid other").unwrap();
        writer.finish().unwrap();

        let cache_dir = tmp_dir.join("cache");
        let obj_path = extract_archive_entry(&zip_path.to_string_lossy(), 0, &cache_dir)
            .expect("extract obj with split textures dir");
        let obj_dir = Path::new(&obj_path).parent().unwrap();
        let root_dir = obj_dir.parent().unwrap();

        assert!(obj_dir.join("dubo.mtl").is_file());
        assert!(root_dir.join("textures").join("dubo.png").is_file());
        assert!(!obj_dir.join("other.stl").exists());

        let _ = fs::remove_dir_all(&tmp_dir);
    }

    #[test]
    fn test_tar_gz_inspect_and_extract() {
        let tmp_dir = std::env::temp_dir().join("onepeek_arch_tgz_test");
        let _ = fs::remove_dir_all(&tmp_dir);
        fs::create_dir_all(&tmp_dir).unwrap();

        let tgz_path = tmp_dir.join("sample.tar.gz");
        {
            let gz = GzEncoder::new(File::create(&tgz_path).unwrap(), Compression::default());
            let mut builder = tar::Builder::new(gz);

            let body = b"OnePeek TarGz Content";
            let mut header = tar::Header::new_gnu();
            header.set_size(body.len() as u64);
            header.set_mode(0o644);
            header.set_cksum();
            builder
                .append_data(&mut header, "docs/readme.txt", &body[..])
                .unwrap();
            builder.finish().unwrap();
        }

        let entries = inspect_zip(&tgz_path.to_string_lossy()).expect("inspect tar.gz");
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].name, "docs/readme.txt");

        let cache_dir = tmp_dir.join("cache");
        let extracted = extract_archive_entry(&tgz_path.to_string_lossy(), 0, &cache_dir)
            .expect("extract tar.gz entry");
        assert_eq!(fs::read(&extracted).unwrap(), b"OnePeek TarGz Content");

        let _ = fs::remove_dir_all(&tmp_dir);
    }

    #[test]
    fn test_sevenz_inspect_and_extract() {
        let tmp_dir = std::env::temp_dir().join("onepeek_arch_7z_test");
        let _ = fs::remove_dir_all(&tmp_dir);
        fs::create_dir_all(&tmp_dir).unwrap();

        let sz_path = tmp_dir.join("sample.7z");
        {
            let mut writer = sevenz_rust2::ArchiveWriter::create(&sz_path).unwrap();
            let entry = sevenz_rust2::ArchiveEntry::new_file("notes/hello.txt");
            writer
                .push_archive_entry(entry, Some(std::io::Cursor::new(b"OnePeek 7z Content")))
                .unwrap();
            writer.finish().unwrap();
        }

        let entries = inspect_zip(&sz_path.to_string_lossy()).expect("inspect 7z");
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].name, "notes/hello.txt");

        let cache_dir = tmp_dir.join("cache");
        let extracted = extract_archive_entry(&sz_path.to_string_lossy(), 0, &cache_dir)
            .expect("extract 7z entry");
        assert_eq!(fs::read(&extracted).unwrap(), b"OnePeek 7z Content");

        let _ = fs::remove_dir_all(&tmp_dir);
    }

    #[test]
    fn test_rar_inspect_and_extract() {
        let tmp_dir = std::env::temp_dir().join("onepeek_arch_rar_test");
        let _ = fs::remove_dir_all(&tmp_dir);
        fs::create_dir_all(&tmp_dir).unwrap();

        let mut builder = rars::Builder::new(rars::ArchiveVersion::Rar50);
        builder
            .add_bytes(
                b"docs/hello.txt".to_vec(),
                b"OnePeek RAR5 Content".to_vec(),
                None,
                None,
            )
            .unwrap();
        let bytes = builder.to_bytes().unwrap();

        let rar_path = tmp_dir.join("sample.rar");
        fs::write(&rar_path, bytes).unwrap();

        let entries = inspect_zip(&rar_path.to_string_lossy()).expect("inspect rar");
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].name, "docs/hello.txt");

        let cache_dir = tmp_dir.join("cache");
        let extracted = extract_archive_entry(&rar_path.to_string_lossy(), 0, &cache_dir)
            .expect("extract rar entry");
        assert_eq!(fs::read(&extracted).unwrap(), b"OnePeek RAR5 Content");

        let _ = fs::remove_dir_all(&tmp_dir);
    }
}
