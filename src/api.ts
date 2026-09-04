import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { openPath } from "@tauri-apps/plugin-opener";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import type { FileEntry } from "./types";

export function listDir(path: string): Promise<FileEntry[]> {
  return invoke<FileEntry[]>("list_dir", { path });
}

export function getDrives(): Promise<string[]> {
  return invoke<string[]>("get_drives");
}

/** 列出 path 下的子文件夹完整路径（地址栏面包屑下钻用） */
export function listSubdirs(path: string): Promise<string[]> {
  return invoke<string[]>("list_subdirs", { path });
}

/** 用户主目录，用于地址栏 `~` 展开 */
export function getHomeDir(): Promise<string> {
  return invoke<string>("get_home_dir");
}

export function getDefaultDir(): Promise<string> {
  return invoke<string>("get_default_dir");
}

export function addTag(path: string, tag: string): Promise<string> {
  return invoke<string>("add_tag", { path, tag });
}

export function removeTag(path: string, tag: string): Promise<string> {
  return invoke<string>("remove_tag", { path, tag });
}

/** 同步标签分隔符到后端内存态（持久化由前端 zeta.settings 负责） */
export function setTagSeparator(sep: string): Promise<void> {
  return invoke<void>("set_tag_separator", { sep });
}

export function renameFile(from: string, to: string): Promise<void> {
  return invoke<void>("rename_file", { from, to });
}

export function deleteFile(path: string): Promise<void> {
  return invoke<void>("delete_file", { path });
}

/** 解散文件夹：子项上移到上级，删除空壳（可撤销，走 History 栈） */
export function dissolveFolder(path: string): Promise<void> {
  return invoke<void>("dissolve_folder", { path });
}

/** 收入文件夹：新建文件夹并把选中项移入（可撤销，走 History 栈）。返回新建 folder 路径。 */
export function collectIntoFolder(items: string[], folderName: string): Promise<string> {
  return invoke<string>("collect_into_folder", { items, folderName });
}

export function undo(): Promise<void> {
  return invoke<void>("undo");
}

export function redo(): Promise<void> {
  return invoke<void>("redo");
}

export function canUndo(): Promise<boolean> {
  return invoke<boolean>("can_undo");
}

export function canRedo(): Promise<boolean> {
  return invoke<boolean>("can_redo");
}

/** 用系统默认应用打开文件/文件夹（tauri-plugin-opener） */
export function openInDefault(path: string): Promise<void> {
  return openPath(path);
}

/** 写入文本到系统剪贴板（tauri-plugin-clipboard-manager） */
export function copyText(s: string): Promise<void> {
  return writeText(s);
}

/** 把本地文件路径转成 webview 可直接加载的 asset URL（图片/视频/PDF 用） */
export function previewAssetUrl(path: string): string {
  return convertFileSrc(path);
}

/** 读取文本文件前 1 MiB 用于预览面板（大文件只展示首段） */
export function readTextPreview(
  path: string
): Promise<{ text: string; truncated: boolean }> {
  return invoke<{ text: string; truncated: boolean }>("read_text_preview", {
    path,
  });
}

