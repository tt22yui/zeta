use serde::Serialize;
use std::collections::HashSet;
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

/// 一次可撤销的操作。
/// Rename = 单次移动/改名；
/// DissolveFolder = 解散文件夹（多步移动 + 删空壳，整体撤销/重做）；
/// CollectFolder = 收入文件夹（新建文件夹 + 多步移入，整体撤销/重做，是 DissolveFolder 的反向）。
#[derive(Clone)]
enum HistoryOp {
    Rename { from: String, to: String },
    DissolveFolder {
        folder: String,
        moved: Vec<(String, String)>, // (原路径 folder/child, 新路径 parent/child)
    },
    CollectFolder {
        folder: String,
        moved: Vec<(String, String)>, // (原路径 parent/item, 新路径 folder/item)
    },
}

/// 撤销/重做栈。
struct History {
    undo: Mutex<Vec<HistoryOp>>,
    redo: Mutex<Vec<HistoryOp>>,
}

impl History {
    fn new() -> Self {
        Self {
            undo: Mutex::new(Vec::new()),
            redo: Mutex::new(Vec::new()),
        }
    }

    /// 记录一次操作：压入撤销栈，并清空重做栈（新操作使重做失效）。
    fn record(&self, op: HistoryOp) {
        self.undo.lock().unwrap().push(op);
        self.redo.lock().unwrap().clear();
    }

    fn push_undo(&self, op: HistoryOp) {
        self.undo.lock().unwrap().push(op);
    }

    fn pop_undo(&self) -> Option<HistoryOp> {
        self.undo.lock().unwrap().pop()
    }

    fn push_redo(&self, op: HistoryOp) {
        self.redo.lock().unwrap().push(op);
    }

    fn pop_redo(&self) -> Option<HistoryOp> {
        self.redo.lock().unwrap().pop()
    }

    fn can_undo(&self) -> bool {
        !self.undo.lock().unwrap().is_empty()
    }

    fn can_redo(&self) -> bool {
        !self.redo.lock().unwrap().is_empty()
    }
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

/// Windows 上不允许出现在文件名中的字符；分隔符校验时排除，避免打标签产生非法文件名。
const SEP_FORBIDDEN: [char; 9] = ['\\', '/', ':', '*', '?', '"', '<', '>', '|'];

/// 校验并规范化标签分隔符：返回首个合法字符；空/空白/非法字符序列则返回 None。
/// 纯逻辑：可独立单元测试。
fn sanitize_sep(input: &str) -> Option<char> {
    input
        .chars()
        .find(|c| !c.is_whitespace() && !SEP_FORBIDDEN.contains(c))
}

/// 校验并规范化标签：trim → 剔除分隔符字符；空标签或含非法文件名字符则返回 None。
/// 非法字符跨平台一律拒绝（即使 macOS 允许 `:` 等），避免同一标签在不同系统表现不一致。
/// 纯逻辑：可独立单元测试。
fn sanitize_tag(tag: &str, sep: char) -> Option<String> {
    if tag.chars().any(|c| SEP_FORBIDDEN.contains(&c)) {
        return None;
    }
    let cleaned: String = tag.trim().chars().filter(|c| *c != sep).collect();
    let cleaned = cleaned.trim().to_string();
    if cleaned.is_empty() {
        return None;
    }
    Some(cleaned)
}

/// 文件名中是否已含该标签。用于打标签的幂等去重，避免写出 `a#x#x`。
fn tag_already_present(entry: &FileEntry, tag: &str) -> bool {
    entry.tags.iter().any(|t| t == tag)
}

/// 标签分隔符配置（内存态）。持久化由前端 `zeta.settings` 负责；
/// 应用启动后由前端 `set_tag_separator` 命令同步，默认 `#`。
struct TagSettings {
    sep: Mutex<char>,
}

impl TagSettings {
    fn new() -> Self {
        Self {
            sep: Mutex::new('#'),
        }
    }
}

/// 约定：文件名中从第一个 `sep` 开始，每个 `sep`xxx` 段都是一个标签。
/// base 为第一个 `sep` 之前的部分（去掉扩展名）。
fn parse_tags(file_stem: &str, sep: char) -> (String, Vec<String>) {
    let parts: Vec<&str> = file_stem.split(sep).collect();
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
        // 以点开头的隐藏文件在 macOS/Linux 上默认折叠（回归：隐藏目录如 .git）。
        // Windows 上点文件不算隐藏，隐藏与否由 is_hidden 依据属性位判定。
        if name.starts_with('.') {
            return true;
        }
    }
    false
}

/// 列出某个目录下的文件与文件夹。
#[tauri::command(async)]
fn list_dir(path: String, tag_settings: State<TagSettings>) -> Result<Vec<FileEntry>, String> {
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
fn list_subdirs(path: String) -> Result<Vec<String>, String> {
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
fn get_home_dir() -> Result<String, String> {
    dirs::home_dir()
        .map(|p| p.to_string_lossy().to_string())
        .ok_or_else(|| "无法定位用户主目录".to_string())
}

/// Windows 可用的盘符列表，如 ["C:\\", "D:\\"]。
#[tauri::command(async)]
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
#[tauri::command(async)]
fn get_default_dir() -> Result<String, String> {
    dirs::download_dir()
        .or_else(dirs::home_dir)
        .map(|p| p.to_string_lossy().to_string())
        .ok_or_else(|| "无法定位下载目录".to_string())
}

/// 构造改名后的新文件名：base + 现有标签 + 新标签 + 扩展名。
fn build_new_name(entry: &FileEntry, add_tag: &str, sep: char) -> String {
    let mut stem = entry.base.clone();
    for t in &entry.tags {
        stem.push(sep);
        stem.push_str(t);
    }
    stem.push(sep);
    stem.push_str(add_tag);
    if !entry.ext.is_empty() {
        stem.push('.');
        stem.push_str(&entry.ext);
    }
    stem
}

/// 移除某个标签，返回新文件名。若标签不存在则返回 None。
fn strip_tag(entry: &FileEntry, tag: &str, sep: char) -> Option<String> {
    let remaining: Vec<&String> = entry.tags.iter().filter(|t| t.as_str() != tag).collect();
    if remaining.len() == entry.tags.len() {
        return None; // 该标签不在文件名中
    }
    let mut stem = entry.base.clone();
    for t in remaining {
        stem.push(sep);
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
    state.record(HistoryOp::Rename {
        from: from.to_string(),
        to: to.to_string(),
    });
    Ok(())
}

/// 给一个文件/文件夹追加标签（重命名）。
#[tauri::command(async)]
fn add_tag(
    path: String,
    tag: String,
    state: State<History>,
    tag_settings: State<TagSettings>,
) -> Result<String, String> {
    let sep = *tag_settings.sep.lock().unwrap();
    // 非法字符与空标签分开报错：前者是输入内容问题，后者是没填
    if tag.chars().any(|c| SEP_FORBIDDEN.contains(&c)) {
        return Err("标签不能包含 \\ / : * ? \" < > | 等字符".to_string());
    }
    let sanitized = sanitize_tag(&tag, sep).ok_or("标签不能为空")?;
    let entry = build_entry(&path, sep)?;
    // 幂等：已含同名标签就不改名，直接返回原路径（前端依赖返回路径恢复选中）
    if tag_already_present(&entry, &sanitized) {
        return Ok(path);
    }
    let new_name = build_new_name(&entry, &sanitized, sep);
    let new_path = sibling_path(&path, &new_name);
    do_rename(&state, &path, &new_path)?;
    Ok(new_path)
}

/// 重命名文件/文件夹（可撤销）。
#[tauri::command(async)]
fn rename_file(from: String, to: String, state: State<History>) -> Result<(), String> {
    if from == to {
        return Ok(());
    }
    do_rename(&state, &from, &to)?;
    Ok(())
}

/// 是否为 UNC（网络共享）路径。
/// `\\server\share` 与 `//server/share` 都算：用户可能从地址栏输入正斜杠形式，
/// 漏判会让回收站删除在网络路径上失败（甚至静默变成永久删除的预期落空）。
/// 纯逻辑：可独立单元测试。
fn is_unc(path: &str) -> bool {
    path.starts_with("\\\\") || path.starts_with("//")
}

/// 删除文件/文件夹。
/// 本地路径移入系统回收站（可恢复，不计入撤销栈）；
/// UNC 网络共享不支持回收站，改为永久删除（`remove_file` / `remove_dir_all`）。
#[tauri::command(async)]
fn delete_file(path: String) -> Result<(), String> {
    let is_unc = is_unc(&path);
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
#[tauri::command(async)]
fn remove_tag(
    path: String,
    tag: String,
    state: State<History>,
    tag_settings: State<TagSettings>,
) -> Result<String, String> {
    let sep = *tag_settings.sep.lock().unwrap();
    let entry = build_entry(&path, sep)?;
    let new_name = strip_tag(&entry, &tag, sep).ok_or("该文件不包含此标签")?;
    let new_path = sibling_path(&path, &new_name);
    do_rename(&state, &path, &new_path)?;
    Ok(new_path)
}

/// 同步标签分隔符到后端内存态。持久化由前端 `zeta.settings` 负责。
#[tauri::command(async)]
fn set_tag_separator(sep: String, tag_settings: State<TagSettings>) -> Result<(), String> {
    let c = sanitize_sep(&sep).ok_or("分隔符不能为空，且不能含 Windows 文件名禁止字符")?;
    *tag_settings.sep.lock().unwrap() = c;
    Ok(())
}

/// 反序回滚已完成的移动（best-effort）。
/// 返回回滚失败的「原路径」列表，供调用方在错误信息里提示用户人工处理。
fn rollback_moves(done: &[(String, String)]) -> Vec<String> {
    let mut failed = Vec::new();
    for (from, to) in done.iter().rev() {
        if fs::rename(to, from).is_err() {
            failed.push(from.clone());
        }
    }
    failed
}

/// 把回滚结果并入错误信息：让用户明确知道「已恢复原状」还是「需要人工收拾」。
fn rollback_note(failed: &[String]) -> String {
    if failed.is_empty() {
        "已回滚，未产生改动".to_string()
    } else {
        format!("回滚失败，以下项需人工确认：{}", failed.join("、"))
    }
}

/// 按序执行一批移动；任一失败即回滚已完成的移动。
/// 目的：这些操作不可撤销地改动了用户文件，失败时必须回到操作前的状态，
/// 而不是留下「移动了一半」的目录（且因未记入历史而无法撤销）。
fn move_all(moves: &[(String, String)]) -> Result<(), String> {
    let mut done: Vec<(String, String)> = Vec::with_capacity(moves.len());
    for (from, to) in moves {
        if let Err(e) = fs::rename(from, to) {
            let note = rollback_note(&rollback_moves(&done));
            return Err(format!("{}；{}", e, note));
        }
        done.push((from.clone(), to.clone()));
    }
    Ok(())
}

/// 目标名是否已被占用：既查磁盘，也查本批次已计划的目标名。
/// 后者不可省：同一批里若「X 冲突改名为 X (2)」而另一个子项本身就叫 X (2)，
/// 只查磁盘会让两个移动指向同一路径（Unix 上 rename 会静默覆盖）。
fn target_taken(path: &Path, planned: &HashSet<String>) -> bool {
    path.exists() || planned.contains(&path.to_string_lossy().to_string())
}

/// 应用一条撤销操作（纯逻辑，不依赖 Tauri 运行时，便于单测失败路径）。
/// 调用方须在本函数返回 Ok 后才出栈，否则校验失败会把条目从历史里吞掉。
fn apply_undo(op: &HistoryOp) -> Result<(), String> {
    match op {
        HistoryOp::Rename { from, to } => {
            if Path::new(from).exists() {
                return Err(format!("无法撤销：源文件已存在：{}", from));
            }
            fs::rename(to, from).map_err(|e| e.to_string())?;
        }
        HistoryOp::DissolveFolder { folder, moved } => {
            // 撤销 = 重建文件夹 + 把子项从 parent 移回 folder
            if Path::new(folder).exists() {
                return Err(format!("无法撤销：文件夹仍存在：{}", folder));
            }
            fs::create_dir(folder).map_err(|e| e.to_string())?;
            let plan: Vec<(String, String)> =
                moved.iter().map(|(f, t)| (t.clone(), f.clone())).collect();
            if let Err(e) = move_all(&plan) {
                // move_all 已回滚；这里只需清掉刚建的空壳（清不掉也不掩盖原始错误）
                let _ = fs::remove_dir(folder);
                return Err(e);
            }
        }
        HistoryOp::CollectFolder { folder, moved } => {
            // 撤销 = 把子项从 folder 移回原位 + 删空壳
            if !Path::new(folder).exists() {
                return Err(format!("无法撤销：文件夹不存在：{}", folder));
            }
            let plan: Vec<(String, String)> =
                moved.iter().map(|(f, t)| (t.clone(), f.clone())).collect();
            move_all(&plan)?;
            if let Err(e) = fs::remove_dir(folder) {
                let note = rollback_note(&rollback_moves(&plan));
                return Err(format!("{}；{}", e, note));
            }
        }
    }
    Ok(())
}

/// 应用一条重做操作（纯逻辑，不依赖 Tauri 运行时）。
fn apply_redo(op: &HistoryOp) -> Result<(), String> {
    match op {
        HistoryOp::Rename { from, to } => {
            if Path::new(to).exists() {
                return Err(format!("无法重做：目标文件已存在：{}", to));
            }
            fs::rename(from, to).map_err(|e| e.to_string())?;
        }
        HistoryOp::DissolveFolder { folder, moved } => {
            // 重做 = 重新移动子项 + 删空壳
            if !Path::new(folder).exists() {
                return Err(format!("无法重做：文件夹不存在：{}", folder));
            }
            let plan: Vec<(String, String)> =
                moved.iter().map(|(f, t)| (f.clone(), t.clone())).collect();
            // 先全量预检目标：避免移动到一半才发现冲突而留下半成品
            for (_, to) in &plan {
                if Path::new(to).exists() {
                    return Err(format!("无法重做：目标已存在：{}", to));
                }
            }
            move_all(&plan)?;
            if let Err(e) = fs::remove_dir(folder) {
                let note = rollback_note(&rollback_moves(&plan));
                return Err(format!("{}；{}", e, note));
            }
        }
        HistoryOp::CollectFolder { folder, moved } => {
            // 重做 = 重建文件夹 + 重新把子项移入
            if Path::new(folder).exists() {
                return Err(format!("无法重做：文件夹已存在：{}", folder));
            }
            let plan: Vec<(String, String)> =
                moved.iter().map(|(f, t)| (f.clone(), t.clone())).collect();
            for (_, to) in &plan {
                if Path::new(to).exists() {
                    return Err(format!("无法重做：目标已存在：{}", to));
                }
            }
            fs::create_dir(folder).map_err(|e| e.to_string())?;
            if let Err(e) = move_all(&plan) {
                let _ = fs::remove_dir(folder);
                return Err(e);
            }
        }
    }
    Ok(())
}

/// 撤销上一步操作。
/// 先出栈再执行：失败时把条目压回撤销栈（保持可重试）。
/// 不用「peek + apply + pop」是因为它要加两次锁，并发撤销时可能把同一条目应用两次。
#[tauri::command(async)]
fn undo(state: State<History>) -> Result<(), String> {
    let op = state
        .pop_undo()
        .ok_or_else(|| "没有可撤销的操作".to_string())?;
    if let Err(e) = apply_undo(&op) {
        state.push_undo(op); // 失败不丢历史：放回栈顶
        return Err(e);
    }
    state.push_redo(op);
    Ok(())
}

/// 重做被撤销的操作。同 undo：失败时放回重做栈。
#[tauri::command(async)]
fn redo(state: State<History>) -> Result<(), String> {
    let op = state
        .pop_redo()
        .ok_or_else(|| "没有可重做的操作".to_string())?;
    if let Err(e) = apply_redo(&op) {
        state.push_redo(op);
        return Err(e);
    }
    state.push_undo(op);
    Ok(())
}

#[tauri::command(async)]
fn can_undo(state: State<History>) -> bool {
    state.can_undo()
}

#[tauri::command(async)]
fn can_redo(state: State<History>) -> bool {
    state.can_redo()
}

/// 解散文件夹纯逻辑：把 folder 内直接子项移到其父目录，删除空壳。
/// 同名冲突按"保留双方+序号"处理（参照资源管理器）。
/// 返回所有移动记录 (原路径 folder/child, 新路径 parent/child) 供撤销使用。
/// 纯逻辑：可独立单元测试（不依赖 Tauri 运行时）。
fn dissolve_folder_inner(folder: &Path) -> Result<Vec<(String, String)>, String> {
    if !folder.is_dir() {
        return Err("目标不是文件夹".to_string());
    }
    let parent = folder
        .parent()
        .ok_or_else(|| "无法解散根目录".to_string())?;

    // 第一步：只读地算出全部移动计划（含同名冲突改名），此时不动任何文件
    let mut planned: HashSet<String> = HashSet::new();
    let mut plan: Vec<(String, String)> = Vec::new();
    for entry in fs::read_dir(folder).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let child_path = entry.path();
        let child_name = entry.file_name().to_string_lossy().to_string();
        let mut target = parent.join(&child_name);
        // 同名冲突：按 "名字 (n).ext" 递增（参照资源管理器"保留双方"）
        if target_taken(&target, &planned) {
            let stem = Path::new(&child_name)
                .file_stem()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_else(|| child_name.clone());
            let ext = Path::new(&child_name)
                .extension()
                .map(|s| format!(".{}", s.to_string_lossy()))
                .unwrap_or_default();
            let mut n = 2;
            loop {
                let candidate = parent.join(format!("{} ({}){}", stem, n, ext));
                if !target_taken(&candidate, &planned) {
                    target = candidate;
                    break;
                }
                n += 1;
            }
        }
        planned.insert(target.to_string_lossy().to_string());
        plan.push((
            child_path.to_string_lossy().to_string(),
            target.to_string_lossy().to_string(),
        ));
    }

    // 第二步：执行；任一失败会回滚已完成的移动，不留下"解散了一半"的目录
    move_all(&plan)?;

    // 删除空壳（仅空目录，不走回收站，以便撤销时直接 create_dir 重建）；
    // 失败时把子项移回，恢复成操作前的样子
    if let Err(e) = fs::remove_dir(folder) {
        let note = rollback_note(&rollback_moves(&plan));
        return Err(format!("{}；{}", e, note));
    }
    Ok(plan)
}

/// 解散文件夹：子项上移到上级，删除空壳（可撤销）。
#[tauri::command(async)]
fn dissolve_folder(path: String, state: State<History>) -> Result<(), String> {
    let folder = Path::new(&path);
    let moved = dissolve_folder_inner(folder)?;
    state.record(HistoryOp::DissolveFolder {
        folder: path,
        moved,
    });
    Ok(())
}

/// 收入文件夹纯逻辑：在 items 同级目录新建 folder_name 文件夹，把每个 item 移入。
/// 同名冲突按 "folder_name (n)" 递增（参照资源管理器"保留双方"）。
/// 约束：所有 items 必须在同一目录，否则报错。
/// 返回 (新建 folder 路径, 移动记录 (原路径 parent/item, 新路径 folder/item)) 供撤销使用。
/// 纯逻辑：可独立单元测试（不依赖 Tauri 运行时）。
fn collect_into_folder_inner(
    items: &[String],
    folder_name: &str,
) -> Result<(String, Vec<(String, String)>), String> {
    if items.is_empty() {
        return Err("未选中任何项".to_string());
    }
    let first = Path::new(&items[0]);
    let parent = first
        .parent()
        .ok_or_else(|| "无法在根目录收集".to_string())?;
    // 校验所有 items 同一 parent，避免跨目录收集
    for s in items {
        if Path::new(s).parent() != Some(parent) {
            return Err("选中项须在同一目录".to_string());
        }
    }

    // 目标 folder 路径：已存在则按 "name (n)" 递增（文件夹无扩展名分支）
    let mut target = parent.join(folder_name);
    if target.exists() {
        let mut n = 2;
        loop {
            let candidate = parent.join(format!("{} ({})", folder_name, n));
            if !candidate.exists() {
                target = candidate;
                break;
            }
            n += 1;
        }
    }
    let folder = target.to_string_lossy().to_string();

    // 先算好全部移动计划（含文件名校验），再动文件系统：避免中途出错留下半成品
    let mut plan: Vec<(String, String)> = Vec::with_capacity(items.len());
    for s in items {
        let src = Path::new(s);
        let name = src
            .file_name()
            .ok_or_else(|| "路径无文件名".to_string())?
            .to_string_lossy()
            .to_string();
        plan.push((
            src.to_string_lossy().to_string(),
            target.join(&name).to_string_lossy().to_string(),
        ));
    }

    fs::create_dir(&target).map_err(|e| e.to_string())?;

    // 逐项移入；folder 刚创建为空，子项不会同名冲突。任一失败则回滚 + 清掉空壳
    if let Err(e) = move_all(&plan) {
        let _ = fs::remove_dir(&target); // 回滚失败时目录非空会删不掉，忽略即可（不掩盖原始错误）
        return Err(e);
    }

    Ok((folder, plan))
}

/// 收入文件夹：新建文件夹并把选中项移入（可撤销，走 History 栈）。
/// 返回新建 folder 路径，供前端选中。
#[tauri::command(async)]
fn collect_into_folder(
    items: Vec<String>,
    folder_name: String,
    state: State<History>,
) -> Result<String, String> {
    let (folder, moved) = collect_into_folder_inner(&items, &folder_name)?;
    state.record(HistoryOp::CollectFolder {
        folder: folder.clone(),
        moved,
    });
    Ok(folder)
}

/// 文本预览结果：截断后的文本 + 是否被截断
#[derive(Serialize)]
struct TextPreview {
    text: String,
    truncated: bool,
}

/// 读取文本文件前 `max_bytes` 字节用于预览。超出则截断并标记 truncated。
/// 纯逻辑：可独立单元测试（不依赖 Tauri 运行时）。
fn read_text_preview_inner(path: &Path, max_bytes: u64) -> Result<TextPreview, String> {
    let meta = fs::metadata(path).map_err(|e| e.to_string())?;
    let len = meta.len();
    let cap = len.min(max_bytes);
    let mut file = fs::File::open(path).map_err(|e| e.to_string())?;
    let mut buf = vec![0u8; cap as usize];
    use std::io::Read;
    if cap > 0 {
        file.read_exact(&mut buf).map_err(|e| e.to_string())?;
    }
    // UTF-8 失败时降级为 lossy 解码，保证不丢字节、不报错给前端
    let text = String::from_utf8_lossy(&buf).into_owned();
    Ok(TextPreview {
        text,
        truncated: len > max_bytes,
    })
}

/// 读取文本文件前 1 MiB 用于预览面板。大文件只展示首段，避免内存爆涨。
#[tauri::command(async)]
async fn read_text_preview(path: String) -> Result<TextPreview, String> {
    read_text_preview_inner(Path::new(&path), 1 << 20)
}

fn sibling_path(parent_file: &str, new_file_name: &str) -> String {
    let p = PathBuf::from(parent_file);
    p.parent()
        .unwrap_or(Path::new("."))
        .join(new_file_name)
        .to_string_lossy()
        .to_string()
}

fn build_entry(path: &str, sep: char) -> Result<FileEntry, String> {
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
    let (base, tags) = parse_tags(&stem, sep);
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
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_drag::init())
        .manage(History::new())
        .manage(TagSettings::new())
        .invoke_handler(tauri::generate_handler![
            list_dir,
            list_subdirs,
            get_drives,
            get_default_dir,
            get_home_dir,
            add_tag,
            remove_tag,
            set_tag_separator,
            rename_file,
            delete_file,
            undo,
            redo,
            can_undo,
            can_redo,
            dissolve_folder,
            collect_into_folder,
            read_text_preview
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

#[cfg(test)]
mod tests {
    use super::*;

    /// 按真实解析语义构造 FileEntry：base 为不含扩展名的主名，name 由 base+tags+ext 拼出。
    fn entry(base: &str, ext: &str, tags: Vec<&str>) -> FileEntry {
        let mut name = base.to_string();
        for t in &tags {
            name.push('#');
            name.push_str(t);
        }
        if !ext.is_empty() {
            name.push('.');
            name.push_str(ext);
        }
        FileEntry {
            name,
            path: format!("C:/tmp/{base}"),
            is_dir: false,
            is_hidden: false,
            ext: ext.to_string(),
            base: base.to_string(),
            tags: tags.into_iter().map(|s| s.to_string()).collect(),
            size: 0,
            modified: 0,
        }
    }

    #[test]
    fn parse_tags_splits_stem() {
        let (base, tags) = parse_tags("报告#工作#重要", '#');
        assert_eq!(base, "报告");
        assert_eq!(tags, vec!["工作", "重要"]);
    }

    #[test]
    fn parse_tags_no_tag_keeps_full_stem() {
        let (base, tags) = parse_tags("README", '#');
        assert_eq!(base, "README");
        assert!(tags.is_empty());
    }

    #[test]
    fn parse_tags_filters_empty_segments() {
        let (base, tags) = parse_tags("文档##脏标签", '#'); // 连续 # 的空段被过滤
        assert_eq!(base, "文档");
        assert_eq!(tags, vec!["脏标签"]);
    }

    #[test]
    fn parse_tags_uses_custom_separator() {
        let (base, tags) = parse_tags("笔记@工作@重要", '@');
        assert_eq!(base, "笔记");
        assert_eq!(tags, vec!["工作", "重要"]);
    }

    #[test]
    fn sanitize_sep_takes_first_legal_char() {
        assert_eq!(sanitize_sep("  "), None);
        assert_eq!(sanitize_sep(""), None);
        // 跳过开首空白/非法字符，取首个合法字符
        assert_eq!(sanitize_sep(" /#"), Some('#'));
        // 全为非法字符时应返回 None
        assert_eq!(sanitize_sep("/:"), None);
        assert_eq!(sanitize_sep("@"), Some('@'));
        assert_eq!(sanitize_sep("  @"), Some('@'));
    }

    #[test]
    fn build_new_name_appends_tag_before_ext() {
        let e = entry("报告", "md", vec!["工作"]);
        assert_eq!(build_new_name(&e, "重要", '#'), "报告#工作#重要.md");
    }

    #[test]
    fn build_new_name_first_tag_no_ext() {
        let e = entry("笔记", "", vec![]);
        assert_eq!(build_new_name(&e, "读书", '#'), "笔记#读书");
    }

    #[test]
    fn build_new_name_uses_custom_separator() {
        let e = entry("笔记", "md", vec!["工作"]);
        assert_eq!(build_new_name(&e, "重要", '@'), "笔记@工作@重要.md");
    }

    #[test]
    fn strip_tag_removes_one_and_keeps_rest() {
        let e = entry("报告", "md", vec!["工作", "重要"]);
        assert_eq!(strip_tag(&e, "工作", '#'), Some("报告#重要.md".to_string()));
    }

    #[test]
    fn strip_tag_absent_returns_none() {
        let e = entry("报告", "md", vec!["工作"]);
        assert_eq!(strip_tag(&e, "不存在", '#'), None);
    }

    #[test]
    fn strip_tag_last_removes_hash_and_ext_kept() {
        let e = entry("报告", "md", vec!["工作"]);
        assert_eq!(strip_tag(&e, "工作", '#'), Some("报告.md".to_string()));
    }

    #[test]
    fn strip_tag_uses_custom_separator() {
        let e = entry("笔记", "md", vec!["工作", "重要"]);
        assert_eq!(strip_tag(&e, "工作", '@'), Some("笔记@重要.md".to_string()));
    }

    #[test]
    fn history_record_pushes_undo_and_clears_redo() {
        let h = History::new();
        h.record(rename_op("a.txt", "b#标签.txt"));
        assert!(h.can_undo());
        assert!(!h.can_redo());
        // 新操作到来时清空重做栈
        h.pop_undo();
        h.push_redo(rename_op("b#标签.txt", "a.txt"));
        assert!(h.can_redo());
        h.record(rename_op("c.txt", "d.txt"));
        assert!(!h.can_redo());
        assert!(h.can_undo());
    }

    #[test]
    fn history_undo_redo_roundtrip() {
        let h = History::new();
        h.record(rename_op("a.txt", "b.txt"));
        h.record(rename_op("b.txt", "c.txt"));

        let back = h.pop_undo().unwrap();
        let (f, t) = as_rename(&back).expect("Rename");
        assert_eq!(f, "b.txt");
        assert_eq!(t, "c.txt");
        h.push_redo(back);

        let first = h.pop_undo().unwrap();
        let (f, t) = as_rename(&first).expect("Rename");
        assert_eq!(f, "a.txt");
        assert_eq!(t, "b.txt");

        let forwards = h.pop_redo().unwrap();
        let (f, t) = as_rename(&forwards).expect("Rename");
        assert_eq!(f, "b.txt");
        assert_eq!(t, "c.txt");
    }

    #[test]
    fn history_empty_has_no_action() {
        let h = History::new();
        assert!(!h.can_undo());
        assert!(!h.can_redo());
        assert!(h.pop_undo().is_none());
        assert!(h.pop_redo().is_none());
    }

    #[test]
    fn read_text_preview_full_small_file() {
        let path = std::env::temp_dir().join("zeta_preview_small.txt");
        std::fs::write(&path, "hello preview").unwrap();
        let p = read_text_preview_inner(&path, 1024).unwrap();
        assert_eq!(p.text, "hello preview");
        assert!(!p.truncated);
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn read_text_preview_truncates_large_file() {
        let path = std::env::temp_dir().join("zeta_preview_large.txt");
        let content: Vec<u8> = (0..100).map(|i| b'a' + (i % 26) as u8).collect();
        std::fs::write(&path, &content).unwrap();
        let p = read_text_preview_inner(&path, 30).unwrap();
        assert_eq!(p.text.len(), 30);
        assert_eq!(p.text.as_bytes(), &content[..30]);
        assert!(p.truncated);
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn read_text_preview_empty_file() {
        let path = std::env::temp_dir().join("zeta_preview_empty.txt");
        std::fs::write(&path, "").unwrap();
        let p = read_text_preview_inner(&path, 1024).unwrap();
        assert_eq!(p.text, "");
        assert!(!p.truncated);
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn read_text_preview_missing_file_errors() {
        let path = std::env::temp_dir().join("zeta_nonexistent_subdir_xyz").join("file.txt");
        let r = read_text_preview_inner(&path, 1024);
        assert!(r.is_err());
    }

    #[test]
    fn dissolve_folder_moves_children_and_removes_shell() {
        let root = std::env::temp_dir().join("zeta_dissolve_basic");
        let _ = std::fs::remove_dir_all(&root);
        let folder = root.join("outer");
        std::fs::create_dir_all(&folder).unwrap();
        std::fs::write(folder.join("a.txt"), "a").unwrap();
        std::fs::write(folder.join("b.md"), "b").unwrap();

        let moved = dissolve_folder_inner(&folder).unwrap();
        assert_eq!(moved.len(), 2);
        // 子项已上移到 root
        assert!(root.join("a.txt").exists());
        assert!(root.join("b.md").exists());
        // 空壳删除
        assert!(!folder.exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn dissolve_folder_collision_appends_suffix() {
        let root = std::env::temp_dir().join("zeta_dissolve_collision");
        let _ = std::fs::remove_dir_all(&root);
        let folder = root.join("outer");
        std::fs::create_dir_all(&folder).unwrap();
        std::fs::write(folder.join("dup.txt"), "in_folder").unwrap();
        std::fs::write(root.join("dup.txt"), "in_parent").unwrap(); // 上级已有同名

        let moved = dissolve_folder_inner(&folder).unwrap();
        assert_eq!(moved.len(), 1);
        // 原上级文件保留，文件夹内同名项改名 " (2)"
        assert!(root.join("dup.txt").exists());
        assert!(root.join("dup (2).txt").exists());
        assert!(!folder.exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn dissolve_folder_rejects_non_dir() {
        let root = std::env::temp_dir().join("zeta_dissolve_notdir");
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let file = root.join("file.txt");
        std::fs::write(&file, "x").unwrap();
        let r = dissolve_folder_inner(&file);
        assert!(r.is_err());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn history_records_dissolve_as_single_op() {
        let h = History::new();
        h.record(HistoryOp::DissolveFolder {
            folder: "/tmp/outer".to_string(),
            moved: vec![
                ("/tmp/outer/a.txt".to_string(), "/tmp/a.txt".to_string()),
            ],
        });
        assert!(h.can_undo());
        assert!(!h.can_redo());
        let op = h.pop_undo().unwrap();
        assert!(matches!(op, HistoryOp::DissolveFolder { .. }));
    }

    #[test]
    fn collect_into_folder_moves_items_into_new_folder() {
        let root = std::env::temp_dir().join("zeta_collect_basic");
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let a = root.join("a.txt");
        let b = root.join("b.md");
        let sub = root.join("sub");
        std::fs::write(&a, "a").unwrap();
        std::fs::write(&b, "b").unwrap();
        std::fs::create_dir_all(&sub).unwrap();

        let items = vec![
            a.to_string_lossy().to_string(),
            b.to_string_lossy().to_string(),
            sub.to_string_lossy().to_string(),
        ];
        let (folder, moved) = collect_into_folder_inner(&items, "newfolder").unwrap();
        let folder_path = std::path::Path::new(&folder);
        // 新建 folder 存在
        assert!(folder_path.is_dir());
        // 三项已移入 folder
        assert!(folder_path.join("a.txt").exists());
        assert!(folder_path.join("b.md").exists());
        assert!(folder_path.join("sub").is_dir());
        // 原位消失
        assert!(!a.exists());
        assert!(!b.exists());
        assert!(!sub.exists());
        assert_eq!(moved.len(), 3);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn collect_into_folder_appends_suffix_on_name_collision() {
        let root = std::env::temp_dir().join("zeta_collect_collision");
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        // parent 已有同名 folder
        std::fs::create_dir_all(root.join("newfolder")).unwrap();
        std::fs::write(root.join("a.txt"), "a").unwrap();

        let items = vec![root.join("a.txt").to_string_lossy().to_string()];
        let (folder, moved) = collect_into_folder_inner(&items, "newfolder").unwrap();
        // 冲突加序号 → "newfolder (2)"
        assert_eq!(
            std::path::Path::new(&folder)
                .file_name()
                .unwrap()
                .to_string_lossy(),
            "newfolder (2)"
        );
        assert_eq!(moved.len(), 1);
        // 原有 folder 保留
        assert!(root.join("newfolder").is_dir());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn collect_into_folder_rejects_cross_dir_items() {
        let root = std::env::temp_dir().join("zeta_collect_crossdir");
        let _ = std::fs::remove_dir_all(&root);
        let dir_a = root.join("dir_a");
        let dir_b = root.join("dir_b");
        std::fs::create_dir_all(&dir_a).unwrap();
        std::fs::create_dir_all(&dir_b).unwrap();
        std::fs::write(dir_a.join("a.txt"), "a").unwrap();
        std::fs::write(dir_b.join("b.txt"), "b").unwrap();

        let items = vec![
            dir_a.join("a.txt").to_string_lossy().to_string(),
            dir_b.join("b.txt").to_string_lossy().to_string(),
        ];
        let r = collect_into_folder_inner(&items, "newfolder");
        assert!(r.is_err());
        // 失败时不产生副作用
        assert!(dir_a.join("a.txt").exists());
        assert!(dir_b.join("b.txt").exists());
        assert!(!dir_a.join("newfolder").exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn collect_into_folder_rejects_empty_items() {
        let r = collect_into_folder_inner(&[], "newfolder");
        assert!(r.is_err());
    }

    #[test]
    fn history_records_collect_as_single_op() {
        let h = History::new();
        h.record(HistoryOp::CollectFolder {
            folder: "/tmp/newfolder".to_string(),
            moved: vec![
                ("/tmp/a.txt".to_string(), "/tmp/newfolder/a.txt".to_string()),
            ],
        });
        assert!(h.can_undo());
        assert!(!h.can_redo());
        let op = h.pop_undo().unwrap();
        assert!(matches!(op, HistoryOp::CollectFolder { .. }));
    }

    fn rename_op(from: &str, to: &str) -> HistoryOp {
        HistoryOp::Rename {
            from: from.to_string(),
            to: to.to_string(),
        }
    }

    /// 解包 Rename 变体取 (from, to)；非 Rename 返回 None。
    fn as_rename(op: &HistoryOp) -> Option<(&str, &str)> {
        match op {
            HistoryOp::Rename { from, to } => Some((from, to)),
            _ => None,
        }
    }

    #[test]
    fn sanitize_tag_trims_and_strips_separator() {
        assert_eq!(sanitize_tag("工作", '#'), Some("工作".to_string()));
        assert_eq!(sanitize_tag("  工作  ", '#'), Some("工作".to_string()));
        // 手输 "a#b" 时分隔符被剔除，避免写出 a#b 这种被解析成两个标签的名字
        assert_eq!(sanitize_tag("a#b", '#'), Some("ab".to_string()));
        assert_eq!(sanitize_tag(" # ", '#'), None); // 只有空白与分隔符
    }

    #[test]
    fn sanitize_tag_rejects_empty_and_separator_only() {
        assert_eq!(sanitize_tag("", '#'), None);
        assert_eq!(sanitize_tag("   ", '#'), None);
        assert_eq!(sanitize_tag("###", '#'), None);
    }

    #[test]
    fn sanitize_tag_rejects_forbidden_chars() {
        for c in SEP_FORBIDDEN {
            let tag = format!("a{}b", c);
            assert_eq!(sanitize_tag(&tag, '#'), None, "应拒绝非法字符 {:?}", c);
            // 前后空白不能掩盖非法字符
            assert_eq!(sanitize_tag(&format!(" {} ", tag), '#'), None);
        }
    }

    #[test]
    fn sanitize_tag_uses_custom_separator() {
        assert_eq!(sanitize_tag("a@b", '@'), Some("ab".to_string()));
        // 非当前分隔符的字符应原样保留
        assert_eq!(sanitize_tag("a@b", '#'), Some("a@b".to_string()));
    }

    #[test]
    fn tag_already_present_detects_existing_tag() {
        let e = entry("报告", "md", vec!["工作", "重要"]);
        assert!(tag_already_present(&e, "工作"));
        assert!(!tag_already_present(&e, "新标签"));
        assert!(!tag_already_present(&e, "工")); // 部分匹配不算
    }

    #[test]
    fn apply_undo_rename_moves_back() {
        let root = std::env::temp_dir().join("zeta_apply_undo_rename");
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let from = root.join("a.txt");
        let to = root.join("a#标签.txt");
        std::fs::write(&from, "a").unwrap();
        std::fs::rename(&from, &to).unwrap();

        let op = rename_op(&from.to_string_lossy(), &to.to_string_lossy());
        apply_undo(&op).unwrap();
        assert!(from.exists());
        assert!(!to.exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn apply_undo_rename_fails_without_side_effect() {
        let root = std::env::temp_dir().join("zeta_apply_undo_rename_fail");
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let from = root.join("a.txt");
        let to = root.join("a#标签.txt");
        std::fs::write(&to, "已改名").unwrap();
        // 源路径被重新占位 → 撤销必须失败
        std::fs::write(&from, "占位").unwrap();

        let op = rename_op(&from.to_string_lossy(), &to.to_string_lossy());
        assert!(apply_undo(&op).is_err());
        // 失败不产生副作用：两边内容原样
        assert_eq!(std::fs::read_to_string(&from).unwrap(), "占位");
        assert_eq!(std::fs::read_to_string(&to).unwrap(), "已改名");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn apply_redo_rename_moves_forward() {
        let root = std::env::temp_dir().join("zeta_apply_redo_rename");
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let from = root.join("a.txt");
        let to = root.join("a#标签.txt");
        std::fs::write(&from, "a").unwrap();

        let op = rename_op(&from.to_string_lossy(), &to.to_string_lossy());
        apply_redo(&op).unwrap();
        assert!(to.exists());
        assert!(!from.exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn apply_redo_rename_fails_when_target_exists() {
        let root = std::env::temp_dir().join("zeta_apply_redo_rename_fail");
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let from = root.join("a.txt");
        let to = root.join("a#标签.txt");
        std::fs::write(&from, "原文件").unwrap();
        std::fs::write(&to, "占位").unwrap();

        let op = rename_op(&from.to_string_lossy(), &to.to_string_lossy());
        assert!(apply_redo(&op).is_err());
        // 失败不产生副作用
        assert_eq!(std::fs::read_to_string(&from).unwrap(), "原文件");
        assert_eq!(std::fs::read_to_string(&to).unwrap(), "占位");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn apply_undo_redo_roundtrip_dissolve_folder() {
        let root = std::env::temp_dir().join("zeta_apply_dissolve_roundtrip");
        let _ = std::fs::remove_dir_all(&root);
        let folder = root.join("outer");
        std::fs::create_dir_all(&folder).unwrap();
        std::fs::write(folder.join("a.txt"), "a").unwrap();

        let moved = dissolve_folder_inner(&folder).unwrap();
        let op = HistoryOp::DissolveFolder {
            folder: folder.to_string_lossy().to_string(),
            moved,
        };

        // 撤销：重建空壳 + 子项回到 folder
        apply_undo(&op).unwrap();
        assert!(folder.join("a.txt").exists());
        assert!(!root.join("a.txt").exists());

        // 重做：再次解散
        apply_redo(&op).unwrap();
        assert!(!folder.exists());
        assert!(root.join("a.txt").exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn apply_undo_redo_roundtrip_collect_folder() {
        let root = std::env::temp_dir().join("zeta_apply_collect_roundtrip");
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let a = root.join("a.txt");
        std::fs::write(&a, "a").unwrap();

        let (folder, moved) =
            collect_into_folder_inner(&[a.to_string_lossy().to_string()], "newfolder").unwrap();
        let op = HistoryOp::CollectFolder {
            folder: folder.clone(),
            moved,
        };
        assert!(!a.exists());

        // 撤销：子项回原位 + 删空壳
        apply_undo(&op).unwrap();
        assert!(a.exists());
        assert!(!Path::new(&folder).exists());

        // 重做：重建文件夹 + 重新移入
        apply_redo(&op).unwrap();
        assert!(Path::new(&folder).join("a.txt").exists());
        assert!(!a.exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    /// 命令层流程（pop → apply → 失败 push 回原栈）依赖的栈语义：
    /// 出栈后再放回，栈顶仍是同一条、顺序不乱。
    #[test]
    fn pop_then_push_restores_top_of_stack() {
        let h = History::new();
        assert!(h.pop_undo().is_none());

        h.record(rename_op("a.txt", "b.txt"));
        h.record(rename_op("b.txt", "c.txt"));

        let top = h.pop_undo().unwrap();
        let (f, t) = as_rename(&top).unwrap();
        assert_eq!((f, t), ("b.txt", "c.txt"));

        // 放回后仍是栈顶（失败不丢历史）
        h.push_undo(top);
        let again = h.pop_undo().unwrap();
        let (f, t) = as_rename(&again).unwrap();
        assert_eq!((f, t), ("b.txt", "c.txt"));

        // 下一条是更早的操作，顺序未被放回动作打乱
        let prev = h.pop_undo().unwrap();
        let (f, t) = as_rename(&prev).unwrap();
        assert_eq!((f, t), ("a.txt", "b.txt"));

        // redo 栈同构
        h.push_redo(again);
        assert!(h.can_redo());
        let back = h.pop_redo().unwrap();
        let (f, t) = as_rename(&back).unwrap();
        assert_eq!((f, t), ("b.txt", "c.txt"));
    }

    /// 命令层流程（pop → apply → 失败 push 回原栈）在 apply 失败时不得丢历史，也不得有副作用。
    #[test]
    fn failed_undo_keeps_history_entry() {
        let root = std::env::temp_dir().join("zeta_failed_undo_keeps_history");
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let from = root.join("a.txt");
        let to = root.join("a#标签.txt");
        std::fs::write(&from, "a").unwrap();
        std::fs::rename(&from, &to).unwrap();

        let h = History::new();
        h.record(rename_op(&from.to_string_lossy(), &to.to_string_lossy()));
        // 让撤销注定失败（源路径被重新占用）
        std::fs::write(&from, "占位").unwrap();

        let op = h.pop_undo().expect("有可撤销项");
        let err = apply_undo(&op).unwrap_err();
        assert!(err.contains("无法撤销"), "err={err}");
        h.push_undo(op); // 命令层的做法：失败放回栈顶

        assert!(h.can_undo());
        assert!(!h.can_redo());
        // 失败路径无副作用
        assert_eq!(std::fs::read_to_string(&from).unwrap(), "占位");
        assert!(to.exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    /// 回滚原语：按反序把已完成的移动退回原位。
    #[test]
    fn rollback_moves_restores_everything() {
        let root = std::env::temp_dir().join("zeta_rollback_restores");
        let _ = std::fs::remove_dir_all(&root);
        let sub = root.join("sub");
        std::fs::create_dir_all(&sub).unwrap();
        let a = root.join("a.txt");
        let b = root.join("b.txt");
        std::fs::write(&a, "a").unwrap();
        std::fs::write(&b, "b").unwrap();

        let a2 = sub.join("a.txt");
        let b2 = sub.join("b.txt");
        let done = vec![
            (a.to_string_lossy().to_string(), a2.to_string_lossy().to_string()),
            (b.to_string_lossy().to_string(), b2.to_string_lossy().to_string()),
        ];
        // 先真的移过去，再回滚
        for (from, to) in &done {
            std::fs::rename(from, to).unwrap();
        }
        let failed = rollback_moves(&done);
        assert!(failed.is_empty(), "回滚失败项：{failed:?}");
        assert!(a.exists() && b.exists());
        assert!(!a2.exists() && !b2.exists());
        assert_eq!(rollback_note(&[]), "已回滚，未产生改动");
        let _ = std::fs::remove_dir_all(&root);
    }

    /// move_all：中途失败要回滚已完成的移动，而不是留下半成品。
    #[test]
    fn move_all_rolls_back_on_failure() {
        let root = std::env::temp_dir().join("zeta_move_all_rollback");
        let _ = std::fs::remove_dir_all(&root);
        let dest = root.join("dest");
        std::fs::create_dir_all(&dest).unwrap();
        let a = root.join("a.txt");
        std::fs::write(&a, "a").unwrap();

        let plan = vec![
            (
                a.to_string_lossy().to_string(),
                dest.join("a.txt").to_string_lossy().to_string(),
            ),
            (
                // 不存在的源：第二个移动必然失败
                root.join("missing.txt").to_string_lossy().to_string(),
                dest.join("missing.txt").to_string_lossy().to_string(),
            ),
        ];
        let err = move_all(&plan).unwrap_err();
        assert!(err.contains("已回滚"), "err={err}");
        assert!(a.exists(), "第一个移动应已回滚");
        assert!(!dest.join("a.txt").exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    /// 收入文件夹：中途失败（选中项已被外部删除）要回滚并清掉新建的空壳。
    #[test]
    fn collect_into_folder_rolls_back_when_item_missing() {
        let root = std::env::temp_dir().join("zeta_collect_rollback");
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let a = root.join("a.txt");
        std::fs::write(&a, "a").unwrap();
        let missing = root.join("missing.txt"); // 同一目录但不存在

        let items = vec![
            a.to_string_lossy().to_string(),
            missing.to_string_lossy().to_string(),
        ];
        let err = collect_into_folder_inner(&items, "newfolder").unwrap_err();
        assert!(err.contains("已回滚"), "err={err}");
        // 已移动的项回到原位，新建的空壳被清掉，失败不产生残留
        assert!(a.exists());
        assert!(!root.join("newfolder").exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    /// 解散文件夹：删除空壳失败时也要回滚（用软链接让 remove_dir 必然失败）。
    /// Windows 建软链接需要特权，故仅在 Unix 上跑。
    #[cfg(unix)]
    #[test]
    fn dissolve_folder_rolls_back_when_shell_removal_fails() {
        use std::os::unix::fs::symlink;
        let root = std::env::temp_dir().join("zeta_dissolve_rollback");
        let _ = std::fs::remove_dir_all(&root);
        let real = root.join("real");
        std::fs::create_dir_all(&real).unwrap();
        std::fs::write(real.join("a.txt"), "a").unwrap();

        // 软链接当"文件夹"：子项能被移出，但 remove_dir(软链接) 必然失败
        let link = root.join("outer");
        symlink(&real, &link).unwrap();

        let err = dissolve_folder_inner(&link).unwrap_err();
        assert!(err.contains("已回滚"), "err={err}");
        // 子项回到原处，上级目录没有残留
        assert!(real.join("a.txt").exists());
        assert!(!root.join("a.txt").exists());
        // 软链接本身未被删除
        assert!(link.symlink_metadata().is_ok());
        let _ = std::fs::remove_dir_all(&root);
    }

    /// 计划内的目标名也要避让：磁盘上没有、但本批次已计划的目标不能被再次占用。
    #[test]
    fn target_taken_considers_planned_names() {
        let root = std::env::temp_dir().join("zeta_target_taken");
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();

        let planned_path = root.join("x (2).txt");
        let mut planned = HashSet::new();
        assert!(!target_taken(&planned_path, &planned)); // 磁盘上没有
        planned.insert(planned_path.to_string_lossy().to_string());
        assert!(target_taken(&planned_path, &planned)); // 但已被本批次占用

        // 磁盘上存在的也算被占用
        let on_disk = root.join("y.txt");
        std::fs::write(&on_disk, "y").unwrap();
        assert!(target_taken(&on_disk, &HashSet::new()));
        let _ = std::fs::remove_dir_all(&root);
    }

    /// UNC 判定要覆盖正反斜杠两种写法，否则网络路径会误走回收站删除。
    #[test]
    fn is_unc_accepts_both_separators() {
        assert!(is_unc("\\\\server\\share"));
        assert!(is_unc("//server/share"));
        assert!(is_unc("//server/share/sub/file.txt"));
        assert!(!is_unc("C:\\Users\\public"));
        assert!(!is_unc("/Users/public"));
        assert!(!is_unc("/"));
        assert!(!is_unc(""));
    }
}