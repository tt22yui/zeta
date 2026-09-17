use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use tauri::State;

use crate::fs_util::{is_hidden, is_system_file};
use crate::model::FileEntry;
use crate::tags::{parse_tags, TagSettings};

/// 列出某个目录下的文件与文件夹。
#[tauri::command(async)]
pub(crate) fn list_dir(
    path: String,
    tag_settings: State<TagSettings>,
) -> Result<Vec<FileEntry>, String> {
    let sep = *tag_settings.sep.lock().unwrap();
    let dir = PathBuf::from(&path);
    let read = fs::read_dir(&dir).map_err(|e| e.to_string())?;
    let mut entries = Vec::new();

    for item in read.flatten() {
        let full = item.path();
        let name = item.file_name().to_string_lossy().to_string();
        // 元数据读取失败（如悬空符号链接：macOS/Linux 上 metadata 跟随软链）时跳过该条目，
        // 不能因单个坏项让整个目录报错——前端会把列目录失败当成不可读并回退到父目录。
        let Ok(file_type) = item.file_type() else {
            continue;
        };
        let is_dir = file_type.is_dir();

        let Ok(meta) = item.metadata() else { continue };

        // 过滤系统/隐藏文件，保持列表干净
        if is_system_file(&meta, &name) {
            continue;
        }

        // name 去扩展名得到 stem，用于解析标签
        let stem = Path::new(&name)
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| name.clone());
        let (base, tags) = parse_tags(&stem, sep);

        let ext = full
            .extension()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default();

        let modified = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let size = if is_dir { 0 } else { meta.len() };
        let hidden = is_hidden(&meta, &name);

        entries.push(FileEntry {
            name,
            path: full.to_string_lossy().to_string(),
            is_dir,
            is_hidden: hidden,
            ext,
            base,
            tags,
            size,
            modified,
        });
    }

    // 文件夹在前，其余按名称忽略大小写排序
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });

    Ok(entries)
}

/// 列出指定目录下的子文件夹完整路径（用于地址栏面包屑下钻）。
/// 过滤隐藏/系统项；目录不存在或不可读时返回 Err。
#[tauri::command(async)]
pub(crate) fn list_subdirs(path: String) -> Result<Vec<String>, String> {
    let dir = PathBuf::from(&path);
    let read = fs::read_dir(&dir).map_err(|e| e.to_string())?;
    let mut subs = Vec::new();
    for item in read.flatten() {
        let full = item.path();
        let name = item.file_name().to_string_lossy().to_string();
        let Ok(meta) = item.metadata() else { continue };
        if is_system_file(&meta, &name) || is_hidden(&meta, &name) {
            continue;
        }
        if meta.is_dir() {
            subs.push(full.to_string_lossy().to_string());
        }
    }
    subs.sort_by(|a, b| a.to_lowercase().cmp(&b.to_lowercase()));
    Ok(subs)
}

/// 用户主目录，用于地址栏 `~` 展开为绝对路径。
#[tauri::command(async)]
pub(crate) fn get_home_dir() -> Result<String, String> {
    dirs::home_dir()
        .map(|p| p.to_string_lossy().to_string())
        .ok_or_else(|| "无法定位用户主目录".to_string())
}

/// Windows 可用的盘符列表，如 ["C:\\", "D:\\"]。
#[tauri::command(async)]
pub(crate) fn get_drives() -> Vec<String> {
    (b'A'..=b'Z')
        .filter_map(|c| {
            let drive = format!("{}:\\", c as char);
            if Path::new(&drive).exists() {
                Some(drive)
            } else {
                None
            }
        })
        .collect()
}

/// 应用启动时的默认位置：下载目录（找不到时回退到主目录）。
#[tauri::command(async)]
pub(crate) fn get_default_dir() -> Result<String, String> {
    dirs::download_dir()
        .or_else(dirs::home_dir)
        .map(|p| p.to_string_lossy().to_string())
        .ok_or_else(|| "无法定位下载目录".to_string())
}
