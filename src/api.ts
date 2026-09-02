import { invoke } from "@tauri-apps/api/core";
import { openPath } from "@tauri-apps/plugin-opener";
import type { FileEntry } from "./types";

export function listDir(path: string): Promise<FileEntry[]> {
  return invoke<FileEntry[]>("list_dir", { path });
}

export function getDrives(): Promise<string[]> {
  return invoke<string[]>("get_drives");
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

export function renameFile(from: string, to: string): Promise<void> {
  return invoke<void>("rename_file", { from, to });
}

export function deleteFile(path: string): Promise<void> {
  return invoke<void>("delete_file", { path });
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

