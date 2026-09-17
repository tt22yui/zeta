use std::fs;
use std::path::Path;

use tauri::State;

use crate::fs_util::{build_entry, is_unc, sibling_path};
use crate::history::{History, HistoryOp};
use crate::tags::{
    build_new_name, sanitize_sep, sanitize_tag, strip_tag, tag_already_present, TagSettings,
    SEP_FORBIDDEN,
};

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
pub(crate) fn add_tag(
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
pub(crate) fn rename_file(from: String, to: String, state: State<History>) -> Result<(), String> {
    if from == to {
        return Ok(());
    }
    do_rename(&state, &from, &to)?;
    Ok(())
}

/// 从文件名中移除指定标签。
#[tauri::command(async)]
pub(crate) fn remove_tag(
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
pub(crate) fn set_tag_separator(sep: String, tag_settings: State<TagSettings>) -> Result<(), String> {
    let c = sanitize_sep(&sep).ok_or("分隔符不能为空，且不能含 Windows 文件名禁止字符")?;
    *tag_settings.sep.lock().unwrap() = c;
    Ok(())
}

/// 删除文件/文件夹。
/// 本地路径移入系统回收站（可恢复，不计入撤销栈）；
/// UNC 网络共享不支持回收站，改为永久删除（`remove_file` / `remove_dir_all`）。
#[tauri::command(async)]
pub(crate) fn delete_file(path: String) -> Result<(), String> {
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
