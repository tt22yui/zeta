import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getVersion } from "@tauri-apps/api/app";
import { watchImmediate } from "@tauri-apps/plugin-fs";
import {
  addTag,
  collectIntoFolder,
  copyText,
  dissolveFolder,
  getDefaultDir,
  getDrives,
  getHomeDir,
  listDir,
  listSubdirs,
  openInDefault,
  removeTag,
  renameFile,
  setTagSeparator,
} from "./api";
import type { FileEntry } from "./types";
import {
  IconArrowLeft,
  IconArrowRight,
  IconArrowUp,
  IconClose,
  IconCopy,
  IconFolder,
  IconMaximize,
  IconOpenExternal,
  IconMinus,
  IconRedo,
  IconRestore,
  IconSearch,
  IconSettings,
  IconSortArrow,
  IconTag,
} from "./icons";
import PreviewPane from "./PreviewPane";
import { ConfirmDialog, PromptDialog } from "./Dialog";
import { SettingsDialog } from "./SettingsDialog";
import {
  applyTheme,
  loadSettings,
  saveSettings,
  watchSystemTheme,
} from "./settings";
import type { Settings } from "./settings";

const win = getCurrentWindow();
const isMac = typeof navigator !== "undefined" && /Mac|Macintosh/i.test(navigator.userAgent);

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
export function tagColor(tag: string): string {
  return TAG_COLORS[hashStr(tag) % TAG_COLORS.length];
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
function extStyle(ext: string) {
  const s = EXT_STYLE[ext.toLowerCase()];
  return s ?? { label: (ext.slice(0, 3).toUpperCase() || "FILE"), color: "var(--text-3)" };
}

function formatSize(n: number): string {
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

function formatDate(sec: number): string {
  if (!sec) return "";
  const d = new Date(sec * 1000);
  const p = (x: number) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(
    d.getHours()
  )}:${p(d.getMinutes())}`;
}

export default function App() {
  const [path, setPath] = useState("");
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [drives, setDrives] = useState<string[]>([]);
  const [addrEdit, setAddrEdit] = useState(false);
  const [addrValue, setAddrValue] = useState("");
  const [hist, setHist] = useState<string[]>([]);
  const [histIdx, setHistIdx] = useState(-1);
  // 地址栏历史：已成功进入过的目录（去重、最近优先、持久化）
  const [addrHist, setAddrHist] = useState<string[]>(() => {
    try {
      return JSON.parse(localStorage.getItem("zeta.addrHist") ?? "[]");
    } catch {
      return [];
    }
  });
  const [histOpen, setHistOpen] = useState(false);
  // 面包屑子目录下拉：{path 对应层级, 定位坐标, 子文件夹列表}
  const [crumbMenu, setCrumbMenu] = useState<{
    path: string;
    left: number;
    top: number;
    items: string[];
  } | null>(null);
  // 历史下拉键盘焦点下标
  const [histFocus, setHistFocus] = useState(-1);
  const histPanelRef = useRef<HTMLDivElement | null>(null);
  const histItemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const crumbCloseTimer = useRef<number>();
  // 盘符下拉
  const [driveOpen, setDriveOpen] = useState(false);
  const driveWrapRef = useRef<HTMLDivElement | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  // Toast：短暂自动消失的轻提示（如路径失效回退）
  const [toast, setToast] = useState<{ id: number; msg: string } | null>(null);
  const toastTimer = useRef<number>();
  const toastIdRef = useRef(0);
  const toastRef = useRef<(msg: string) => void>(() => {});
  const showToast = useCallback((msg: string) => {
    const id = ++toastIdRef.current;
    setToast({ id, msg });
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => {
      setToast((cur) => (cur && cur.id === id ? null : cur));
    }, 3000);
  }, []);
  toastRef.current = showToast;
  // 集中式弹窗编排：null=不弹；kind="confirm" 确认框 / "prompt" 输入框（替代原生 confirm/prompt）
  const [dialog, setDialog] = useState<
    | { kind: "confirm"; title: string; message: string; danger?: boolean; confirmLabel?: string; action: () => void }
    | { kind: "prompt"; title: string; label: string; defaultValue?: string; action: (value: string) => void }
    | null
  >(null);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");
  const [tagInput, setTagInput] = useState("");
  const [isMax, setIsMax] = useState(false);
  // 排序：key 为字段（name/size/modified），desc 为升序/降序
  const [sortKey, setSortKey] = useState<"name" | "size" | "modified">("name");
  const [sortDesc, setSortDesc] = useState(false);
  // 自定义右键菜单：{x,y} 弹出坐标，paths 为操作目标，single 为右键命中的单行条目
  const [ctxMenu, setCtxMenu] = useState<{
    x: number;
    y: number;
    paths: string[];
    single: FileEntry | null;
  } | null>(null);
  // 空格预览面板：当前预览的文件路径；null 表示面板关闭
  const [previewPath, setPreviewPath] = useState<string | null>(null);
  // 设置：单键 JSON（zeta.settings）持久化，集中管理
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const [settingsOpen, setSettingsOpen] = useState(false);

  // 键盘导航：光标行下标（列表内 roving tabindex）+ 行 DOM 引用
  const [cursor, setCursor] = useState(-1);
  const rowRefs = useRef<(HTMLDivElement | null)[]>([]);
  // Shift 范围多选的锚点行下标
  const anchor = useRef(-1);
  // 记录「从哪个父目录进入了哪个子目录」，返回上级时据此恢复光标停留
  const lastEnterRef = useRef<{ parent: string; childPath: string } | null>(null);
  // 待聚焦的子目录项，列表加载到位后将其设为光标与选中（用于返回上级后恢复）
  const [pendingFocus, setPendingFocus] = useState<string | null>(null);
  // 列表滚动容器（用于 PageUp/PageDown 翻页步长）
  const bodyRef = useRef<HTMLDivElement | null>(null);
  // 类型定位（打字跳转）缓冲
  const typeBuf = useRef("");
  const typeTimer = useRef<number>();
  // 行内重命名
  const [renamingIdx, setRenamingIdx] = useState<number | null>(null);
  const [renameVal, setRenameVal] = useState("");
  const renameRef = useRef<HTMLInputElement | null>(null);
  // 运行时版本号（标题栏用）
  const [appVersion, setAppVersion] = useState("");
  const addrRef = useRef<HTMLInputElement | null>(null);
  // 打标签输入框（清空按钮后需恢复焦点）
  const tagInputRef = useRef<HTMLInputElement | null>(null);
  // 地址栏容器（用于点击外部关闭历史下拉）
  const addrWrapRef = useRef<HTMLDivElement | null>(null);
  // 长路径自适应省略：面包屑栏实际渲染容器
  const crumbbarRef = useRef<HTMLDivElement | null>(null);
  // 保存最后一栏到最右端的面包屑段数（0 表示全部展示，>0 表示超出省略中间）
  const [keepTail, setKeepTail] = useState(-1);
  const lastPathRef = useRef<string>("");
  const renameCommitted = useRef(false);
  // 记录本应用发起的文件操作时间点：随后较短窗口内的 watch 自动刷新会被跳过，
  // 避免“操作后显式 reload + watch 防抖 reload”造成的重复加载闪烁。
  const selfOpAt = useRef(0);

  useEffect(() => () => window.clearTimeout(typeTimer.current), []);

  // 窗口以 visible:false 启动，React 首帧提交后立即显示，避免白屏/跳动。
  // 注意不能用 requestAnimationFrame：隐藏窗口时 rAF 被暂停，show 不会触发
  // （后端另有 5 秒 fail-safe 兜底，见 lib.rs setup）。
  useEffect(() => {
    void win.show();
  }, []);

  // 读取运行时版本号，展示在标题栏品牌标识右侧
  useEffect(() => {
    getVersion()
      .then(setAppVersion)
      .catch(() => {});
  }, []);

  // 进入行内重命名时聚焦并全选
  useEffect(() => {
    if (renamingIdx != null) {
      renameRef.current?.focus();
      renameRef.current?.select();
    }
  }, [renamingIdx]);

  // 窗口最大化状态监听（用于切换 ”最大化/还原“ 图标）
  useEffect(() => {
    let mounted = true;
    win
      .isMaximized()
      .then((m) => mounted && setIsMax(m))
      .catch(() => {});
    const unlisten = win.onResized(() => {
      win.isMaximized().then((m) => mounted && setIsMax(m)).catch(() => {});
    });
    return () => {
      mounted = false;
      unlisten.then((f) => f && f()).catch(() => {});
    };
  }, []);

  /**
   * 加载目录。返回最终成功进入的 { path, list }；彻底失败（回退链全不可用）返回 null。
   * 路径不存在时自动回退：先父目录，再默认目录（静默递归，避免层层闪烁）。
   * silent：后台静默刷新（轮询/自动刷新/F5），不切换 loading 态。
   * noErrorUi：不主动设置错误提示，交由调用方（轮询超时限噪）处理。
   */
  const loadDir = useCallback(
    async (
      dir: string,
      opts: { silent?: boolean; noErrorUi?: boolean } = {}
    ): Promise<{ path: string; list: FileEntry[] } | null> => {
      const { silent = false, noErrorUi = false } = opts;
      if (!silent) setLoading(true);
      if (!noErrorUi) setError("");
      try {
        const list = await listDir(dir);
        setEntries(list);
        setPath(dir);
        setSelected(new Set());
        setCursor(-1);
        // 记住最后访问的路径，下次启动恢复
        try {
          window.localStorage.setItem("zeta.lastPath", dir);
        } catch {
          /* 存储不可用时忽略 */
        }
        return { path: dir, list };
      } catch (e) {
        if (!noErrorUi) setError(String(e));
        // 路径失效回退：父目录可用则进入父目录，否则退回默认目录
        const parent = parentOf(dir);
        if (parent && parent !== dir) {
          const r = await loadDir(parent, { silent: true, noErrorUi });
          if (r) {
            toastRef.current(`路径不存在，已回退到 ${parent}`);
            return r;
          }
        }
        try {
          const def = await getDefaultDir();
          if (def && def !== dir) {
            const r = await loadDir(def, { silent: true, noErrorUi });
            if (r) {
              toastRef.current("路径不存在，已回退到默认目录");
              return r;
            }
          }
        } catch {
          /* 默认目录不可得时忽略 */
        }
        return null;
      } finally {
        if (!silent) setLoading(false);
      }
    },
    []
  );

  // 记录访问历史：path 变化时置顶去重，最多保留 settings.addrHistLimit 条，持久化到 localStorage
  useEffect(() => {
    if (!path) return;
    setAddrHist((prev) => {
      const next = [path, ...prev.filter((p) => p !== path)].slice(0, settings.addrHistLimit);
      try {
        localStorage.setItem("zeta.addrHist", JSON.stringify(next));
      } catch {
        /* 忽略 */
      }
      return next;
    });
  }, [path, settings.addrHistLimit]);

  useEffect(() => {
    // 启动早期后端/IPC 可能尚未就绪，get_drives 一次失败就永久为空会让
    // 盘符下拉不可用；这里失败自动重试，直到拿到盘符或达到上限
    let stop = false;
    const loadDrives = async () => {
      for (let i = 0; i < 6; i++) {
        try {
          const d = await getDrives();
          if (!stop) setDrives(d);
          if (d.length > 0) return;
        } catch {
          /* 后端未就绪，稍后重试 */
        }
        await new Promise((r) => setTimeout(r, 500));
      }
    };
    void loadDrives();
    // 优先恢复上次访问的路径（受设置开关控制），否则回到默认目录
    let remembered: string | null = null;
    if (settings.restoreLastPath) {
      try {
        remembered = window.localStorage.getItem("zeta.lastPath");
      } catch {
        /* 存储不可用时忽略 */
      }
    }
    const start = (dir: string) => {
      void loadDir(dir).then((r) => {
        // 以实际停留路径入栈（失效回退时记录回退后的目录）
        setHist(r ? [r.path] : []);
        setHistIdx(r ? 0 : -1);
      });
    };
    if (remembered) {
      start(remembered);
    } else {
      getDefaultDir().then(start);
    }
  }, [loadDir, settings.restoreLastPath]);

  // 主题落地 + system 模式跟随系统深浅色变化
  useEffect(() => {
    applyTheme(settings.theme);
    const unsub = watchSystemTheme(() => {
      if (settings.theme === "system") applyTheme("system");
    });
    return unsub;
  }, [settings.theme]);

  // 启动与变更时把标签分隔符同步到后端内存态（持久化由 zeta.settings 负责）
  useEffect(() => {
    void setTagSeparator(settings.tagSeparator).catch(() => {});
  }, [settings.tagSeparator]);

  const updateSettings = useCallback((patch: Partial<Settings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      saveSettings(next);
      return next;
    });
  }, []);

  const navigate = useCallback(
    async (dir: string) => {
      setSearch("");
      // 先加载，成功后按「实际停留路径」入栈（失效回退时记录父目录，避免历史残留失效路径）
      const result = await loadDir(dir);
      if (!result) return;
      const next = hist.slice(0, histIdx + 1);
      next.push(result.path);
      setHist(next);
      setHistIdx(next.length - 1);
      // 若这次是「回到最近一次进入过的父目录」，返回上级后把光标恢复在该子目录上
      const enter = lastEnterRef.current;
      if (enter && result.path === enter.parent) {
        setPendingFocus(enter.childPath);
        lastEnterRef.current = null;
      }
    },
    [hist, histIdx, loadDir]
  );

  const goBack = useCallback(async () => {
    if (histIdx <= 0) return;
    const idx = histIdx - 1;
    setSearch("");
    const result = await loadDir(hist[idx]);
    if (!result) return; // 该历史项及其回退均失效：停留在当前视图
    if (result.path !== hist[idx]) {
      setHist((prev) => prev.map((p, i) => (i === idx ? result.path : p)));
    }
    setHistIdx(idx);
  }, [hist, histIdx, loadDir]);

  const goForward = useCallback(async () => {
    if (histIdx >= hist.length - 1) return;
    const idx = histIdx + 1;
    setSearch("");
    const result = await loadDir(hist[idx]);
    if (!result) return;
    if (result.path !== hist[idx]) {
      setHist((prev) => prev.map((p, i) => (i === idx ? result.path : p)));
    }
    setHistIdx(idx);
  }, [hist, histIdx, loadDir]);

  const goUp = useCallback(async () => {
    const parent = parentOf(path);
    if (parent && parent !== path) await navigate(parent);
  }, [path, navigate]);

  /** 地址栏进入编辑态：回填当前路径并聚焦 */
  const beginAddrEdit = useCallback(() => {
    setAddrValue(path);
    setAddrEdit(true);
  }, [path]);

  /** 地址栏提交：空则取消；支持 `~` 展开主目录与 UNC/SMB；否则跳转到输入路径 */
  const commitAddr = useCallback(() => {
    const raw = addrValue.trim();
    setAddrEdit(false);
    if (!raw || raw === path) return;
    // `~` 或 `~\...`：展开为用户主目录（按平台分隔符）
    const hp = isMac ? "~/" : "~\\";
    if (raw === "~" || raw.startsWith(hp)) {
      void (async () => {
        try {
          const home = (await getHomeDir()).trim().replace(/[\\/]+$/, "");
          if (!home) return;
          void navigate(raw === "~" ? home : home + raw.slice(1));
        } catch {
          /* 主目录不可得时忽略 */
        }
      })();
      return;
    }
    void navigate(raw);
  }, [addrValue, navigate, path]);

  /** 地址栏取消编辑 */
  const cancelAddr = useCallback(() => {
    setAddrEdit(false);
  }, []);

  /** 面包屑下钻：悬停某段时异步拉取该层级的子文件夹并定位下拉 */
  const openCrumbMenu = useCallback(
    async (dir: string, el: HTMLElement) => {
      window.clearTimeout(crumbCloseTimer.current);
      const r = el.getBoundingClientRect();
      const left = Math.max(4, Math.min(r.left, window.innerWidth - 224));
      let items: string[] = [];
      try {
        items = await listSubdirs(dir);
      } catch {
        items = [];
      }
      setCrumbMenu({ path: dir, left, top: r.bottom + 4, items });
    },
    []
  );

  const closeCrumbMenuSoon = useCallback(() => {
    window.clearTimeout(crumbCloseTimer.current);
    crumbCloseTimer.current = window.setTimeout(() => setCrumbMenu(null), 160);
  }, []);

  const keepCrumbMenu = useCallback(() => {
    window.clearTimeout(crumbCloseTimer.current);
  }, []);

  // 历史下拉键盘导航：↑↓/Home/End 移动、Enter 跳转、Delete 删除、Esc 关闭
  const histKeyNav = useCallback(
    (ev: ReactKeyboardEvent) => {
      const n = addrHist.length;
      if (n === 0) return;
      const k = ev.key;
      if (
        ["ArrowDown", "ArrowUp", "Home", "End", "Enter", "Delete", "Backspace", "Escape"].includes(k)
      ) {
        ev.preventDefault();
        ev.stopPropagation();
      }
      const focus = (i: number) => {
        setHistFocus(i);
        histItemRefs.current[i]?.focus({ preventScroll: true });
      };
      switch (k) {
        case "ArrowDown":
          focus((histFocus + 1 + n) % n);
          break;
        case "ArrowUp":
          focus((histFocus - 1 + n) % n);
          break;
        case "Home":
          focus(0);
          break;
        case "End":
          focus(n - 1);
          break;
        case "Enter": {
          const p = addrHist[histFocus];
          if (p) {
            setHistOpen(false);
            if (p !== path) void navigate(p);
          }
          break;
        }
        case "Delete":
        case "Backspace": {
          const p = addrHist[histFocus];
          if (p) {
            setAddrHist((prev) => {
              const next = prev.filter((x) => x !== p);
              try {
                localStorage.setItem("zeta.addrHist", JSON.stringify(next));
              } catch {
                /* 忽略 */
              }
              return next;
            });
            focus(Math.max(0, histFocus - 1));
          }
          break;
        }
        case "Escape":
          setHistOpen(false);
          break;
      }
    },
    [addrHist, histFocus, path, navigate]
  );

  // 历史下拉打开时把焦点交给面板，方便纯键盘遍历；关闭时复位
  useEffect(() => {
    if (histOpen) {
      setHistFocus(-1);
      histPanelRef.current?.focus({ preventScroll: true });
    }
  }, [histOpen]);

  // 点击面包屑下拉外部或 Esc 时关闭
  useEffect(() => {
    if (!crumbMenu) return;
    const onDoc = (e: MouseEvent) => {
      if (!addrWrapRef.current?.contains(e.target as Node)) setCrumbMenu(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setCrumbMenu(null);
    };
    window.setTimeout(() => window.addEventListener("click", onDoc), 0);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("click", onDoc);
      window.removeEventListener("keydown", onKey);
    };
  }, [crumbMenu]);

  // 点击盘符下拉外部或 Esc 时关闭
  useEffect(() => {
    if (!driveOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (!driveWrapRef.current?.contains(e.target as Node)) setDriveOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setDriveOpen(false);
    };
    window.setTimeout(() => window.addEventListener("click", onDoc), 0);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("click", onDoc);
      window.removeEventListener("keydown", onKey);
    };
  }, [driveOpen]);

  const tagCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const e of entries) for (const t of e.tags) m.set(t, (m.get(t) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [entries]);

  const visibleEntries = useMemo(() => {
    let list = entries;
    const q = search.trim().toLowerCase();
    if (q) list = list.filter((e) => e.name.toLowerCase().includes(q));

    const sorted = [...list].sort((a, b) => {
      // 目录始终排在文件前
      if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
      let r: number;
      if (sortKey === "name") {
        r = a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
      } else if (sortKey === "size") {
        r = a.size - b.size;
      } else {
        r = a.modified - b.modified;
      }
      return sortDesc ? -r : r;
    });
    return sorted;
  }, [entries, search, sortKey, sortDesc]);

  // 空格预览面板当前条目：从 visibleEntries 按 previewPath 派生，
  // 列表刷新后自动同步到新 entry 对象（路径不变）
  const previewEntry = useMemo(
    () => (previewPath ? visibleEntries.find((e) => e.path === previewPath) ?? null : null),
    [previewPath, visibleEntries]
  );

  const folders = entries.filter((e) => e.is_dir).length;
  const files = entries.length - folders;

  // 当前所在的盘符（UNC 路径时无盘符）
  const currentDrive = drives.find((d) => path.startsWith(d)) ?? null;

  /** 切换排序：点同字段反向，切字段时大小/时间默认降序、名称默认升序 */
  const applySort = useCallback(
    (k: "name" | "size" | "modified") => {
      setSortKey(k);
      if (sortKey === k) setSortDesc((d) => !d);
      else setSortDesc(k === "size" || k === "modified");
    },
    [sortKey]
  );

  const breadcrumbs = useMemo(() => {
    const crumbs: { label: string; path: string }[] = [];
    const sep = isMac ? "/" : "\\";
    const trimmed =
      path.endsWith(sep) && path.length > sep.length ? path.slice(0, -1) : path;
    if (!trimmed) {
      crumbs.push({ label: "/", path: "/" });
      return crumbs;
    }

    // Windows UNC 路径（\\server\share\…）：根是共享 \\server\share，再逐级展开
    if (!isMac && trimmed.startsWith("\\\\")) {
      const m = /^\\\\[^\\]+\\([^\\]+)/.exec(trimmed);
      if (m) {
        const rootEnd = m[0];
        const root = rootEnd.endsWith("\\") ? rootEnd.slice(0, -1) : rootEnd;
        crumbs.push({ label: root, path: root });
        const rest = trimmed.slice(root.length).split("\\").filter(Boolean);
        let acc = root;
        for (const p of rest) {
          acc = `${acc}\\${p}`;
          crumbs.push({ label: p, path: acc });
        }
        return crumbs;
      }
    }

    // macOS：根为 /，逐级以 / 拼接
    if (isMac) {
      crumbs.push({ label: "/", path: "/" });
      const parts = trimmed.split("/").filter(Boolean);
      let acc = "";
      for (const p of parts) {
        acc = `${acc}/${p}`;
        crumbs.push({ label: p, path: acc });
      }
      return crumbs;
    }

    // Windows 本地盘符路径（C:\…）
    const parts = trimmed.split("\\").filter(Boolean);
    let acc = "";
    parts.forEach((p, i) => {
      acc = i === 0 ? `${p}\\` : `${acc}${p}\\`;
      crumbs.push({ label: p, path: acc });
    });
    if (!crumbs.length && trimmed.length > 0) {
      const drive = trimmed.slice(0, 2);
      if (drive.endsWith(":")) crumbs.push({ label: drive, path: drive + "\\" });
    }
    return crumbs;
  }, [path]);

  // 长路径：面包屑自适应省略中间段。路径变化先全量展示，若溢出则逐步减少尾部保留段数，
  // 直到恰好放得下，保证「当前目录」始终可见且不横向滚动。
  useLayoutEffect(() => {
    const el = crumbbarRef.current;
    if (!el) return;
    const n = breadcrumbs.length;
    if (n <= 1) return;
    if (lastPathRef.current !== path) {
      lastPathRef.current = path;
      setKeepTail(-1); // 重新走全量测量
      return;
    }
    if (el.scrollWidth <= el.clientWidth) return; // 当前保留段数已放得下
    setKeepTail((k) => Math.max(1, (k < 0 ? n - 1 : k) - 1));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [breadcrumbs, path, keepTail]);

  // 长路径渲染：保留尾部文件夹（含当前目录），过长时从根/左侧省略直至放得下
  const crumbN = breadcrumbs.length;
  const crumbK = keepTail < 0 ? crumbN : Math.min(keepTail, crumbN);
  const crumbStart = Math.max(0, crumbN - crumbK);
  const crumbShow: ({ label: string; path: string } | null)[] = [];
  if (crumbN > 0) {
    if (crumbStart > 0) crumbShow.push(null); // 左侧省略：被裁掉的祖先段
    for (let i = crumbStart; i < crumbN; i++) crumbShow.push(breadcrumbs[i]);
  }

  const reload = useCallback(async (opts: { noErrorUi?: boolean } = {}) => {
    // 记住此刻的选中集，重载后用「仍存在」的路径恢复选中，
    // 避免打标签改名后外部 watch 触发的自动刷新把选中清空。
    const prevSelected = new Set(selected);
    // silent：后台刷新不触发 loading 闪烁（轮询/自动刷新/F5 复用）
    const result = await loadDir(path, { silent: true, noErrorUi: opts.noErrorUi });
    const list = result?.list ?? null;
    if (prevSelected.size && list) {
      const live = new Set(list.map((e) => e.path));
      const keep = [...prevSelected].filter((p) => live.has(p));
      if (keep.length) setSelected(new Set(keep));
    }
    return result;
  }, [path, loadDir, selected]);

  // 外部对当前目录的变动（增删改）自动刷新。
  // 本地路径用 watchImmediate（事件驱动）；UNC 网络共享不支持文件监听，
  // 降级为 3 秒定时轮询，避免外部改动无法反映到列表。
  useEffect(() => {
    if (!path) return;
    const isUnc = path.startsWith("\\\\");

    // UNC：定时轮询。网络不可达时单次读取可能长时间挂起，
    // 用 withTimeout 兜底超时；在途请求未返回则跳过本轮，避免并发堆积；
    // 连续超时才提示一次，网络恢复后自动复位并清除提示。
    if (isUnc) {
      const POLL_TIMEOUT_MS = 8000;
      let inFlight = false;
      let timeouts = 0;
      const timer = window.setInterval(() => {
        if (inFlight) return;
        inFlight = true;
        void withTimeout(reload({ noErrorUi: true }), POLL_TIMEOUT_MS).then((r) => {
          inFlight = false;
          if (r === TIMEOUT) {
            timeouts++;
            if (timeouts === 3) setError(`网络路径响应超时：${path}`);
            return;
          }
          const stuck = timeouts >= 3;
          timeouts = 0;
          if (r === null) setError(`无法访问网络路径：${path}`);
          else if (stuck) setError(""); // 超时恢复后清除提示
        });
      }, 3000);
      return () => window.clearInterval(timer);
    }

    // 本地：watchImmediate 事件驱动，防抖避免频繁重载闪烁
    let timer: number | undefined;
    // strictmode 双挂载时，已卸载实例上的异步 unlisten 也要释放，避免泄漏残留
    let alive = true;
    let unlisten: (() => void) | undefined;
    watchImmediate(path, () => {
      if (!alive) return;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        // 本应用操作（打标签/删除/重命名）后已显式 reload，
        // 由同一操作触发的 watch 事件在短窗口内跳过，避免重复加载闪烁。
        if (Date.now() - selfOpAt.current < 1500) return;
        void reload();
      }, 300);
    })
      .then((fn) => {
        if (!alive) fn();
        else unlisten = fn;
      })
      .catch((e) => setError(`自动刷新监听失败：${e}`)); // 便于排查授权/路径问题
    return () => {
      alive = false;
      window.clearTimeout(timer);
      unlisten?.();
    };
  }, [path, reload, setError]);

  // 地址栏进入编辑态时聚焦并全选
  useEffect(() => {
    if (addrEdit && addrRef.current) {
      addrRef.current.focus();
      addrRef.current.select();
    }
  }, [addrEdit]);

  // 点击地址栏历史下拉外部或 Esc 时关闭
  useEffect(() => {
    if (!histOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (!addrWrapRef.current?.contains(e.target as Node)) setHistOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setHistOpen(false);
    };
    window.setTimeout(() => window.addEventListener("click", onDoc), 0); // 延迟避免按钮同次点击立即关闭
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("click", onDoc);
      window.removeEventListener("keydown", onKey);
    };
  }, [histOpen]);

  // 点击菜单外部、滚动、Esc 时关闭右键菜单
  useEffect(() => {
    if (!ctxMenu) return;
    const close = () => setCtxMenu(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.setTimeout(() => window.addEventListener("click", close), 0); // 延迟避免同次右键立即关闭
    window.addEventListener("keydown", onKey);
    window.addEventListener("scroll", close, true);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", close, true);
    };
  }, [ctxMenu]);

  const applyTagToSelection = useCallback(async () => {
    selfOpAt.current = Date.now();
    const tag = tagInput.trim();
    if (!tag || selected.size === 0) {
      setError(selected.size === 0 ? "请先在列表中选择文件" : "标签不能为空");
      return;
    }
    setError("");
    try {
      // addTag 返回改名后的新路径，收集用于重载后恢复选中
      const newPaths: string[] = [];
      for (const p of selected) newPaths.push(await addTag(p, tag));
      await reload();
      if (newPaths.length) setSelected(new Set(newPaths));
    } catch (e) {
      setError(String(e));
    }
  }, [tagInput, selected, reload]);

  /** 侧栏标签点击：给所有选中项打该标签，已含该标签的项自动忽略 */
  const applyTagFromSidebar = useCallback(
    async (tag: string) => {
      if (selected.size === 0) return;
      selfOpAt.current = Date.now();
      setError("");
      const byPath = new Map<string, string[]>();
      for (const e of entries) byPath.set(e.path, e.tags);
      const targets = [...selected].filter((p) => !(byPath.get(p) ?? []).includes(tag));
      // 所有选中项已含该标签：无需改动，保留当前选中直接返回
      if (targets.length === 0) return;
      try {
        const newPaths: string[] = [];
        for (const p of targets) newPaths.push(await addTag(p, tag));
        await reload();
        // 重载会清空选中，用改名后的新路径恢复选中
        setSelected(new Set(newPaths));
      } catch (e) {
        setError(String(e));
      }
    },
    [selected, entries, reload]
  );

  const removeTagFrom = useCallback(
    async (entry: FileEntry, tag: string) => {
      selfOpAt.current = Date.now();
      try {
        await removeTag(entry.path, tag);
        await reload();
      } catch (e) {
        setError(String(e));
      }
    },
    [reload]
  );

  const closeCtxMenu = useCallback(() => setCtxMenu(null), []);

  // 打开右键菜单；行已被多选时作用于整个多选，否则作用于该单行
  const openCtxMenu = useCallback(
    (e: MouseEvent, entry: FileEntry, selectedKeys: Set<string>) => {
      e.preventDefault();
      const inMulti =
        selectedKeys.size > 1 && selectedKeys.has(entry.path)
          ? Array.from(selectedKeys)
          : [entry.path];
      setCtxMenu({ x: e.clientX, y: e.clientY, paths: inMulti, single: entry });
    },
    []
  );

  // 移除目标路径的「打标签」：清空其所有标签
  const clearAllTags = useCallback(
    async (paths: string[]) => {
      selfOpAt.current = Date.now();
      try {
        for (const p of paths) {
          const e = entries.find((x) => x.path === p);
          if (!e) continue;
          // 每移除一个标签就会改名一次，需用返回的新路径作为下一次的源路径，
          // 否则旧路径文件已不存在，会报「系统找不到指定的文件」。
          let cur = p;
          for (const t of e.tags) cur = await removeTag(cur, t);
        }
        await reload();
      } catch (err) {
        setError(String(err));
      }
    },
    [entries, reload]
  );

  const toggleSelect = useCallback((entry: FileEntry, additive: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (additive) {
        if (next.has(entry.path)) next.delete(entry.path);
        else next.add(entry.path);
      } else {
        if (next.size === 1 && next.has(entry.path)) return prev; // 已选中则保留
        next.clear();
        next.add(entry.path);
      }
      return next;
    });
  }, []);

  const openItem = useCallback(
    (entry: FileEntry) => {
      if (entry.is_dir) {
        lastEnterRef.current = { parent: path, childPath: entry.path };
        navigate(entry.path);
      } else openInDefault(entry.path).catch((e) => setError(String(e)));
    },
    [navigate, path]
  );

  // visibleEntries 变化时钳制光标落在有效范围内
  useEffect(() => {
    if (visibleEntries.length === 0) setCursor(-1);
    else if (cursor >= visibleEntries.length) setCursor(visibleEntries.length - 1);
  }, [visibleEntries.length, cursor]);

  const focusRow = useCallback((i: number) => {
    const el = rowRefs.current[i];
    if (el) {
      el.focus({ preventScroll: true });
      el.scrollIntoView({ block: "nearest" });
    }
  }, []);

  // 光标移动 = 替换为单选选中该行（与资源管理器一致），并更新范围锚点
  const selectOnly = useCallback(
    (i: number) => {
      const e = visibleEntries[i];
      if (!e) return;
      setSelected(new Set([e.path]));
      setCursor(i);
      anchor.current = i;
      focusRow(i);
    },
    [visibleEntries, focusRow]
  );

  // 返回上级后恢复光标：在加载完成的列表里定位最近进入的那个子目录
  useEffect(() => {
    if (!pendingFocus) return;
    const i = visibleEntries.findIndex((e) => e.path === pendingFocus);
    if (i < 0) return; // 列表还没加载到位，等下次 visibleEntries 变化再试
    selectOnly(i);
    setPendingFocus(null);
  }, [pendingFocus, visibleEntries, selectOnly]);

  // 选中 [a,b] 之间的连续行；merge 为 true 时并入现有选中（用于 Shift）
  const setRange = useCallback(
    (a: number, b: number, merge: boolean) => {
      const L = visibleEntries.length;
      if (L === 0) return;
      const lo = Math.max(0, Math.min(a, b));
      const hi = Math.min(L - 1, Math.max(a, b));
      const paths = visibleEntries.slice(lo, hi + 1).map((e) => e.path);
      setSelected((prev) => {
        const next: Set<string> = merge ? new Set(prev) : new Set();
        for (const p of paths) next.add(p);
        return next;
      });
      const cur = Math.max(0, Math.min(b, L - 1));
      setCursor(cur);
      focusRow(cur);
    },
    [visibleEntries, focusRow]
  );

  // PageUp/PageDown 翻页步长：按可见区域能容纳的行数
  const pageStep = useCallback(() => {
    const body = bodyRef.current;
    return body ? Math.max(1, Math.floor(body.clientHeight / 32) - 1) : 8;
  }, []);

  // 行内重命名：提交（Enter / 失焦）
  const commitRename = useCallback(async () => {
    if (renameCommitted.current) return;
    renameCommitted.current = true;
    selfOpAt.current = Date.now();
    const idx = renamingIdx;
    const entry = idx == null ? null : visibleEntries[idx];
    const v = renameVal.trim();
    setRenamingIdx(null);
    if (!entry || !v || v === entry.name) return;
    const newPath =
      entry.path.slice(0, entry.path.length - entry.name.length) + v;
    try {
      await renameFile(entry.path, newPath);
      await reload();
    } catch (e) {
      setError(String(e));
    }
  }, [renamingIdx, renameVal, visibleEntries, reload]);

  // 开始对光标行重命名（F2）
  const startRename = useCallback(() => {
    if (cursor < 0) return;
    renameCommitted.current = false;
    setRenameVal(visibleEntries[cursor].name);
    setRenamingIdx(cursor);
  }, [cursor, visibleEntries]);

  const handleRowKeyDown = useCallback(
    (ev: ReactKeyboardEvent) => {
      const L = visibleEntries.length;
      if (L === 0) return;
      const i = Math.max(0, Math.min(cursor, L - 1));
      const shift = ev.shiftKey;
      const ctrl = ev.ctrlKey || ev.metaKey;
      // 方向移动：支持 Shift 范围多选、Ctrl 仅移动光标不动选中
      const move = (next: number) => {
        ev.preventDefault();
        const n = Math.max(0, Math.min(next, L - 1));
        if (shift) {
          if (anchor.current < 0) anchor.current = i;
          setRange(anchor.current, n, true);
        } else if (ctrl) {
          setCursor(n);
          focusRow(n);
        } else {
          selectOnly(n);
        }
      };
      switch (ev.key) {
        case "ArrowDown":
          move(i + 1);
          break;
        case "ArrowUp":
          move(i - 1);
          break;
        case "Home":
          ev.preventDefault();
          if (shift) setRange(anchor.current < 0 ? i : anchor.current, 0, true);
          else selectOnly(0);
          break;
        case "End":
          ev.preventDefault();
          if (shift)
            setRange(anchor.current < 0 ? i : anchor.current, L - 1, true);
          else selectOnly(L - 1);
          break;
        case "PageDown":
          move(i + pageStep());
          break;
        case "PageUp":
          move(i - pageStep());
          break;
        case "Enter":
          ev.preventDefault();
          openItem(visibleEntries[i]);
          break;
        case "Backspace":
          ev.preventDefault();
          goUp();
          break;
      }
    },
    [
      visibleEntries,
      cursor,
      selectOnly,
      setRange,
      pageStep,
      openItem,
      goUp,
      focusRow,
    ]
  );

  // 全局快捷键：Ctrl+A 全选、Esc 清除、F2 重命名、F5 刷新、Delete 删除、打字定位（输入框内不响应）
  const handleAppKeyDown = useCallback(
    (ev: ReactKeyboardEvent) => {
      const t = ev.target as HTMLElement;
      if (t.closest("input")) return;
      const ctrl = ev.ctrlKey || ev.metaKey;
      if (ctrl && (ev.key === "a" || ev.key === "A")) {
        ev.preventDefault();
        setSelected(new Set(visibleEntries.map((e) => e.path)));
        return;
      }
      // 复制路径：Ctrl+Shift+C（资源管理器惯例）
      if (ctrl && ev.shiftKey && (ev.key === "C" || ev.key === "c")) {
        ev.preventDefault();
        const target = visibleEntries.find((e) => selected.has(e.path));
        if (target) void copyText(target.path);
        return;
      }
      // 复制文件名：Ctrl+C（仅文本，非文件级剪贴板）
      if (ctrl && !ev.shiftKey && (ev.key === "C" || ev.key === "c")) {
        ev.preventDefault();
        const target = visibleEntries.find((e) => selected.has(e.path));
        if (target) void copyText(target.name);
        return;
      }
      // 空格预览：打开时再按关闭；未打开时预览当前选中文件（目录不预览）
      if (ev.key === " " || ev.code === "Space") {
        ev.preventDefault();
        if (previewPath) {
          setPreviewPath(null);
        } else {
          const target = visibleEntries.find((e) => selected.has(e.path));
          if (target && !target.is_dir) setPreviewPath(target.path);
        }
        return;
      }
      if (ev.key === "Escape") {
        // 预览打开时优先关闭预览，不清空选中
        if (previewPath) {
          setPreviewPath(null);
          return;
        }
        setSelected(new Set());
        return;
      }
      if (ev.key === "F2") {
        ev.preventDefault();
        startRename();
        return;
      }
      if (ev.key === "F5") {
        ev.preventDefault();
        reload();
        return;
      }
      // 打字定位：在列表上输入字符，按名称前缀（不区分大小写）跳转
      if (!ctrl && !ev.altKey && ev.key.length === 1) {
        window.clearTimeout(typeTimer.current);
        typeBuf.current = (typeBuf.current + ev.key.toLowerCase()).slice(-40);
        typeTimer.current = window.setTimeout(() => {
          typeBuf.current = "";
        }, 900);
        const L = visibleEntries.length;
        if (L === 0) return;
        const start = cursor >= 0 ? cursor + 1 : 0;
        const q = typeBuf.current;
        for (let s = 0; s < L; s++) {
          const j = (start + s) % L;
          if (visibleEntries[j].name.toLowerCase().startsWith(q)) {
            selectOnly(j);
            break;
          }
        }
      }
    },
    [visibleEntries, selected, startRename, reload, selectOnly, cursor, previewPath]
  );

  // 取消选择后焦点在列表容器时，方向键重新起导航（光标 -1 时从首行开始）
  const handleTableKeyDown = useCallback(
    (ev: ReactKeyboardEvent) => {
      if (cursor >= 0) return;
      if (visibleEntries.length === 0) return;
      if (
        ["ArrowDown", "End", "PageDown", "ArrowUp", "Home", "PageUp"].includes(
          ev.key
        )
      ) {
        ev.preventDefault();
        selectOnly(0);
      }
    },
    [cursor, visibleEntries, selectOnly]
  );

  // 键盘导航（window 级捕获监听，焦点在窗口内非输入框处一律生效）：
  // 裸 ←=返回上一层 · 裸 →=进入当前选中项。
  // 与列表内的 ↑↓ 移动选中互不干扰；输入框内不拦截，保留光标编辑。
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      const { altKey, key } = ev;
      if (key !== "ArrowLeft" && key !== "ArrowRight") return;
      const t = ev.target as HTMLElement | null;
      if (t && t.closest("input, textarea, [contenteditable='true']")) return;
      if (altKey) return;
      if (key === "ArrowLeft") {
        ev.preventDefault();
        void goUp();
      } else if (key === "ArrowRight") {
        ev.preventDefault();
        if (cursor >= 0) openItem(visibleEntries[cursor]);
      } else {
        return;
      }
      ev.stopImmediatePropagation();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [goUp, openItem, cursor, visibleEntries]);

  return (
    <div
      className="app"
      onKeyDown={handleAppKeyDown}
      onContextMenu={(e) => e.preventDefault()}
    >
      {/* 自定义标题栏（跨平台统一风格，可拖拽） */}
      <header
        className="titlebar"
        data-tauri-drag-region
        onDoubleClick={(e) => {
          if ((e.target as HTMLElement).closest(".win-control, .traffic"))
            return;
          win.toggleMaximize();
        }}
      >
        {isMac ? (
          <div className="traffic">
            <button
              className="t-btn close"
              title="关闭"
              onClick={() => win.close()}
            />
            <button
              className="t-btn minimize"
              title="最小化"
              onClick={() => win.minimize()}
            />
            <button
              className="t-btn maximize"
              title={isMax ? "还原" : "最大化"}
              onClick={() => win.toggleMaximize()}
            />
          </div>
        ) : null}

        <div className="titlebar-id" data-tauri-drag-region>
          <span className="titlebar-mark" aria-hidden="true">#</span>
          <span className="titlebar-name" data-tauri-drag-region>
            Zeta
            {appVersion ? (
              <span className="titlebar-ver" data-tauri-drag-region>v{appVersion}</span>
            ) : null}
          </span>
        </div>

        {!isMac ? (
          <div className="win-control">
            <button title="最小化" onClick={() => win.minimize()}>
              <IconMinus size={15} />
            </button>
            <button
              title={isMax ? "还原" : "最大化"}
              onClick={() => win.toggleMaximize()}
            >
              {isMax ? <IconRestore size={14} /> : <IconMaximize size={13} />}
            </button>
            <button
              className="close"
              title="关闭"
              onClick={() => win.close()}
            >
              <IconClose size={15} />
            </button>
          </div>
        ) : null}
      </header>

      {/* 顶部工具栏 */}
      <header className="topbar">
        <div className="nav-btns">
          <button className="icon-btn" disabled={histIdx <= 0} onClick={goBack} title="后退" aria-label="后退">
            <IconArrowLeft size={16} />
          </button>
          <button
            className="icon-btn"
            disabled={histIdx >= hist.length - 1}
            onClick={goForward}
            title="前进"
            aria-label="前进"
          >
            <IconArrowRight size={16} />
          </button>
          <button className="icon-btn" onClick={goUp} title="上一级" aria-label="上一级" disabled={!parentOf(path)}>
            <IconArrowUp size={16} />
          </button>
          <button className="icon-btn refresh-btn" onClick={() => void reload()} title="刷新 (F5)" aria-label="刷新">
            <IconRedo size={16} />
          </button>
          <div className="vsep" />
          <div className="drive-select" ref={driveWrapRef}>
            <button
              className="drive-trigger"
              onClick={(ev) => {
                ev.stopPropagation();
                setDriveOpen((v) => !v);
              }}
              title={currentDrive ?? "已连接盘符"}
              aria-haspopup="menu"
              aria-expanded={driveOpen}
            >
              <span>{currentDrive?.replace("\\", "") ?? "盘"}</span>
              <IconSortArrow dir="desc" size={11} className="caret" />
            </button>
            {driveOpen && (
              <div className="drive-menu" role="menu" aria-label="选择盘符">
                {drives.map((d) => (
                  <button
                    key={d}
                    role="menuitem"
                    className={`drive-item ${path.startsWith(d) ? "active" : ""}`}
                    onClick={(ev) => {
                      ev.stopPropagation();
                      setDriveOpen(false);
                      navigate(d);
                    }}
                  >
                    <span className="drive-item-label">{d.replace("\\", "")}</span>
                    <span className="drive-item-path">{d}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="addrbar" ref={addrWrapRef} onMouseLeave={closeCrumbMenuSoon}>
          {addrEdit ? (
            <input
              ref={addrRef}
              className="addr-input"
              value={addrValue}
              onChange={(e) => setAddrValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  if (!addrValue.trim()) {
                    // 清空输入后回车：保持编辑态，光标留在输入框，不跳转不退出
                    addrRef.current?.focus();
                    e.preventDefault();
                    return;
                  }
                  commitAddr();
                } else if (e.key === "Escape") cancelAddr();
              }}
              onBlur={commitAddr}
            />
          ) : (
            <>
              <div className="crumbbar" ref={crumbbarRef} onClick={beginAddrEdit} title="点击编辑地址">
                {crumbShow.map((c, i) =>
                  c === null ? (
                    <span className="crumb crumb-ellipsis" key="ellipsis">
                      <span className="crumb-ellipsis-dot" aria-hidden="true">
                        …
                      </span>
                      <span className="crumb-sep">{isMac ? "/" : "\\"}</span>
                    </span>
                  ) : (
                    <span
                      className="crumb"
                      key={i}
                      onMouseEnter={(ev) => openCrumbMenu(c.path, ev.currentTarget)}
                    >
                      <button
                        className={c.path === path ? "cur" : ""}
                        onClick={(ev) => {
                          ev.stopPropagation(); // 避免冒泡到容器的进入编辑态
                          setCrumbMenu(null);
                          navigate(c.path);
                        }}
                      >
                        {c.label}
                      </button>
                      <span className="crumb-sep">{isMac ? "/" : "\\"}</span>
                    </span>
                  )
                )}
              </div>
              <button
                className="addr-edit-btn"
                disabled={!path}
                onClick={(ev) => {
                  ev.stopPropagation();
                  void copyText(path).then(
                    () => showToast("已复制地址"),
                    () => showToast("复制失败")
                  );
                }}
                title="复制地址"
                aria-label="复制地址"
              >
                <IconCopy size={14} />
              </button>
              <button
                className="addr-edit-btn"
                disabled={!path}
                onClick={(ev) => {
                  ev.stopPropagation();
                  void openInDefault(path).catch(() => showToast("打开失败"));
                }}
                title="用系统资源管理器打开"
                aria-label="用系统资源管理器打开"
              >
                <IconOpenExternal size={14} />
              </button>
              <button
                className={`addr-edit-btn ${histOpen ? "active" : ""}`}
                onClick={(ev) => {
                  ev.stopPropagation();
                  setHistOpen((v) => !v);
                }}
                title="浏览访问历史"
                aria-label="浏览访问历史"
                aria-expanded={histOpen}
              >
                <IconSortArrow dir="desc" size={12} className="caret" />
              </button>
              {histOpen && (
                <div
                  className="addr-hist"
                  role="menu"
                  aria-label="最近的路径"
                  tabIndex={-1}
                  ref={histPanelRef}
                  onKeyDown={histKeyNav}
                >
                  <div className="addr-hist-title">最近的路径</div>
                  {addrHist.length === 0 ? (
                    <div className="addr-hist-empty">暂无记录</div>
                  ) : (
                    addrHist.map((p, i) => (
                      <button
                        key={p}
                        ref={(el) => {
                          histItemRefs.current[i] = el;
                        }}
                        role="menuitem"
                        tabIndex={histFocus === i ? 0 : -1}
                        className={`addr-hist-item ${p === path ? "cur" : ""} ${histFocus === i ? "focused" : ""}`}
                        onMouseEnter={(ev) => {
                          setHistFocus(i);
                          ev.currentTarget.focus({ preventScroll: true });
                        }}
                        onClick={(ev) => {
                          ev.stopPropagation();
                          setHistOpen(false);
                          if (p !== path) void navigate(p);
                        }}
                        title={p}
                      >
                        <IconFolder size={14} className="addr-hist-icon" />
                        <span className="addr-hist-path">{p}</span>
                        <span
                          className="addr-hist-del"
                          role="button"
                          tabIndex={-1}
                          aria-label={`从历史中移除 ${p}`}
                          title="从历史中移除"
                          onClick={(ev) => {
                            ev.stopPropagation();
                            setAddrHist((prev) => {
                              const next = prev.filter((x) => x !== p);
                              try {
                                localStorage.setItem("zeta.addrHist", JSON.stringify(next));
                              } catch {
                                /* 忽略 */
                              }
                              return next;
                            });
                          }}
                        >
                          ×
                        </span>
                      </button>
                    ))
                  )}
                </div>
              )}
              {crumbMenu && (
                <div
                  className="crumb-menu"
                  style={{ left: crumbMenu.left, top: crumbMenu.top }}
                  onMouseEnter={keepCrumbMenu}
                  onMouseLeave={closeCrumbMenuSoon}
                  onClick={(ev) => ev.stopPropagation()}
                >
                  <div className="crumb-menu-title">{crumbMenu.path}</div>
                  {crumbMenu.items.length === 0 ? (
                    <div className="crumb-menu-empty">无子文件夹</div>
                  ) : (
                    crumbMenu.items.map((sub) => (
                      <button
                        key={sub}
                        className="crumb-menu-item"
                        onClick={() => {
                          setCrumbMenu(null);
                          if (sub !== path) void navigate(sub);
                        }}
                        title={sub}
                      >
                        <IconFolder size={14} className="crumb-menu-icon" />
                        <span className="crumb-menu-name">
                          {sub.split(/\\|\//).filter(Boolean).pop()}
                        </span>
                      </button>
                    ))
                  )}
                </div>
              )}
            </>
          )}
        </div>

        {/* 筛选框：位于地址栏最右侧 */}
        <div className="search-wrap">
          <IconSearch size={15} />
          <input
            className="search-input"
            placeholder="筛选当前目录…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          {search && (
            <button className="search-clear" onClick={() => setSearch("")} title="清除" aria-label="清除搜索">
              <IconClose size={13} />
            </button>
          )}
        </div>
        <button className="icon-btn settings-btn" onClick={() => setSettingsOpen(true)} title="设置" aria-label="设置">
          <IconSettings size={16} />
        </button>
      </header>

      {error && (
        <div className="errorbar">
          <span>{error}</span>
          <button onClick={() => setError("")}>关闭</button>
        </div>
      )}

      {toast && (
        <div key={toast.id} className="toast" role="status">
          {toast.msg}
        </div>
      )}

      <div className="content">
        {/* 中央：文件列表 */}
        <main className="filer">
          {search && (
            <div className="filer-head">
              <span className="result-count">共 {visibleEntries.length} 项</span>
            </div>
          )}

          <div
            className="table"
            tabIndex={0}
            onClick={(ev) => {
              // 点击空白处取消选择（点行内由行处理器接管）
              if ((ev.target as HTMLElement).closest(".row")) return;
              setSelected(new Set());
              setCursor(-1);
              anchor.current = -1;
              (ev.currentTarget as HTMLElement).focus();
            }}
            onKeyDown={handleTableKeyDown}
          >
            <div className="table-head">
              <button className={`col name ${sortKey === "name" ? "sorted" : ""}`} title={sortKey === "name" ? (sortDesc ? "名称降序" : "名称升序") : "按名称排序"} onClick={(ev) => { ev.stopPropagation(); applySort("name"); }}>
                名称
                {sortKey === "name" && <IconSortArrow dir={sortDesc ? "desc" : "asc"} />}
              </button>
              <span className="col tags">标签</span>
              <button className={`col date ${sortKey === "modified" ? "sorted" : ""}`} title={sortKey === "modified" ? (sortDesc ? "时间降序" : "时间升序") : "按修改时间排序"} onClick={(ev) => { ev.stopPropagation(); applySort("modified"); }}>
                修改日期
                {sortKey === "modified" && <IconSortArrow dir={sortDesc ? "desc" : "asc"} />}
              </button>
              <button className={`col size ${sortKey === "size" ? "sorted" : ""}`} title={sortKey === "size" ? (sortDesc ? "大小降序" : "大小升序") : "按大小排序"} onClick={(ev) => { ev.stopPropagation(); applySort("size"); }}>
                大小
                {sortKey === "size" && <IconSortArrow dir={sortDesc ? "desc" : "asc"} />}
              </button>
            </div>

            {loading ? (
              <div className="state loading">
                <span className="spinner" />
                载入中…
              </div>
            ) : visibleEntries.length === 0 ? (
              <div className="state empty">
                <IconFolder size={34} className="empty-icon" />
                <p>{search ? "没有匹配的文件" : "此目录为空"}</p>
              </div>
            ) : (
              <div
                key={path}
                className="table-body dir-enter"
                ref={bodyRef}
                onContextMenu={(ev) => {
                  ev.preventDefault();
                  ev.stopPropagation();
                  const np = ev.nativeEvent;
                  setCtxMenu({
                    x: np.clientX,
                    y: np.clientY,
                    paths: [],
                    single: null,
                  });
                }}
              >
                {visibleEntries.map((e, idx) => (
                  <div
                    key={e.path}
                    ref={(el) => {
                      rowRefs.current[idx] = el;
                    }}
                    tabIndex={idx === cursor ? 0 : -1}
                    aria-selected={selected.has(e.path)}
                    className={`row ${selected.has(e.path) ? "selected" : ""}`}
                    onClick={(ev) => {
                      if (ev.shiftKey) {
                        if (anchor.current < 0) anchor.current = cursor >= 0 ? cursor : idx;
                        setRange(anchor.current, idx, true);
                        focusRow(idx);
                      } else if (ev.ctrlKey || ev.metaKey) {
                        toggleSelect(e, true);
                        setCursor(idx);
                        anchor.current = idx;
                        focusRow(idx);
                      } else {
                        selectOnly(idx);
                      }
                    }}
                    onDoubleClick={() => openItem(e)}
                    onKeyDown={handleRowKeyDown}
                    onContextMenu={(ev) => {
                      ev.stopPropagation();
                      const target = ev.target as HTMLElement;
                      if (target.closest(".chip")) return; // 标签 chip 交给其自身的移除逻辑
                      openCtxMenu(ev.nativeEvent, e, selected);
                    }}
                  >
                    <span className="col name">
                      <FileGlyph entry={e} />
                      {idx === renamingIdx ? (
                        <input
                          ref={renameRef}
                          className="rename-input"
                          value={renameVal}
                          onChange={(ev2) => setRenameVal(ev2.target.value)}
                          onMouseDown={(ev2) => ev2.stopPropagation()}
                          onDoubleClick={(ev2) => ev2.stopPropagation()}
                          onClick={(ev2) => ev2.stopPropagation()}
                          onKeyDown={(ev2) => {
                            ev2.stopPropagation();
                            if (ev2.key === "Enter") {
                              ev2.preventDefault();
                              commitRename();
                            } else if (ev2.key === "Escape") {
                              ev2.preventDefault();
                              renameCommitted.current = true;
                              setRenamingIdx(null);
                            }
                          }}
                          onBlur={() => commitRename()}
                          spellCheck={false}
                        />
                      ) : (
                        <span className="filename">
                          {e.tags.length > 0 ? e.base + (e.ext ? "." + e.ext : "") : e.name}
                        </span>
                      )}
                    </span>
                    <span className="col tags">
                      {e.tags.map((t) => (
                        <button
                          key={t}
                          className="chip"
                          aria-label={`移除标签 ${t}`}
                          style={{ ["--chip-c" as string]: tagColor(t) }}
                          title={t}
                          onClick={(ev) => {
                            ev.stopPropagation();
                            removeTagFrom(e, t);
                          }}
                        >
                          <span className="chip-text">#{t}</span>
                          <IconClose size={11} className="chip-x" />
                        </button>
                      ))}
                    </span>
                    <span className="col date muted">{formatDate(e.modified)}</span>
                    <span className="col size muted">{e.is_dir ? "" : formatSize(e.size)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </main>

        {/* 右侧：打标签工具 + 标签展示 */}
        <aside className="tagbar">
          <div className="tagbar-group">
            <div className="side-title">
              <span>打标签</span>
            </div>
            <div className="tag-input-wrap">
              <IconTag size={15} />
              <input
                ref={tagInputRef}
                className="tag-input"
                placeholder={selected.size > 0 ? "给选中项打标签" : "先选中文件"}
                value={tagInput}
                onChange={(e) => setTagInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && applyTagToSelection()}
              />
              {tagInput && (
                <button
                  className="search-clear"
                  onClick={() => {
                    setTagInput("");
                    // 清空后焦点回到输入框，方便继续输入
                    tagInputRef.current?.focus();
                  }}
                  title="清空"
                  aria-label="清空标签输入"
                >
                  <IconClose size={13} />
                </button>
              )}
            </div>
            <button
              className="btn primary tag-apply"
              onClick={applyTagToSelection}
              disabled={selected.size === 0}
            >
              打标签{selected.size > 0 ? ` (${selected.size})` : ""}
            </button>
          </div>

          <div className="tagbar-group">
            <div className="side-title">
              <span>标签</span>
            </div>
            <ul className="tag-list">
              {tagCounts.map(([tag, count]) => (
                <li key={tag}>
                  <button
                    className="tag-row"
                    onClick={() => applyTagFromSidebar(tag)}
                    title="给选中项打此标签"
                  >
                    <span className="dot" style={{ background: tagColor(tag) }} />
                    <span className="tag-name">#{tag}</span>
                    <span className="tag-count">{count}</span>
                  </button>
                </li>
              ))}
              {tagCounts.length === 0 && (
                <li className="empty-hint">目录中暂无标签，选中文件后点标签即可标记</li>
              )}
            </ul>
          </div>
        </aside>
      </div>

      {/* 底部状态栏 */}
      <footer className="statusbar">
        <span>{selected.size > 0 ? `已选 ${selected.size} 项` : ""}</span>
        {selected.size > 0 && <span className="vsep" />}
        <span>{folders} 个文件夹 · {files} 个文件</span>
        <span className="spacer" />
        <span className="hint">单击选中 · ↑↓/Home/End 移动选中 · Shift 范围多选 · Enter/→ 打开 · Backspace/← 上级 · F2 重命名 · F5 刷新 · 输入字符定位</span>
      </footer>

      {/* 自定义右键菜单 */}
      {ctxMenu && (
        <ContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          paths={ctxMenu.paths}
          single={ctxMenu.single}
          onClose={closeCtxMenu}
          onRefresh={() => {
            closeCtxMenu();
            reload();
          }}
          onOpenEntry={() => {
            if (ctxMenu.single) {
              closeCtxMenu();
              openItem(ctxMenu.single);
            }
          }}
          onRename={() => {
            closeCtxMenu();
            const single = ctxMenu.single;
            if (!single) return;
            const i = visibleEntries.findIndex((x) => x.path === single.path);
            if (i >= 0) {
              setCursor(i);
              renameCommitted.current = false;
              setRenameVal(single.name);
              setRenamingIdx(i);
            }
          }}
          onDissolve={() => {
            const single = ctxMenu.single;
            if (!single || !single.is_dir) return;
            const s = single;
            closeCtxMenu();
            setDialog({
              kind: "confirm",
              title: "解散文件夹",
              message: `解散文件夹「${s.name}」？\n内部子项将上移到当前目录，空壳删除。可用 Ctrl+Z 撤销。`,
              confirmLabel: "解散",
              action: () => {
                void (async () => {
                  selfOpAt.current = Date.now();
                  try {
                    await dissolveFolder(s.path);
                    await reload();
                  } catch (e) {
                    setError(String(e));
                  }
                })();
              },
            });
          }}
          onCollect={() => {
            const paths = ctxMenu.paths;
            if (!paths.length) return;
            closeCtxMenu();
            setDialog({
              kind: "prompt",
              title: "收入到文件夹",
              label: "文件夹名",
              defaultValue: "新建文件夹",
              action: (name) => {
                const trimmed = name.trim();
                void (async () => {
                  selfOpAt.current = Date.now();
                  try {
                    const folderPath = await collectIntoFolder(paths, trimmed);
                    await reload();
                    // reload 后闭包 visibleEntries 是旧值，直接 listDir 拿最新列表做下标计算
                    const fresh = await listDir(path);
                    const i = fresh.findIndex((e) => e.path === folderPath);
                    if (i >= 0) {
                      setCursor(i);
                      selectOnly(i);
                    }
                  } catch (e) {
                    setError(String(e));
                  }
                })();
              },
            });
          }}
          onClearTags={() => {
            if (!ctxMenu.paths.length) return;
            closeCtxMenu();
            void clearAllTags(ctxMenu.paths);
          }}
          onCopyName={() => {
            const single = ctxMenu.single;
            if (!single) return;
            closeCtxMenu();
            void copyText(single.name);
          }}
          onCopyPath={() => {
            const single = ctxMenu.single;
            if (!single) return;
            closeCtxMenu();
            void copyText(single.path);
          }}
        />
      )}

      {/* 空格预览面板：右侧抽屉式浮层 */}
      <PreviewPane entry={previewEntry} onClose={() => setPreviewPath(null)} />

      {/* 集中式弹窗：确认框（原生 confirm 替代） */}
      {dialog?.kind === "confirm" && (
        <ConfirmDialog
          open
          title={dialog.title}
          message={dialog.message}
          danger={dialog.danger}
          confirmLabel={dialog.confirmLabel}
          onConfirm={() => {
            const a = dialog.action;
            setDialog(null);
            a();
          }}
          onCancel={() => setDialog(null)}
        />
      )}
      {/* 集中式弹窗：输入框（原生 prompt 替代） */}
      {dialog?.kind === "prompt" && (
        <PromptDialog
          open
          title={dialog.title}
          label={dialog.label}
          defaultValue={dialog.defaultValue}
          onConfirm={(v) => {
            const a = dialog.action;
            setDialog(null);
            a(v);
          }}
          onCancel={() => setDialog(null)}
        />
      )}
      <SettingsDialog
        open={settingsOpen}
        settings={settings}
        onChange={updateSettings}
        onClose={() => setSettingsOpen(false)}
      />
    </div>
  );
}

/** 统一的文件/文件夹类型图标 */
function FileGlyph({ entry }: { entry: FileEntry }) {
  if (entry.is_dir) {
    return (
      <span className="glyph dir" title="文件夹">
        <IconFolder size={19} />
      </span>
    );
  }
  const s = extStyle(entry.ext);
  return (
    <span
      className="glyph file"
      style={{ ["--glyph-c" as string]: s.color }}
      title={entry.ext ? `${entry.ext} 文件` : "文件"}
    >
      <span className="glyph-label">{s.label}</span>
    </span>
  );
}

/** 轮询超时哨兵：网络路径读取在时限内未返回时由 withTimeout 返回 */
const TIMEOUT = Symbol("poll-timeout");

/** 竞速包装：ms 内未 settle（或失败）返回 TIMEOUT，避免网络路径挂起阻塞轮询 */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | typeof TIMEOUT> {
  return new Promise((resolve) => {
    const t = window.setTimeout(() => resolve(TIMEOUT), ms);
    p.then(
      (v) => {
        window.clearTimeout(t);
        resolve(v);
      },
      () => {
        window.clearTimeout(t);
        resolve(TIMEOUT);
      }
    );
  });
}

function parentOf(path: string): string | null {
  // 按操作系统统一分隔符：Windows 用 \，macOS 用 /
  const sep = isMac ? "/" : "\\";
  const trimmed = path.endsWith(sep) && path.length > 1 ? path.slice(0, -1) : path;
  if (!isMac && trimmed.startsWith("\\\\")) {
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
  if (!parent) return null;
  if (isMac) return parent === "/" ? "/" : parent; // macOS 根目录特殊处理
  return parent.length === 2 ? parent + "\\" : parent;
}

type ContextMenuProps = {
  x: number;
  y: number;
  paths: string[];
  single: FileEntry | null;
  onClose: () => void;
  onRefresh: () => void;
  onOpenEntry: () => void;
  onRename: () => void;
  onClearTags: () => void;
  onCopyName: () => void;
  onCopyPath: () => void;
  onDissolve: () => void;
  onCollect: () => void;
};

/**
 * 自定义右键菜单。
 * 无障碍：带 role=menu/menuitem、内部焦点管理（方向键/Home/End/Enter/Esc 导航），
 * 并按实际尺寸 clamp 到视口内，避免右下角溢出。
 */
function ContextMenu(props: ContextMenuProps) {
  const { x, y, paths, single, onClose, onRefresh, onOpenEntry, onRename, onClearTags, onCopyName, onCopyPath, onDissolve, onCollect } = props;
  const menuRef = useRef<HTMLDivElement | null>(null);
  const itemRefs = useRef<(HTMLDivElement | null)[]>([]);

  // 组装菜单项：统一渲染便于键盘导航
  const items: { key: string; label: string; danger: boolean; accel?: string; action: () => void }[] = [];
  const showClearTags = single ? single.tags.length > 0 : paths.length > 1;
  if (!paths.length) {
    items.push({ key: "refresh", label: "刷新", danger: false, action: onRefresh });
  } else {
    if (single)
      items.push({
        key: "open",
        label: single.is_dir ? "打开文件夹" : "打开文件",
        danger: false,
        action: onOpenEntry,
      });
    // 复制类操作：仅单选时展示，多选场景路径/文件名含义模糊
    if (single) {
      items.push({ key: "copyname", label: "复制文件名", danger: false, accel: "Ctrl+C", action: onCopyName });
      items.push({ key: "copypath", label: "复制路径", danger: false, accel: "Ctrl+Shift+C", action: onCopyPath });
    }
    if (single) items.push({ key: "rename", label: "重命名", danger: false, action: onRename });
    if (single && single.is_dir) items.push({ key: "dissolve", label: "解散文件夹", danger: false, action: onDissolve });
    // 收入文件夹：单选或多选都可用，须有至少一项选中
    items.push({ key: "collect", label: "收入到文件夹", danger: false, action: onCollect });
    if (showClearTags)
      items.push({ key: "cleartags", label: "移除全部标签", danger: false, action: onClearTags });
  }

  // 键盘导航焦点下标
  const [focusIdx, setFocusIdx] = useState(0);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  // 挂载后按实际尺寸做视口 clamp，避免弹出瞬间溢出
  useEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    setPos({
      left: x + r.width > vw ? Math.max(4, vw - r.width - 4) : x,
      top: y + r.height > vh ? Math.max(4, vh - r.height - 4) : y,
    });
    // 挂载后聚焦首个可用项；点击弹出时不出现原生焦点环，键盘按需显式聚焦
    itemRefs.current[0]?.focus({ preventScroll: true });
    // eslint 忽略：menuRef 仅用于一次性测量
    void el;
  }, [x, y]);

  const moveFocus = useCallback(
    (i: number) => {
      const n = items.length;
      if (n === 0) return;
      const idx = ((i % n) + n) % n;
      setFocusIdx(idx);
      itemRefs.current[idx]?.focus({ preventScroll: true });
    },
    [items.length]
  );

  // 容器级键盘导航；stopPropagation 避免冒泡到 .app 触发类型定位/清除选中
  const onKeyNav = useCallback(
    (ev: ReactKeyboardEvent) => {
      const n = items.length;
      if (n === 0) return;
      if (
        ev.key === "ArrowDown" ||
        ev.key === "ArrowUp" ||
        ev.key === "Home" ||
        ev.key === "End" ||
        ev.key === "Enter" ||
        ev.key === "Escape"
      ) {
        ev.preventDefault();
        ev.stopPropagation();
      }
      switch (ev.key) {
        case "ArrowDown":
          moveFocus(focusIdx + 1);
          break;
        case "ArrowUp":
          moveFocus(focusIdx - 1);
          break;
        case "Home":
          moveFocus(0);
          break;
        case "End":
          moveFocus(n - 1);
          break;
        case "Enter":
          items[focusIdx]?.action();
          break;
        case "Escape":
          onClose();
          break;
        default:
          // 其他按键（含打字字符）屏蔽，避免误触类型定位
          ev.stopPropagation();
      }
    },
    [items, focusIdx, moveFocus, onClose]
  );

  return (
    <div
      ref={menuRef}
      role="menu"
      aria-label="文件操作菜单"
      tabIndex={-1}
      className="context-menu"
      style={{ left: pos?.left ?? x, top: pos?.top ?? y, opacity: pos ? 1 : 0 }}
      onKeyDown={onKeyNav}
    >
      {items.map((it, i) => (
        <div
          key={it.key}
          ref={(el) => {
            itemRefs.current[i] = el;
          }}
          role="menuitem"
          tabIndex={focusIdx === i ? 0 : -1}
          className={`ctx-item${it.danger ? " ctx-delete" : ""}${i === focusIdx ? " focused" : ""}`}
          onClick={it.action}
          onMouseEnter={(ev) => {
            setFocusIdx(i);
            ev.currentTarget.focus({ preventScroll: true });
          }}
        >
          <span>{it.label}</span>
          {it.accel && <span className="ctx-accel">{it.accel}</span>}
        </div>
      ))}
    </div>
  );
}