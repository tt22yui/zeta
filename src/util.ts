/**
 * 无副作用的纯逻辑工具集：从 App.tsx / PreviewPane.tsx 抽出，便于用 vitest 独立测试。
 * 这里刻意不引入 React 与 Tauri API，保证测试环境（node）可直接 import。
 */

/** 是否 macOS：影响路径分隔符与快捷键文案 */
export const isMac = typeof navigator !== "undefined" && /Mac|Macintosh/i.test(navigator.userAgent);

/* ------------------------------ 展示格式化 ------------------------------ */

/** 标签点颜色：按标签名哈希稳定取色 */
const TAG_COLORS = [
  "var(--tc-1)",
  "var(--tc-2)",
  "var(--tc-3)",
  "var(--tc-4)",
  "var(--tc-5)",
  "var(--tc-6)",
];
function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}
const TAG_COLOR_CACHE = new Map<string, string>();
export function tagColor(tag: string): string {
  // 结果缓存：列表每行每个 chip 每次渲染都会调用，避免重复哈希（标签名种类有限）
  const hit = TAG_COLOR_CACHE.get(tag);
  if (hit) return hit;
  const color = TAG_COLORS[hashStr(tag) % TAG_COLORS.length];
  if (TAG_COLOR_CACHE.size >= 512) TAG_COLOR_CACHE.clear(); // 防御无界增长
  TAG_COLOR_CACHE.set(tag, color);
  return color;
}

/** 常见扩展名 -> 类型名 + 主题色，用于统一的文件类型图标 */
const EXT_STYLE: Record<string, { label: string; color: string }> = {
  txt: { label: "TXT", color: "var(--tc-2)" },
  md: { label: "MD", color: "var(--tc-2)" },
  doc: { label: "DOC", color: "var(--tc-5)" },
  docx: { label: "DOC", color: "var(--tc-5)" },
  xls: { label: "XLS", color: "var(--tc-3)" },
  xlsx: { label: "XLS", color: "var(--tc-3)" },
  ppt: { label: "PPT", color: "var(--tc-4)" },
  pptx: { label: "PPT", color: "var(--tc-4)" },
  pdf: { label: "PDF", color: "var(--tc-6)" },
  jpg: { label: "IMG", color: "var(--tc-3)" },
  jpeg: { label: "IMG", color: "var(--tc-3)" },
  png: { label: "IMG", color: "var(--tc-3)" },
  gif: { label: "IMG", color: "var(--tc-3)" },
  svg: { label: "SVG", color: "var(--tc-3)" },
  mp4: { label: "VID", color: "var(--tc-2)" },
  mov: { label: "VID", color: "var(--tc-2)" },
  mp3: { label: "MUS", color: "var(--tc-5)" },
  wav: { label: "MUS", color: "var(--tc-5)" },
  zip: { label: "ZIP", color: "var(--tc-4)" },
  rar: { label: "ZIP", color: "var(--tc-4)" },
  exe: { label: "EXE", color: "var(--text-3)" },
  js: { label: "JS", color: "var(--tc-4)" },
  ts: { label: "TS", color: "var(--tc-2)" },
  json: { label: "{} ", color: "var(--tc-4)" },
};
/** 未知扩展名的图标样式缓存：渲染期不再为每个未知扩展名新建对象 */
const EXT_STYLE_FALLBACK = new Map<string, { label: string; color: string }>();
export function extStyle(ext: string): { label: string; color: string } {
  const key = ext.toLowerCase();
  const known = EXT_STYLE[key];
  if (known) return known;
  let fb = EXT_STYLE_FALLBACK.get(key);
  if (!fb) {
    fb = { label: ext.slice(0, 3).toUpperCase() || "FILE", color: "var(--text-3)" };
    if (EXT_STYLE_FALLBACK.size >= 512) EXT_STYLE_FALLBACK.clear();
    EXT_STYLE_FALLBACK.set(key, fb);
  }
  return fb;
}

export function formatSize(n: number): string {
  if (n <= 0) return "";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

export function formatDate(sec: number): string {
  if (!sec) return "";
  const d = new Date(sec * 1000);
  const p = (x: number) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(
    d.getHours()
  )}:${p(d.getMinutes())}`;
}

/* ------------------------------ 路径处理 ------------------------------ */

/**
 * 取上级目录；mac 参数决定分隔符与根目录规则（Windows `\` / macOS `/`）。
 * 拆出 mac 形参是为了让两个平台的分支都能被单测覆盖。
 */
export function parentOfFor(path: string, mac: boolean): string | null {
  const sep = mac ? "/" : "\\";
  const trimmed = path.endsWith(sep) && path.length > 1 ? path.slice(0, -1) : path;
  if (mac && trimmed === "/") return null; // 根目录没有上级
  if (!mac && trimmed.startsWith("\\\\")) {
    // UNC：\\server\share 是共享根，不可再上（\\server 仅为纯主机）；其下逐级返回上级
    if (/^\\\\[^\\]+\\[^\\]+$/.test(trimmed)) return null; // 已是 \\server\share
    const idx = trimmed.lastIndexOf("\\");
    if (idx < 0) return null;
    const parent = trimmed.slice(0, idx);
    return parent.length > 0 ? parent : null;
  }
  const idx = trimmed.lastIndexOf(sep);
  if (idx < 0) return null;
  const parent = trimmed.slice(0, idx);
  // macOS 上 /Users 这类一级目录的上级是根目录 "/"；
  // 此前这里直接 return null，导致 macOS 上一级目录无法回退到根目录（Windows 侧无此问题）
  if (!parent) return mac ? "/" : null;
  if (mac) return parent;
  return parent.length === 2 ? parent + "\\" : parent;
}

/** 当前平台的上级目录 */
export function parentOf(path: string): string | null {
  return parentOfFor(path, isMac);
}

/** 目录 + 相对路径拼接为系统风格绝对路径 */
export function joinPath(dir: string, rel: string): string {
  const sep = dir.includes("\\") ? "\\" : "/";
  return (dir.endsWith(sep) ? dir : dir + sep) + rel.replace(/[\\/]/g, sep);
}

/** 取路径所在目录（兼容 Windows \ 与 macOS / 分隔符） */
export function dirnameOf(p: string): string {
  const i = Math.max(p.lastIndexOf("\\"), p.lastIndexOf("/"));
  return i > 0 ? p.slice(0, i) : ".";
}

/* ------------------------------ 文本与 DOM ------------------------------ */

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** 焦点是否在可编辑控件上：全局快捷键必须让位给输入框/文本域 */
export function isEditableTarget(t: HTMLElement): boolean {
  return !!t.closest("input, textarea, select, [contenteditable='true']");
}

/** 焦点是否在自带按键语义的控件上：空格/回车要交给它们，不能被全局快捷键抢走 */
export function isInteractiveTarget(t: HTMLElement): boolean {
  return !!t.closest("button, a, [role='button'], [role='menuitem']");
}

/**
 * 内部拖拽用的私有 MIME：用来区分「应用内拖动」与外部拖入的数据。
 * 注意 dragover/dragenter 阶段浏览器出于安全不允许读 getData()，只能看 types，
 * 因此判定"是不是内部拖拽"必须用 hasInternalDrag（看 types），数据只在 drop 时读。
 */
export const DND_MIME = "application/x-zeta-items";

/** 把路径写入拖拽数据（应用内移动用） */
export function writeInternalDrag(dt: DataTransfer, paths: string[]): void {
  dt.setData(DND_MIME, JSON.stringify(paths));
  dt.setData("text/plain", paths.join("\n")); // 兜底：其它页面/应用可读纯文本
  dt.effectAllowed = "move"; // 内部语义是"移动"，光标随之显示移动样式
}

/** 是否为应用内拖拽（只看 types，dragover 阶段可用） */
export function hasInternalDrag(dt: DataTransfer | null): boolean {
  if (!dt) return false;
  return Array.from(dt.types).includes(DND_MIME);
}

/** 读取应用内拖拽的路径列表（只能在 drop 阶段调用）；非应用内拖拽或数据损坏返回 null */
export function readInternalDrag(dt: DataTransfer | null): string[] | null {
  if (!dt) return null;
  const raw = dt.getData(DND_MIME);
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length === 0) return null;
    return parsed.every((p) => typeof p === "string" && p.length > 0) ? (parsed as string[]) : null;
  } catch {
    return null;
  }
}

/* ------------------------------ 异步 ------------------------------ */

/** 轮询超时哨兵：网络路径读取在时限内未返回时由 withTimeout 返回 */
export const TIMEOUT = Symbol("poll-timeout");

/**
 * 竞速包装：ms 内未返回视为「超时」（TIMEOUT）；调用方自身失败返回 null，二者语义必须区分。
 * 用全局 setTimeout（Webview 里与 window.setTimeout 等价）而非 window.*，便于在 node 测试环境直接跑。
 */
export function withTimeout<T>(p: Promise<T | null>, ms: number): Promise<T | null | typeof TIMEOUT> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(TIMEOUT), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      () => {
        // 失败（而非超时）交回 null，避免把「路径不可达/无权限」误报成「网络响应超时」
        clearTimeout(t);
        resolve(null);
      }
    );
  });
}
