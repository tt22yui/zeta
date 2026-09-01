export interface FileEntry {
  name: string;
  path: string;
  is_dir: boolean;
  is_hidden: boolean;
  ext: string;
  base: string;
  tags: string[];
  size: number;
  modified: number;
}

/** 分组展示用统计：目录 + 文件 + 各标签计数 */
export interface DirectoryStats {
  folders: number;
  files: number;
  /** tag 名称 -> 出现的文件数 */
  tags: Map<string, number>;
}

/** Rust 侧无法直接返回 Map，这里约定为 `[tag, count][]` 结构 */
export function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}