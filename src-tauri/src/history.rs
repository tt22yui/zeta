use std::fs;
use std::path::Path;
use std::sync::Mutex;

use tauri::State;

use crate::fs_util::{move_all, rollback_moves, rollback_note};

/// 一次可撤销的操作。
/// Rename = 单次移动/改名；
/// DissolveFolder = 解散文件夹（多步移动 + 删空壳，整体撤销/重做）；
/// CollectFolder = 收入文件夹（新建文件夹 + 多步移入，整体撤销/重做，是 DissolveFolder 的反向）；
/// MoveInto = 内部拖放的「剪切」：把若干项移动到已存在的文件夹（撤销即逐项移回，不涉及删目录）。
#[derive(Clone)]
pub(crate) enum HistoryOp {
    Rename {
        from: String,
        to: String,
    },
    DissolveFolder {
        folder: String,
        moved: Vec<(String, String)>, // (原路径 folder/child, 新路径 parent/child)
    },
    CollectFolder {
        folder: String,
        moved: Vec<(String, String)>, // (原路径 parent/item, 新路径 folder/item)
    },
    MoveInto {
        moved: Vec<(String, String)>, // (原路径, 新路径)
    },
}

/// 撤销/重做栈。
pub(crate) struct History {
    undo: Mutex<Vec<HistoryOp>>,
    redo: Mutex<Vec<HistoryOp>>,
}

impl History {
    pub(crate) fn new() -> Self {
        Self {
            undo: Mutex::new(Vec::new()),
            redo: Mutex::new(Vec::new()),
        }
    }

    /// 记录一次操作：压入撤销栈，并清空重做栈（新操作使重做失效）。
    pub(crate) fn record(&self, op: HistoryOp) {
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

/// 应用一条撤销操作（纯逻辑，不依赖 Tauri 运行时，便于单测失败路径）。
/// 调用方须在本函数返回 Ok 后才出栈，否则校验失败会把条目从历史里吞掉。
pub(crate) fn apply_undo(op: &HistoryOp) -> Result<(), String> {
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
        HistoryOp::MoveInto { moved } => {
            // 撤销 = 逐项移回原处；先全量预检，避免移回一半才发现原位被占
            let plan: Vec<(String, String)> =
                moved.iter().map(|(f, t)| (t.clone(), f.clone())).collect();
            for (_, to) in &plan {
                if Path::new(to).exists() {
                    return Err(format!("无法撤销：目标已存在：{}", to));
                }
            }
            move_all(&plan)?;
        }
    }
    Ok(())
}

/// 应用一条重做操作（纯逻辑，不依赖 Tauri 运行时）。
pub(crate) fn apply_redo(op: &HistoryOp) -> Result<(), String> {
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
        HistoryOp::MoveInto { moved } => {
            // 重做 = 再移动到目标文件夹，同样先全量预检
            let plan: Vec<(String, String)> =
                moved.iter().map(|(f, t)| (f.clone(), t.clone())).collect();
            for (_, to) in &plan {
                if Path::new(to).exists() {
                    return Err(format!("无法重做：目标已存在：{}", to));
                }
            }
            move_all(&plan)?;
        }
    }
    Ok(())
}

/// 撤销上一步操作。
/// 先出栈再执行：失败时把条目压回撤销栈（保持可重试）。
/// 不用「peek + apply + pop」是因为它要加两次锁，并发撤销时可能把同一条目应用两次。
#[tauri::command(async)]
pub(crate) fn undo(state: State<History>) -> Result<(), String> {
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
pub(crate) fn redo(state: State<History>) -> Result<(), String> {
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
pub(crate) fn can_undo(state: State<History>) -> bool {
    state.can_undo()
}

#[tauri::command(async)]
pub(crate) fn can_redo(state: State<History>) -> bool {
    state.can_redo()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::folder_ops::{
        collect_into_folder_inner, dissolve_folder_inner, move_into_folder_inner,
    };

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

    /// 撤销/重做 MoveInto：往返后回到原位。
    #[test]
    fn apply_undo_redo_roundtrip_move_into() {
        let root = std::env::temp_dir().join("zeta_move_into_undo");
        let _ = std::fs::remove_dir_all(&root);
        let dest = root.join("dest");
        std::fs::create_dir_all(&dest).unwrap();
        let a = root.join("a.txt");
        std::fs::write(&a, "a").unwrap();

        let items = vec![a.to_string_lossy().to_string()];
        let moved = move_into_folder_inner(&items, &dest.to_string_lossy()).unwrap();
        let op = HistoryOp::MoveInto { moved };
        assert!(dest.join("a.txt").exists());

        apply_undo(&op).unwrap();
        assert!(a.exists(), "撤销后应回到原位");
        assert!(!dest.join("a.txt").exists());

        apply_redo(&op).unwrap();
        assert!(dest.join("a.txt").exists(), "重做后应再次移入");
        assert!(!a.exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    /// 撤销 MoveInto 时若原位已被占用，必须报错且不改动任何文件。
    #[test]
    fn apply_undo_move_into_fails_when_original_taken() {
        let root = std::env::temp_dir().join("zeta_move_into_undo_conflict");
        let _ = std::fs::remove_dir_all(&root);
        let dest = root.join("dest");
        std::fs::create_dir_all(&dest).unwrap();
        let a = root.join("a.txt");
        std::fs::write(&a, "a").unwrap();
        let moved =
            move_into_folder_inner(&[a.to_string_lossy().to_string()], &dest.to_string_lossy())
                .unwrap();
        // 原位被重新占用
        std::fs::write(&a, "占位").unwrap();

        let op = HistoryOp::MoveInto { moved };
        let err = apply_undo(&op).unwrap_err();
        assert!(err.contains("无法撤销"), "err={err}");
        assert_eq!(std::fs::read_to_string(&a).unwrap(), "占位");
        assert!(dest.join("a.txt").exists(), "失败时不应移动文件");
        let _ = std::fs::remove_dir_all(&root);
    }
}
