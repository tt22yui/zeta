use std::collections::HashSet;
use std::fs;
use std::path::Path;

use tauri::State;

use crate::fs_util::{move_all, rollback_moves, rollback_note, target_taken};
use crate::history::{History, HistoryOp};

/// 解散文件夹纯逻辑：把 folder 内直接子项移到其父目录，删除空壳。
/// 同名冲突按"保留双方+序号"处理（参照资源管理器）。
/// 返回所有移动记录 (原路径 folder/child, 新路径 parent/child) 供撤销使用。
/// 纯逻辑：可独立单元测试（不依赖 Tauri 运行时）。
pub(crate) fn dissolve_folder_inner(folder: &Path) -> Result<Vec<(String, String)>, String> {
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
pub(crate) fn dissolve_folder(path: String, state: State<History>) -> Result<(), String> {
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
pub(crate) fn collect_into_folder_inner(
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
pub(crate) fn collect_into_folder(
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

/// 内部拖放的「剪切」纯逻辑：把 items 移动到已存在的文件夹 dest。
/// 校验：目标必须是目录；不能把某项移到它自身或其子目录；不能移到它已在的目录；
/// 同名冲突按 "名字 (n)" 递增（参照资源管理器「保留双方」）。
/// 返回移动记录 (原路径, 新路径) 供撤销使用；任一移动失败会整体回滚。
/// 纯逻辑：可独立单元测试（不依赖 Tauri 运行时）。
pub(crate) fn move_into_folder_inner(
    items: &[String],
    dest: &str,
) -> Result<Vec<(String, String)>, String> {
    if items.is_empty() {
        return Err("未选中任何项".to_string());
    }
    let dest_path = Path::new(dest);
    if !dest_path.is_dir() {
        return Err("目标不是文件夹".to_string());
    }

    let mut planned: HashSet<String> = HashSet::new();
    let mut plan: Vec<(String, String)> = Vec::with_capacity(items.len());
    for s in items {
        let src = Path::new(s);
        let name = src
            .file_name()
            .ok_or_else(|| "路径无文件名".to_string())?
            .to_string_lossy()
            .to_string();
        if !src.exists() {
            return Err(format!("路径不存在：{}", s));
        }
        // 自身与其子目录都不能作为目标：否则会把目录移进自己内部，导致数据丢失
        if dest_path == src || dest_path.starts_with(src) {
            return Err(format!("不能把「{}」移动到它自身或其子目录中", name));
        }
        // 已在目标目录中则无需移动（比较时忽略结尾分隔符，避免 "C:\a\" 与 "C:\a" 误判）
        let same_dir = |a: &Path, b: &Path| {
            let trim = |p: &Path| p.to_string_lossy().trim_end_matches(['\\', '/']).to_string();
            trim(a) == trim(b)
        };
        if let Some(parent) = src.parent() {
            if same_dir(parent, dest_path) {
                return Err(format!("「{}」已在该文件夹中", name));
            }
        }
        let mut target = dest_path.join(&name);
        if target_taken(&target, &planned) {
            let stem = Path::new(&name)
                .file_stem()
                .map(|v| v.to_string_lossy().to_string())
                .unwrap_or_else(|| name.clone());
            let ext = Path::new(&name)
                .extension()
                .map(|v| format!(".{}", v.to_string_lossy()))
                .unwrap_or_default();
            let mut n = 2;
            loop {
                let candidate = dest_path.join(format!("{} ({}){}", stem, n, ext));
                if !target_taken(&candidate, &planned) {
                    target = candidate;
                    break;
                }
                n += 1;
            }
        }
        planned.insert(target.to_string_lossy().to_string());
        plan.push((s.clone(), target.to_string_lossy().to_string()));
    }

    move_all(&plan)?;
    Ok(plan)
}

/// 把选中项移动到目标文件夹（内部拖放的剪切，可撤销，走 History 栈）。
#[tauri::command(async)]
pub(crate) fn move_into_folder(
    items: Vec<String>,
    dest_dir: String,
    state: State<History>,
) -> Result<(), String> {
    let moved = move_into_folder_inner(&items, &dest_dir)?;
    state.record(HistoryOp::MoveInto { moved });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

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

    /// 内部拖放剪切：把文件与文件夹移动到已存在的目标文件夹。
    #[test]
    fn move_into_folder_moves_files_and_dirs() {
        let root = std::env::temp_dir().join("zeta_move_into_basic");
        let _ = std::fs::remove_dir_all(&root);
        let dest = root.join("dest");
        std::fs::create_dir_all(&dest).unwrap();
        let a = root.join("a.txt");
        let sub = root.join("sub");
        std::fs::write(&a, "a").unwrap();
        std::fs::create_dir_all(&sub).unwrap();
        std::fs::write(sub.join("inner.txt"), "x").unwrap();

        let items = vec![
            a.to_string_lossy().to_string(),
            sub.to_string_lossy().to_string(),
        ];
        let moved = move_into_folder_inner(&items, &dest.to_string_lossy()).unwrap();

        assert_eq!(moved.len(), 2);
        assert!(dest.join("a.txt").exists());
        assert!(dest.join("sub").join("inner.txt").exists());
        assert!(!a.exists() && !sub.exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    /// 目标已有同名项：按 "名字 (2).ext" 递增，双方都保留。
    #[test]
    fn move_into_folder_appends_suffix_on_collision() {
        let root = std::env::temp_dir().join("zeta_move_into_collision");
        let _ = std::fs::remove_dir_all(&root);
        let dest = root.join("dest");
        std::fs::create_dir_all(&dest).unwrap();
        std::fs::write(dest.join("dup.txt"), "in_dest").unwrap();
        let src = root.join("dup.txt");
        std::fs::write(&src, "at_root").unwrap();

        let items = vec![src.to_string_lossy().to_string()];
        let moved = move_into_folder_inner(&items, &dest.to_string_lossy()).unwrap();

        assert_eq!(moved.len(), 1);
        assert!(dest.join("dup.txt").exists()); // 原有文件保留
        assert!(dest.join("dup (2).txt").exists()); // 被移动的改名
        assert_eq!(std::fs::read_to_string(dest.join("dup.txt")).unwrap(), "in_dest");
        assert_eq!(std::fs::read_to_string(dest.join("dup (2).txt")).unwrap(), "at_root");
        let _ = std::fs::remove_dir_all(&root);
    }

    /// 中途失败（选中项已被外部删除）要整体回滚，不留半成品。
    #[test]
    fn move_into_folder_rolls_back_on_missing_item() {
        let root = std::env::temp_dir().join("zeta_move_into_rollback");
        let _ = std::fs::remove_dir_all(&root);
        let dest = root.join("dest");
        std::fs::create_dir_all(&dest).unwrap();
        let a = root.join("a.txt");
        std::fs::write(&a, "a").unwrap();

        let items = vec![
            a.to_string_lossy().to_string(),
            root.join("missing.txt").to_string_lossy().to_string(),
        ];
        let err = move_into_folder_inner(&items, &dest.to_string_lossy()).unwrap_err();
        assert!(err.contains("路径不存在"), "err={err}");
        // 预检在第一项之前完成，故第一个文件根本没被移动
        assert!(a.exists());
        assert!(!dest.join("a.txt").exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    /// 不能把文件夹移动到它自身或其子目录（否则会丢数据）。
    #[test]
    fn move_into_folder_rejects_self_and_descendant() {
        let root = std::env::temp_dir().join("zeta_move_into_self");
        let _ = std::fs::remove_dir_all(&root);
        let outer = root.join("outer");
        let inner = outer.join("inner");
        std::fs::create_dir_all(&inner).unwrap();

        let items = vec![outer.to_string_lossy().to_string()];
        // 移进自身
        let e1 = move_into_folder_inner(&items, &outer.to_string_lossy()).unwrap_err();
        assert!(e1.contains("自身或其子目录"), "err={e1}");
        // 移进自己的子目录
        let e2 = move_into_folder_inner(&items, &inner.to_string_lossy()).unwrap_err();
        assert!(e2.contains("自身或其子目录"), "err={e2}");
        // 均未产生副作用
        assert!(outer.exists() && inner.exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    /// 目标不是目录、或项已在目标目录中，都要报错且不移动。
    #[test]
    fn move_into_folder_rejects_non_dir_and_same_dir() {
        let root = std::env::temp_dir().join("zeta_move_into_rejects");
        let _ = std::fs::remove_dir_all(&root);
        let dest = root.join("dest");
        std::fs::create_dir_all(&dest).unwrap();
        let a = root.join("a.txt");
        std::fs::write(&a, "a").unwrap();

        // 目标不是目录
        let items = vec![a.to_string_lossy().to_string()];
        let e1 = move_into_folder_inner(&items, &a.to_string_lossy()).unwrap_err();
        assert!(e1.contains("目标不是文件夹"), "err={e1}");

        // 已在目标目录中（dest/a.txt 移到 dest）
        let in_dest = dest.join("b.txt");
        std::fs::write(&in_dest, "b").unwrap();
        let items2 = vec![in_dest.to_string_lossy().to_string()];
        let e2 = move_into_folder_inner(&items2, &dest.to_string_lossy()).unwrap_err();
        assert!(e2.contains("已在该文件夹中"), "err={e2}");
        assert!(in_dest.exists());

        // 空列表
        assert!(move_into_folder_inner(&[], &dest.to_string_lossy()).is_err());
        let _ = std::fs::remove_dir_all(&root);
    }
}
