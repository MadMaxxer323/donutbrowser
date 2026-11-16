//! Encrypted, local-only profile backup and restore.
//!
//! The archive contains opaque ZIP entry names. The manifest (which contains
//! profile metadata and original file paths) is encrypted, and each data file
//! is encrypted in bounded AES-GCM chunks so large browser profiles do not have
//! to be loaded into memory at once.
//!
//! A restore always creates a NEW profile UUID. It never overwrites an existing
//! profile or restores stale process/network references.

use rand::RngExt;
use serde::{Deserialize, Serialize};
use std::fs::{self, File, OpenOptions};
use std::io::{BufReader, BufWriter, Read, Write};
use std::path::{Component, Path, PathBuf};
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

use crate::profile::{BrowserProfile, ProfileManager};
use crate::profile::types::SyncMode;

const FORMAT_VERSION: u32 = 1;
const SALT_ENTRY: &str = "hider/salt.bin";
const MANIFEST_ENTRY: &str = "hider/manifest.enc";
const CHUNK_BYTES: usize = 4 * 1024 * 1024;
const MAX_MANIFEST_BYTES: u64 = 32 * 1024 * 1024;
const MAX_FILE_COUNT: usize = 200_000;
const MAX_PROFILE_BYTES: u64 = 2 * 1024 * 1024 * 1024 * 1024; // 2 TiB
const PASSWORD_MIN_BYTES: usize = 12;

#[derive(Debug, Clone, Serialize, Deserialize)]
struct BackupManifest {
  version: u32,
  created_at: String,
  profile: BrowserProfile,
  files: Vec<BackupFile>,
  total_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct BackupFile {
  path: String,
  object: String,
  size: u64,
  blake3: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileBackupSummary {
  pub profile_name: String,
  pub files: usize,
  pub bytes: u64,
  pub restored_profile_id: Option<String>,
  /// Profile-level proxy/VPN references are intentionally cleared on restore.
  pub network_settings_restored: bool,
}

fn backend_error(code: &str) -> String {
  crate::backend_error(code)
}

async fn run_backup_blocking<T: Send + 'static>(
  work: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
  crate::profile::manager::run_blocking(work)
    .await
    .map_err(|error| error.to_string())?
}

fn validate_password(password: &str) -> Result<(), String> {
  if password.as_bytes().len() < PASSWORD_MIN_BYTES {
    return Err(serde_json::json!({
      "code": "LOCAL_BACKUP_PASSWORD_TOO_SHORT",
      "params": { "minimum": PASSWORD_MIN_BYTES }
    }).to_string());
  }
  Ok(())
}

fn validate_backup_path(path: &str) -> Result<PathBuf, String> {
  if path.trim().is_empty() {
    return Err(backend_error("LOCAL_BACKUP_PATH_REQUIRED"));
  }
  let path = PathBuf::from(path);
  if !path.is_absolute() {
    return Err(backend_error("LOCAL_BACKUP_PATH_INVALID"));
  }
  if path.extension().and_then(|ext| ext.to_str()) != Some("hiderbackup") {
    return Err(backend_error("LOCAL_BACKUP_EXTENSION_REQUIRED"));
  }
  Ok(path)
}

fn is_reserved_windows_component(value: &str) -> bool {
  let stem = value
    .split('.')
    .next()
    .unwrap_or_default()
    .trim_end_matches([' ', '.'])
    .to_ascii_uppercase();
  matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
    || (1..=9).any(|n| stem == format!("COM{n}") || stem == format!("LPT{n}"))
}

fn validate_archive_relative_path(value: &str) -> Result<PathBuf, String> {
  if value.is_empty() || value.contains('\\') || value.contains('\0') {
    return Err(backend_error("LOCAL_BACKUP_INVALID_PATH"));
  }
  let path = Path::new(value);
  if path.is_absolute() {
    return Err(backend_error("LOCAL_BACKUP_INVALID_PATH"));
  }

  let mut components = Vec::new();
  for component in path.components() {
    let Component::Normal(part) = component else {
      return Err(backend_error("LOCAL_BACKUP_INVALID_PATH"));
    };
    let Some(part) = part.to_str() else {
      return Err(backend_error("LOCAL_BACKUP_INVALID_PATH"));
    };
    if part.is_empty()
      || part.ends_with([' ', '.'])
      || part.chars().any(|c| c.is_control() || matches!(c, '<' | '>' | ':' | '"' | '|' | '?' | '*'))
      || is_reserved_windows_component(part)
    {
      return Err(backend_error("LOCAL_BACKUP_INVALID_PATH"));
    }
    components.push(part);
  }

  if components.len() < 2 || components[0] != "profile" {
    return Err(backend_error("LOCAL_BACKUP_INVALID_PATH"));
  }
  Ok(path.to_path_buf())
}
fn is_volatile_cache_component(name: &str) -> bool {
  matches!(
    name,
    "Cache"
      | "Code Cache"
      | "GPUCache"
      | "GrShaderCache"
      | "ShaderCache"
      | "DawnCache"
      | "DawnGraphiteCache"
      | "GraphiteDawnCache"
      | "DawnWebGPUCache"
      | "GPUPersistentCache"
      | "Crashpad"
      | "Crash Reports"
      | "BrowserMetrics"
      | "component_crx_cache"
      | "Safe Browsing"
      | "optimization_guide_model_store"
      | "blob_storage"
      | "cache2"
      | "startupCache"
      | "datareporting"
      | "saved-telemetry-pings"
      | "crashes"
      | "minidumps"
  )
}

fn is_volatile_file(name: &str) -> bool {
  name.starts_with("Singleton")
    || name == "LOCK"
    || name == "LOG"
    || name == "LOG.old"
    || name == ".DS_Store"
    || name.ends_with(".tmp")
    || name.ends_with(".donut-tmp")
    || name.starts_with("BrowserMetrics")
}

fn collect_profile_files(
  root: &Path,
  current: &Path,
  files: &mut Vec<(String, PathBuf, u64)>,
  total: &mut u64,
) -> Result<(), String> {
  for entry in fs::read_dir(current).map_err(|e| e.to_string())? {
    let entry = entry.map_err(|e| e.to_string())?;
    let path = entry.path();
    let name = entry.file_name().to_string_lossy().to_string();

    if is_volatile_cache_component(&name) || is_volatile_file(&name) {
      continue;
    }

    let metadata = fs::symlink_metadata(&path).map_err(|e| e.to_string())?;
    let kind = metadata.file_type();

    // Browser profile directories should not contain symlinks. Refusing them
    // prevents a crafted profile entry from making a backup read outside the
    // profile folder.
    if kind.is_symlink() {
      return Err(serde_json::json!({
        "code": "LOCAL_BACKUP_SYMLINK_NOT_ALLOWED",
        "params": { "path": path.to_string_lossy() }
      }).to_string());
    }

    if kind.is_dir() {
      collect_profile_files(root, &path, files, total)?;
      continue;
    }
    if !kind.is_file() {
      continue;
    }

    let relative = path
      .strip_prefix(root)
      .map_err(|_| backend_error("LOCAL_BACKUP_INVALID_PATH"))?;
    let relative = relative
      .components()
      .map(|part| part.as_os_str().to_string_lossy())
      .collect::<Vec<_>>()
      .join("/");
    let relative = format!("profile/{relative}");
    validate_archive_relative_path(&relative)?;

    let size = metadata.len();
    *total = total
      .checked_add(size)
      .ok_or_else(|| backend_error("LOCAL_BACKUP_TOO_LARGE"))?;
    if *total > MAX_PROFILE_BYTES {
      return Err(backend_error("LOCAL_BACKUP_TOO_LARGE"));
    }
    files.push((relative, path, size));
    if files.len() > MAX_FILE_COUNT {
      return Err(backend_error("LOCAL_BACKUP_TOO_MANY_FILES"));
    }
  }
  Ok(())
}

fn encrypt_stream_to_zip(
  writer: &mut ZipWriter<BufWriter<File>>,
  entry_name: &str,
  source: &Path,
  key: &[u8; 32],
) -> Result<(u64, String), String> {
  let options = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
  writer
    .start_file(entry_name, options)
    .map_err(|e| e.to_string())?;

  let mut input = File::open(source).map_err(|e| e.to_string())?;
  let mut buffer = vec![0u8; CHUNK_BYTES];
  let mut hash = blake3::Hasher::new();
  let mut total = 0u64;

  loop {
    let read = input.read(&mut buffer).map_err(|e| e.to_string())?;
    if read == 0 {
      break;
    }
    let chunk = &buffer[..read];
    let encrypted = crate::sync::encryption::encrypt_bytes(key, chunk)?;
    let length = u32::try_from(encrypted.len())
      .map_err(|_| backend_error("LOCAL_BACKUP_CHUNK_TOO_LARGE"))?;
    writer
      .write_all(&length.to_le_bytes())
      .and_then(|_| writer.write_all(&encrypted))
      .map_err(|e| e.to_string())?;
    hash.update(chunk);
    total = total.saturating_add(read as u64);
  }

  // A zero-length frame marks the end of this file, including empty files.
  writer.write_all(&0u32.to_le_bytes()).map_err(|e| e.to_string())?;
  Ok((total, hash.finalize().to_hex().to_string()))
}

fn decrypt_stream_from_zip<R: Read, W: Write>(
  input: &mut R,
  output: &mut W,
  key: &[u8; 32],
  expected_size: u64,
) -> Result<(u64, String), String> {
  let mut hash = blake3::Hasher::new();
  let mut total = 0u64;

  loop {
    let mut length = [0u8; 4];
    input.read_exact(&mut length).map_err(|_| backend_error("LOCAL_BACKUP_TRUNCATED"))?;
    let length = u32::from_le_bytes(length) as usize;
    if length == 0 {
      let mut trailing = [0u8; 1];
      if input.read(&mut trailing).map_err(|e| e.to_string())? != 0 {
        return Err(backend_error("LOCAL_BACKUP_CHUNK_INVALID"));
      }
      break;
    }
    if length > CHUNK_BYTES + 64 {
      return Err(backend_error("LOCAL_BACKUP_CHUNK_INVALID"));
    }
    let mut encrypted = vec![0u8; length];
    input.read_exact(&mut encrypted).map_err(|_| backend_error("LOCAL_BACKUP_TRUNCATED"))?;
    let plain = crate::sync::encryption::decrypt_bytes(key, &encrypted)?;
    total = total
      .checked_add(plain.len() as u64)
      .ok_or_else(|| backend_error("LOCAL_BACKUP_TOO_LARGE"))?;
    if total > expected_size || total > MAX_PROFILE_BYTES {
      return Err(backend_error("LOCAL_BACKUP_SIZE_MISMATCH"));
    }
    hash.update(&plain);
    output.write_all(&plain).map_err(|e| e.to_string())?;
  }

  if total != expected_size {
    return Err(backend_error("LOCAL_BACKUP_SIZE_MISMATCH"));
  }
  Ok((total, hash.finalize().to_hex().to_string()))
}

fn make_unique_restored_name(original: &str) -> String {
  let manager = ProfileManager::instance();
  let taken: std::collections::HashSet<String> = manager
    .list_profiles()
    .unwrap_or_default()
    .into_iter()
    .map(|p| p.name.to_lowercase())
    .collect();
  let base = format!("{original} (Restored)");
  if !taken.contains(&base.to_lowercase()) {
    return base;
  }
  for index in 2..=10_000 {
    let candidate = format!("{base} {index}");
    if !taken.contains(&candidate.to_lowercase()) {
      return candidate;
    }
  }
  format!("{base} {}", uuid::Uuid::new_v4())
}

/// Export a stopped, persistent profile into a passphrase-encrypted archive.
/// The destination is selected by the frontend's native Save dialog.
#[tauri::command]
pub async fn create_local_profile_backup(
  profile_id: String,
  destination: String,
  password: String,
) -> Result<ProfileBackupSummary, String> {
  run_backup_blocking(move || {
    create_local_profile_backup_blocking(profile_id, destination, password)
  })
  .await
}

fn create_local_profile_backup_blocking(
  profile_id: String,
  destination: String,
  password: String,
) -> Result<ProfileBackupSummary, String> {
  validate_password(&password)?;
  let destination = validate_backup_path(&destination)?;
  let profile = ProfileManager::instance()
    .find_profile(&profile_id)
    .map_err(|e| e.to_string())?;

  if profile.ephemeral || profile.temporary {
    return Err(backend_error("LOCAL_BACKUP_EPHEMERAL_NOT_ALLOWED"));
  }
  // An unlocked protected profile can contain newer plaintext changes in its
  // RAM-backed copy. Refuse a stale backup until the profile has been locked.
  if profile.password_protected && crate::profile::encryption::has_cached_key(&profile.id) {
    return Err(backend_error("LOCAL_BACKUP_PROFILE_UNLOCKED"));
  }
  if profile.process_id.is_some_and(crate::proxy_storage::is_process_running) {
    return Err(backend_error("LOCAL_BACKUP_PROFILE_RUNNING"));
  }

  let profile_root = ProfileManager::instance()
    .get_profiles_dir()
    .join(profile.id.to_string());
  let data_root = profile_root.join("profile");
  if !profile_root.is_dir() {
    return Err(backend_error("PROFILE_NOT_FOUND"));
  }
  if data_root.exists() && fs::symlink_metadata(&data_root)
    .map_err(|e| e.to_string())?
    .file_type()
    .is_symlink()
  {
    return Err(backend_error("LOCAL_BACKUP_SYMLINK_NOT_ALLOWED"));
  }

  let mut files = Vec::new();
  let mut total_bytes = 0u64;
  if data_root.exists() {
    collect_profile_files(&data_root, &data_root, &mut files, &mut total_bytes)?;
  }

  let mut manifest = BackupManifest {
    version: FORMAT_VERSION,
    created_at: chrono::Utc::now().to_rfc3339(),
    profile: profile.clone(),
    files: Vec::with_capacity(files.len()),
    total_bytes: 0,
  };

  let salt: [u8; 16] = rand::rng().random();
  let key = crate::sync::encryption::derive_vault_key(password.as_bytes(), &salt)?;

  if let Some(parent) = destination.parent() {
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
  }
  let temporary = destination.with_extension(format!("hiderbackup-{}.tmp", uuid::Uuid::new_v4()));
  let archive_file = OpenOptions::new()
    .write(true)
    .create_new(true)
    .open(&temporary)
    .map_err(|e| e.to_string())?;
  let mut writer = ZipWriter::new(BufWriter::new(archive_file));
  let options = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);

  let write_result = (|| -> Result<(), String> {
    writer.start_file(SALT_ENTRY, options).map_err(|e| e.to_string())?;
    writer.write_all(&salt).map_err(|e| e.to_string())?;

    for (relative, source, source_size) in &files {
      let object = format!("objects/{}", uuid::Uuid::new_v4());
      let (written, hash) = encrypt_stream_to_zip(&mut writer, &object, source, &key)?;
      if written != *source_size {
        return Err(backend_error("LOCAL_BACKUP_SOURCE_CHANGED"));
      }
      manifest.files.push(BackupFile {
        path: relative.clone(),
        object,
        size: written,
        blake3: hash,
      });
      manifest.total_bytes = manifest.total_bytes.saturating_add(written);
    }

    let manifest_bytes = serde_json::to_vec(&manifest).map_err(|e| e.to_string())?;
    if manifest_bytes.len() as u64 > MAX_MANIFEST_BYTES {
      return Err(backend_error("LOCAL_BACKUP_MANIFEST_TOO_LARGE"));
    }
    let encrypted_manifest = crate::sync::encryption::encrypt_bytes(&key, &manifest_bytes)?;
    writer.start_file(MANIFEST_ENTRY, options).map_err(|e| e.to_string())?;
    writer.write_all(&encrypted_manifest).map_err(|e| e.to_string())?;
    Ok(())
  })();

  let finish_result = match write_result {
    Ok(()) => writer
      .finish()
      .map(|mut out| out.flush())
      .map_err(|e| e.to_string())
      .and_then(|result| result.map_err(|e| e.to_string())),
    Err(error) => {
      // Drop the file handle before removing the temp file; Windows requires it.
      drop(writer);
      Err(error)
    }
  };

  if let Err(error) = finish_result {
    let _ = fs::remove_file(&temporary);
    return Err(error);
  }

  // Keep the last valid backup until the replacement file has been installed.
  let previous = destination.with_extension(format!("hiderbackup-{}.old", uuid::Uuid::new_v4()));
  let had_previous = destination.exists();
  if had_previous {
    fs::rename(&destination, &previous).map_err(|e| {
      let _ = fs::remove_file(&temporary);
      e.to_string()
    })?;
  }
  if let Err(error) = fs::rename(&temporary, &destination) {
    if had_previous {
      let _ = fs::rename(&previous, &destination);
    }
    let _ = fs::remove_file(&temporary);
    return Err(error.to_string());
  }
  if had_previous {
    if let Err(error) = fs::remove_file(&previous) {
      log::warn!(
        "Previous local backup could not be removed path=\"{}\" err=\"{error}\"",
        previous.display()
      );
    }
  }

  Ok(ProfileBackupSummary {
    profile_name: profile.name,
    files: manifest.files.len(),
    bytes: manifest.total_bytes,
    restored_profile_id: None,
    network_settings_restored: false,
  })
}

/// Restore an encrypted archive as a NEW profile. Machine-specific network,
/// group and sync references are cleared; browser data and Wayfern identity
/// are retained.
#[tauri::command]
pub async fn restore_local_profile_backup(
  source: String,
  password: String,
) -> Result<ProfileBackupSummary, String> {
  run_backup_blocking(move || restore_local_profile_backup_blocking(source, password)).await
}

fn restore_local_profile_backup_blocking(
  source: String,
  password: String,
) -> Result<ProfileBackupSummary, String> {
  validate_password(&password)?;
  let source = validate_backup_path(&source)?;
  let archive_size = fs::metadata(&source)
    .map_err(|_| backend_error("LOCAL_BACKUP_NOT_FOUND"))?
    .len();
  if archive_size > MAX_PROFILE_BYTES.saturating_mul(2) {
    return Err(backend_error("LOCAL_BACKUP_TOO_LARGE"));
  }
  let file = File::open(&source).map_err(|_| backend_error("LOCAL_BACKUP_NOT_FOUND"))?;
  let mut archive = ZipArchive::new(BufReader::new(file))
    .map_err(|_| backend_error("LOCAL_BACKUP_INVALID_ARCHIVE"))?;
  if archive.len() > MAX_FILE_COUNT + 2 {
    return Err(backend_error("LOCAL_BACKUP_TOO_MANY_FILES"));
  }

  let mut salt = [0u8; 16];
  {
    let mut salt_entry = archive
      .by_name(SALT_ENTRY)
      .map_err(|_| backend_error("LOCAL_BACKUP_INVALID_ARCHIVE"))?;
    if salt_entry.size() != salt.len() as u64 {
      return Err(backend_error("LOCAL_BACKUP_INVALID_ARCHIVE"));
    }
    salt_entry.read_exact(&mut salt).map_err(|_| backend_error("LOCAL_BACKUP_INVALID_ARCHIVE"))?;
  }
  let key = crate::sync::encryption::derive_vault_key(password.as_bytes(), &salt)?;
  let mut encrypted_manifest = Vec::new();
  {
    let mut entry = archive
      .by_name(MANIFEST_ENTRY)
      .map_err(|_| backend_error("LOCAL_BACKUP_INVALID_ARCHIVE"))?;
    if entry.size() > MAX_MANIFEST_BYTES + 64 {
      return Err(backend_error("LOCAL_BACKUP_MANIFEST_TOO_LARGE"));
    }
    entry.read_to_end(&mut encrypted_manifest).map_err(|e| e.to_string())?;
  }
  let manifest_bytes = crate::sync::encryption::decrypt_bytes(&key, &encrypted_manifest)
    .map_err(|_| backend_error("LOCAL_BACKUP_PASSWORD_OR_DATA_INVALID"))?;
  if manifest_bytes.len() as u64 > MAX_MANIFEST_BYTES {
    return Err(backend_error("LOCAL_BACKUP_MANIFEST_TOO_LARGE"));
  }
  let manifest: BackupManifest = serde_json::from_slice(&manifest_bytes)
    .map_err(|_| backend_error("LOCAL_BACKUP_MANIFEST_INVALID"))?;
  if manifest.version != FORMAT_VERSION
    || manifest.files.len() > MAX_FILE_COUNT
    || manifest.total_bytes > MAX_PROFILE_BYTES
    || archive.len() != manifest.files.len() + 2
  {
    return Err(backend_error("LOCAL_BACKUP_VERSION_OR_LIMIT_UNSUPPORTED"));
  }

  let mut declared_paths = std::collections::HashSet::new();
  let mut declared_objects = std::collections::HashSet::new();
  let mut declared_total = 0u64;
  for entry in &manifest.files {
    validate_archive_relative_path(&entry.path)?;
    if !declared_paths.insert(entry.path.to_lowercase()) {
      return Err(backend_error("LOCAL_BACKUP_DUPLICATE_PATH"));
    }
    let object_id = entry.object.strip_prefix("objects/").unwrap_or("");
    uuid::Uuid::parse_str(object_id).map_err(|_| backend_error("LOCAL_BACKUP_INVALID_OBJECT"))?;
    if !declared_objects.insert(entry.object.clone()) {
      return Err(backend_error("LOCAL_BACKUP_INVALID_OBJECT"));
    }
    declared_total = declared_total
      .checked_add(entry.size)
      .ok_or_else(|| backend_error("LOCAL_BACKUP_TOO_LARGE"))?;
    if declared_total > MAX_PROFILE_BYTES {
      return Err(backend_error("LOCAL_BACKUP_TOO_LARGE"));
    }
  }
  if declared_total != manifest.total_bytes {
    return Err(backend_error("LOCAL_BACKUP_SIZE_MISMATCH"));
  }

  let profile_id = uuid::Uuid::new_v4();
  let profile_root = ProfileManager::instance()
    .get_profiles_dir()
    .join(profile_id.to_string());
  let profile_data_root = profile_root.join("profile");

  let restore_result = (|| -> Result<(), String> {
    fs::create_dir_all(&profile_data_root).map_err(|e| e.to_string())?;
    let mut total = 0u64;

    for file in &manifest.files {
      let relative = validate_archive_relative_path(&file.path)?;
      total = total.checked_add(file.size).ok_or_else(|| backend_error("LOCAL_BACKUP_TOO_LARGE"))?;
      if total > manifest.total_bytes || total > MAX_PROFILE_BYTES {
        return Err(backend_error("LOCAL_BACKUP_SIZE_MISMATCH"));
      }

      let output_path = profile_root.join(relative);
      let parent = output_path.parent().ok_or_else(|| backend_error("LOCAL_BACKUP_INVALID_PATH"))?;
      fs::create_dir_all(parent).map_err(|e| e.to_string())?;

      let mut entry = archive
        .by_name(&file.object)
        .map_err(|_| backend_error("LOCAL_BACKUP_MISSING_OBJECT"))?;
      let mut output = File::create(&output_path).map_err(|e| e.to_string())?;
      let (written, hash) = decrypt_stream_from_zip(&mut entry, &mut output, &key, file.size)?;
      if written != file.size || hash != file.blake3 {
        return Err(backend_error("LOCAL_BACKUP_INTEGRITY_FAILED"));
      }
      output.sync_all().map_err(|e| e.to_string())?;
    }

    if total != manifest.total_bytes {
      return Err(backend_error("LOCAL_BACKUP_SIZE_MISMATCH"));
    }

    let mut profile = manifest.profile.clone();
    profile.id = profile_id;
    profile.name = make_unique_restored_name(&profile.name);
    profile.process_id = None;
    profile.last_launch = None;
    profile.last_sync = None;
    profile.sync_mode = SyncMode::Disabled;
    profile.proxy_id = None;
    profile.vpn_id = None;
    profile.proxy_bypass_rules.clear();
    profile.group_id = None;
    profile.extension_group_id = None;
    profile.status_id = None;
    profile.created_by_id = None;
    profile.created_by_email = None;
    profile.launch_hook = None;
    profile.dns_blocklist = None;
    profile.dns_server = None;
    profile.host_os = Some(std::env::consts::OS.to_string());
    profile.created_at = Some(crate::proxy_manager::now_secs());
    profile.updated_at = Some(crate::proxy_manager::now_secs());
    profile.ephemeral = false;
    profile.temporary = false;

    ProfileManager::instance()
      .save_profile(&profile)
      .map_err(|e| e.to_string())?;
    let _ = crate::events::emit_empty("profiles-changed");
    Ok(())
  })();

  if let Err(error) = restore_result {
    let _ = fs::remove_dir_all(&profile_root);
    return Err(error);
  }

  let restored = ProfileManager::instance()
    .find_profile(&profile_id.to_string())
    .map_err(|e| e.to_string())?;
  Ok(ProfileBackupSummary {
    profile_name: restored.name,
    files: manifest.files.len(),
    bytes: manifest.total_bytes,
    restored_profile_id: Some(profile_id.to_string()),
    network_settings_restored: false,
  })
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn backup_paths_cannot_escape_profile() {
    for path in ["", "../metadata.json", "profile/../../outside", "/profile/Default", "profile\\Default"] {
      assert!(validate_archive_relative_path(path).is_err(), "{path}");
    }
    assert!(validate_archive_relative_path("profile/Default/Cookies").is_ok());
  }

  #[test]
  fn archive_destination_requires_expected_extension_and_absolute_path() {
    assert!(validate_backup_path("relative.hiderbackup").is_err());
    assert!(validate_backup_path("/tmp/test.zip").is_err());
    assert!(validate_backup_path("/tmp/test.hiderbackup").is_ok());
  }

  #[test]
  fn archive_paths_are_safe_on_windows_too() {
    for path in [
      "profile/CON",
      "profile/AUX.txt",
      "profile/dir/LPT1.log",
      "profile/name.",
      "profile/name ",
      "profile/a:b",
      "profile/name*",
      "profile/name|",
    ] {
      assert!(validate_archive_relative_path(path).is_err(), "{path}");
    }
    assert!(validate_archive_relative_path("profile/Default/Local State").is_ok());
    assert!(validate_archive_relative_path("profile/Default/Network/Cookies").is_ok());
  }

  #[test]
  fn encrypted_backup_passphrase_has_a_minimum_length() {
    assert!(validate_password("short").is_err());
    assert!(validate_password("a-long-enough-passphrase").is_ok());
  }

  #[test]
  fn volatile_browser_caches_are_not_backed_up() {
    assert!(is_volatile_cache_component("Cache"));
    assert!(is_volatile_cache_component("Code Cache"));
    assert!(is_volatile_file("SingletonLock"));
    assert!(is_volatile_file("LOG.old"));
    assert!(is_volatile_cache_component("blob_storage"));
    assert!(is_volatile_cache_component("cache2"));
    assert!(!is_volatile_file("Cookies"));
  }
}
