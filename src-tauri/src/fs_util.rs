use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

use crate::model::FileEntry;
use crate::tags::parse_tags;
#[cfg(windows)]
use std::os::windows::fs::MetadataExt;

/// 判断是否为隐藏项（跨平台）。
/// - Windows：读取 FAT/NTFS 隐藏属性位。
/// - 其他平台（macOS/Linux）：以开头的点文件（如 .DS_Store、.hidden）视为隐藏。
pub(crate) fn is_hidden(meta: &fs::Metadata, name: &str) -> bool {
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
pub(crate) fn is_system_file(meta: &fs::Metadata, name: &str) -> bool {
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

/// 由路径构造一个 FileEntry（用于打标签前读取当前标签）。
pub(crate) fn build_entry(path: &str, sep: char) -> Result<FileEntry, String> {
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

/// 与 parent_file 同目录下的新路径（改名用）。
pub(crate) fn sibling_path(parent_file: &str, new_file_name: &str) -> String {
    let p = PathBuf::from(parent_file);
    p.parent()
        .unwrap_or(Path::new("."))
        .join(new_file_name)
        .to_string_lossy()
        .to_string()
}

/// 是否为 UNC（网络共享）路径。
/// `\\server\share` 与 `//server/share` 都算：用户可能从地址栏输入正斜杠形式，
/// 漏判会让回收站删除在网络路径上失败（甚至静默变成永久删除的预期落空）。
/// 纯逻辑：可独立单元测试。
pub(crate) fn is_unc(path: &str) -> bool {
    path.starts_with("\\\\") || path.starts_with("//")
}

/// 反序回滚已完成的移动（best-effort）。
/// 返回回滚失败的「原路径」列表，供调用方在错误信息里提示用户人工处理。
pub(crate) fn rollback_moves(done: &[(String, String)]) -> Vec<String> {
    let mut failed = Vec::new();
    for (from, to) in done.iter().rev() {
        if fs::rename(to, from).is_err() {
            failed.push(from.clone());
        }
    }
    failed
}

/// 把回滚结果并入错误信息：让用户明确知道「已恢复原状」还是「需要人工收拾」。
pub(crate) fn rollback_note(failed: &[String]) -> String {
    if failed.is_empty() {
        "已回滚，未产生改动".to_string()
    } else {
        format!("回滚失败，以下项需人工确认：{}", failed.join("、"))
    }
}

/// 按序执行一批移动；任一失败即回滚已完成的移动。
/// 目的：这些操作不可撤销地改动了用户文件，失败时必须回到操作前的状态，
/// 而不是留下「移动了一半」的目录（且因未记入历史而无法撤销）。
pub(crate) fn move_all(moves: &[(String, String)]) -> Result<(), String> {
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
pub(crate) fn target_taken(path: &Path, planned: &HashSet<String>) -> bool {
    path.exists() || planned.contains(&path.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

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
