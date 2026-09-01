use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::UNIX_EPOCH;
use tauri::Manager;
use tauri::State;
#[cfg(windows)]
use std::os::windows::fs::MetadataExt;

// Windows DWM：移除无边框窗口的原生边框（DWMWA_BORDER_COLOR），
// 避免三边出现取系统强调色的细边框（Win11 22H2+ 生效）。
#[cfg(windows)]
extern "system" {
    fn DwmSetWindowAttribute(
        hwnd: isize,
        dw_attribute: u32,
        pv_attribute: *const std::ffi::c_void,
        cb_attribute: u32,
    ) -> i32;
}

/// 一次重命名操作，用于撤销/重做。
#[derive(Clone)]
struct RenameOp {
    from: String,
    to: String,
}

/// 撤销/重做栈。
struct History {
    undo: Mutex<Vec<RenameOp>>,
    redo: Mutex<Vec<RenameOp>>,
}

#[derive(Serialize)]
struct FileEntry {
    name: String,   // 含扩展名的完整文件名
    path: String,   // 绝对路径
    is_dir: bool,
    is_hidden: bool,
    ext: String,    // 扩展名（不含点）
    base: String,   // 去扩展名、去标签后的名称
    tags: Vec<String>,
    size: u64,      // 字节；目录为 0
    modified: u64,  // 修改时间（Unix 秒）
}

/// 约定：文件名中从第一个 `#` 开始，每个 `#xxx` 段都是一个标签。
/// base 为第一个 `#` 之前的部分（去掉扩展名）。
fn parse_tags(file_stem: &str) -> (String, Vec<String>) {
    let parts: Vec<&str> = file_stem.split('#').collect();
    if parts.is_empty() {
        return (String::new(), Vec::new());
    }
    let base = parts[0].to_string();
    let tags: Vec<String> = parts[1..]
        .iter()
        .map(|s| s.to_string())
        .filter(|s| !s.is_empty())
        .collect();
    (base, tags)
}

/// 判断是否为隐藏项（跨平台）。
/// - Windows：读取 FAT/NTFS 隐藏属性位。
/// - 其他平台（macOS/Linux）：以开头的点文件（如 .DS_Store、.hidden）视为隐藏。
fn is_hidden(meta: &fs::Metadata, name: &str) -> bool {
    #[cfg(windows)]
    {
        // Windows FILE_ATTRIBUTE_HIDDEN = 0x2
        let _ = name;
        (meta.file_attributes() & 0x2) != 0
    }
    #[cfg(not(windows))]
    {
        let _ = meta;
        name.starts_with('.')
    }
}

/// 常见的系统/无关文件名单（大小写不敏感），在浏览时过滤掉。
const SYSTEM_NAMES: &[&str] = &[
    "desktop.ini",
    "thumbs.db",
    "pagefile.sys",
    "hiberfil.sys",
    "swapfile.sys",
    "$recycle.bin",
    "system volume information",
];

/// 判断是否为应（默认）隐藏的系统文件/文件夹。
fn is_system_file(meta: &fs::Metadata, name: &str) -> bool {
    let lower = name.to_lowercase();
    if SYSTEM_NAMES.contains(&lower.as_str()) {
        return true;
    }
    #[cfg(windows)]
    {
        // Windows FILE_ATTRIBUTE_SYSTEM = 0x4
        if (meta.file_attributes() & 0x4) != 0 {
            return true;
        }
    }
    #[cfg(not(windows))]
    {
        let _ = meta;
    }
    // 以点开头的隐藏文件在 macOS/Linux 上默认折叠（回归：隐藏目录如 .git）
    name.starts_with('.')
}

/// 列出某个目录下的文件与文件夹。
#[tauri::command]
fn list_dir(path: String) -> Result<Vec<FileEntry>, String> {
    let dir = PathBuf::from(&path);
    let read = fs::read_dir(&dir).map_err(|e| e.to_string())?;
    let mut entries = Vec::new();

    for item in read.flatten() {
        let full = item.path();
        let name = item.file_name().to_string_lossy().to_string();
        let file_type = item.file_type().map_err(|e| e.to_string())?;
        let is_dir = file_type.is_dir();

        let meta = item.metadata().map_err(|e| e.to_string())?;

        // 过滤系统/隐藏文件，保持列表干净
        if is_system_file(&meta, &name) {
            continue;
        }

        // name 去扩展名得到 stem，用于解析标签
        let stem = Path::new(&name)
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| name.clone());
        let (base, tags) = parse_tags(&stem);

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

/// Windows 可用的盘符列表，如 ["C:\\", "D:\\"]。
#[tauri::command]
fn get_drives() -> Vec<String> {
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
#[tauri::command]
fn get_default_dir() -> Result<String, String> {
    dirs::download_dir()
        .or_else(dirs::home_dir)
        .map(|p| p.to_string_lossy().to_string())
        .ok_or_else(|| "无法定位下载目录".to_string())
}

/// 构造改名后的新文件名：base + 现有标签 + 新标签 + 扩展名。
fn build_new_name(entry: &FileEntry, add_tag: &str) -> String {
    let mut stem = entry.base.clone();
    for t in &entry.tags {
        stem.push('#');
        stem.push_str(t);
    }
    stem.push('#');
    stem.push_str(add_tag);
    if !entry.ext.is_empty() {
        stem.push('.');
        stem.push_str(&entry.ext);
    }
    stem
}

/// 移除某个标签，返回新文件名。若标签不存在则返回 None。
fn strip_tag(entry: &FileEntry, tag: &str) -> Option<String> {
    let remaining: Vec<&String> = entry.tags.iter().filter(|t| t.as_str() != tag).collect();
    if remaining.len() == entry.tags.len() {
        return None; // 该标签不在文件名中
    }
    let mut stem = entry.base.clone();
    for t in remaining {
        stem.push('#');
        stem.push_str(t);
    }
    if !entry.ext.is_empty() {
        stem.push('.');
        stem.push_str(&entry.ext);
    }
    Some(stem)
}

/// 执行一次会记录进历史的重命名。
fn do_rename(state: &History, from: &str, to: &str) -> Result<(), String> {
    if Path::new(to).exists() {
        return Err(format!("目标文件名已存在：{}", to));
    }
    fs::rename(from, to).map_err(|e| e.to_string())?;
    state.undo.lock().unwrap().push(RenameOp {
        from: from.to_string(),
        to: to.to_string(),
    });
    state.redo.lock().unwrap().clear();
    Ok(())
}

/// 给一个文件/文件夹追加标签（重命名）。
#[tauri::command]
fn add_tag(path: String, tag: String, state: State<History>) -> Result<String, String> {
    let sanitized: String = tag.chars().filter(|c| *c != '#').collect();
    if sanitized.trim().is_empty() {
        return Err("标签不能为空".to_string());
    }
    let entry = build_entry(&path)?;
    let new_name = build_new_name(&entry, &sanitized);
    let new_path = sibling_path(&path, &new_name);
    do_rename(&state, &path, &new_path)?;
    Ok(new_path)
}

/// 重命名文件/文件夹（可撤销）。
#[tauri::command]
fn rename_file(from: String, to: String, state: State<History>) -> Result<(), String> {
    if from == to {
        return Ok(());
    }
    do_rename(&state, &from, &to)?;
    Ok(())
}

/// 删除文件/文件夹。
/// 本地路径移入系统回收站（可恢复，不计入撤销栈）；
/// UNC 网络共享不支持回收站，改为永久删除（`remove_file` / `remove_dir_all`）。
#[tauri::command]
fn delete_file(path: String) -> Result<(), String> {
    let is_unc = path.starts_with("\\\\");
    let p = Path::new(&path);
    if is_unc {
        // 网络路径走永久删除；目录与文件分开处理
        if p.is_dir() {
            fs::remove_dir_all(p).map_err(|e| e.to_string())
        } else if p.is_file() {
            fs::remove_file(p).map_err(|e| e.to_string())
        } else {
            Err("路径不存在".to_string())
        }
    } else {
        trash::delete(&path).map_err(|e| e.to_string())
    }
}

/// 从文件名中移除指定标签。
#[tauri::command]
fn remove_tag(path: String, tag: String, state: State<History>) -> Result<String, String> {
    let entry = build_entry(&path)?;
    let new_name = strip_tag(&entry, &tag).ok_or("该文件不包含此标签")?;
    let new_path = sibling_path(&path, &new_name);
    do_rename(&state, &path, &new_path)?;
    Ok(new_path)
}

/// 撤销上一步改名。
#[tauri::command]
fn undo(state: State<History>) -> Result<(), String> {
    let op = state
        .undo
        .lock()
        .unwrap()
        .pop()
        .ok_or_else(|| "没有可撤销的操作".to_string())?;
    if Path::new(&op.from).exists() {
        return Err(format!("无法撤销：源文件已不存在：{}", op.from));
    }
    fs::rename(&op.to, &op.from).map_err(|e| e.to_string())?;
    state.redo.lock().unwrap().push(op);
    Ok(())
}

/// 重做被撤销的改名。
#[tauri::command]
fn redo(state: State<History>) -> Result<(), String> {
    let op = state
        .redo
        .lock()
        .unwrap()
        .pop()
        .ok_or_else(|| "没有可重做的操作".to_string())?;
    if Path::new(&op.to).exists() {
        return Err(format!("无法重做：目标文件已存在：{}", op.to));
    }
    fs::rename(&op.from, &op.to).map_err(|e| e.to_string())?;
    state.undo.lock().unwrap().push(op);
    Ok(())
}

#[tauri::command]
fn can_undo(state: State<History>) -> bool {
    !state.undo.lock().unwrap().is_empty()
}

#[tauri::command]
fn can_redo(state: State<History>) -> bool {
    !state.redo.lock().unwrap().is_empty()
}

fn sibling_path(parent_file: &str, new_file_name: &str) -> String {
    let p = PathBuf::from(parent_file);
    p.parent()
        .unwrap_or(Path::new("."))
        .join(new_file_name)
        .to_string_lossy()
        .to_string()
}

fn build_entry(path: &str) -> Result<FileEntry, String> {
    let p = PathBuf::from(path);
    let name = p
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    let is_dir = p.is_dir();
    let stem = Path::new(&name)
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| name.clone());
    let (base, tags) = parse_tags(&stem);
    let ext = p
        .extension()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    let meta = fs::metadata(&p).map_err(|e| e.to_string())?;
    let hidden = is_hidden(&meta, &name);
    Ok(FileEntry {
        name,
        path: path.to_string(),
        is_dir,
        is_hidden: hidden,
        ext,
        base,
        tags,
        size: if is_dir { 0 } else { meta.len() },
        modified: 0,
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_fs::init())
        .manage(History {
            undo: Mutex::new(Vec::new()),
            redo: Mutex::new(Vec::new()),
        })
        .invoke_handler(tauri::generate_handler![
            list_dir,
            get_drives,
            get_default_dir,
            add_tag,
            remove_tag,
            rename_file,
            delete_file,
            undo,
            redo,
            can_undo,
            can_redo
        ])
        // 启动期窗口逻辑：按显示器缩放(物理像素)与工作区分辨率将窗口居中；
        // 若窗口任一维度超过可用工作区则自动最大化，避免窗口被截断
        .setup(|app| {
            if let Some(win) = app.get_webview_window("main") {
                #[cfg(windows)]
                {
                    // 无边框窗口会带一圈原生 resize 边框（颜色取系统强调色、各边不一致），
                    // 这里用 DWM 移除边框但保留阴影与缩放命中区
                    const DWMWA_BORDER_COLOR: u32 = 34;
                    const DWMWA_COLOR_NONE: u32 = 0xFFFF_FFFE;
                    if let Ok(hwnd) = win.hwnd() {
                        let none: u32 = DWMWA_COLOR_NONE;
                        unsafe {
                            DwmSetWindowAttribute(
                                hwnd.0 as isize,
                                DWMWA_BORDER_COLOR,
                                &none as *const u32 as *const std::ffi::c_void,
                                std::mem::size_of::<u32>() as u32,
                            );
                        }
                    }
                }
                if let Ok(Some(monitor)) = win.current_monitor() {
                    if let Ok(wsize) = win.outer_size() {
                        // 显示器尺寸与左上角，单位物理像素，已含 DPI 缩放
                        let mpos = monitor.position();
                        let msize = monitor.size();
                        let needs_maximize =
                            wsize.width > msize.width || wsize.height > msize.height;
                        if needs_maximize {
                            win.maximize()?;
                        } else {
                            // 居中：左上角 = 工作区左上角 + (工作区尺寸 - 窗口尺寸) / 2
                            let w_w = wsize.width as i32;
                            let w_h = wsize.height as i32;
                            let x = (mpos.x + (msize.width as i32 - w_w) / 2).max(mpos.x);
                            let y = (mpos.y + (msize.height as i32 - w_h) / 2).max(mpos.y);
                            win.set_position(tauri::PhysicalPosition::new(x, y))?;
                        }
                    }
                }
                // 失败兜底：窗口以 visible:false 启动，由前端在首帧渲染后调用 show()。
                // 若前端因异常一直未触发，5 秒后强制显示，避免窗口永久隐藏；
                // 正常路径下 show() 幂等，无副作用。
                let win = win.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_secs(5));
                    let _ = win.show();
                });
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running zeta application");
}