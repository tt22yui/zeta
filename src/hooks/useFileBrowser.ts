import { useCallback, useEffect, useRef, useState } from "react";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import { watchImmediate } from "@tauri-apps/plugin-fs";
import { getDefaultDir, getDrives, listDir, openInDefault } from "../api";
import type { FileEntry } from "../types";
import { TIMEOUT, parentOf, withTimeout } from "../util";
import type { NoticeSeverity } from "../useNotice";

type Params = {
  /** 启动时恢复上次访问路径（设置开关） */
  restoreLastPath: boolean;
  showNotice: (severity: NoticeSeverity, msg: string) => void;
  clearNotice: () => void;
  setSearch: (s: string) => void;
  setSelected: Dispatch<SetStateAction<Set<string>>>;
  setCursor: Dispatch<SetStateAction<number>>;
  selectedRef: MutableRefObject<Set<string>>;
  selfOpAt: MutableRefObject<number>;
};

/**
 * 目录浏览与导航：加载目录、前进/后退/上一级、自动刷新（监听或轮询）。
 * selected/cursor 由 App 持有：加载目录要清空选中、reload 要恢复选中，
 * 提升后可避免「导航 ↔ 选中」两 hook 互相依赖。
 */
export function useFileBrowser({
  restoreLastPath,
  showNotice,
  clearNotice,
  setSearch,
  setSelected,
  setCursor,
  selectedRef,
  selfOpAt,
}: Params) {
  const [path, setPath] = useState("");
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [drives, setDrives] = useState<string[]>([]);
  const [hist, setHist] = useState<string[]>([]);
  const [histIdx, setHistIdx] = useState(-1);
  const [loading, setLoading] = useState(false);
  // 记录「从哪个父目录进入了哪个子目录」，返回上级时据此恢复光标停留
  const lastEnterRef = useRef<{ parent: string; childPath: string } | null>(null);
  // 前进重入栈：记录「上退时离开的目录」，使 ← 退到任意上层后 → 仍能跨层重入
  const fwdRef = useRef<string[]>([]);
  // 待聚焦的子目录项，列表加载到位后将其设为光标与选中（用于返回上级后恢复）
  const [pendingFocus, setPendingFocus] = useState<string | null>(null);

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
      if (!noErrorUi) clearNotice();
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
        if (!noErrorUi) showNotice("error", String(e));
        // 路径失效回退：父目录可用则进入父目录，否则退回默认目录
        const parent = parentOf(dir);
        if (parent && parent !== dir) {
          const r = await loadDir(parent, { silent: true, noErrorUi });
          if (r) {
            showNotice("warning", `路径不存在，已回退到 ${parent}`);
            return r;
          }
        }
        try {
          const def = await getDefaultDir();
          if (def && def !== dir) {
            const r = await loadDir(def, { silent: true, noErrorUi });
            if (r) {
              showNotice("warning", "路径不存在，已回退到默认目录");
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
    [clearNotice, showNotice, setSelected, setCursor]
  );

  useEffect(() => {
    // 启动早期后端/IPC 可能尚未就绪，get_drives 失败会让盘符下拉永久为空，故失败自动重试；
    // 但「成功返回空」是有效答案（macOS 本就没有盘符），不能再重试 —— 否则白等 3 秒并多发 5 次 IPC
    let stop = false;
    const loadDrives = async () => {
      for (let i = 0; i < 6; i++) {
        try {
          const d = await getDrives();
          if (!stop) setDrives(d);
          return;
        } catch {
          /* 后端未就绪，稍后重试 */
        }
        if (i < 5) await new Promise((r) => setTimeout(r, 500));
      }
    };
    void loadDrives();
    // 优先恢复上次访问的路径（受设置开关控制），否则回到默认目录
    let remembered: string | null = null;
    if (restoreLastPath) {
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
    // 卸载或依赖变化时置位，避免旧一轮的异步续体在失效后继续 setDrives
    return () => {
      stop = true;
    };
  }, [loadDir, restoreLastPath]);

  const navigate = useCallback(
    async (dir: string, opts: { keepForward?: boolean } = {}) => {
      setSearch("");
      // 前进重入栈只在「上退 / 前进重入」链上保留；分支到别处（面包屑/历史/进入新目录）即清空
      if (!opts.keepForward) fwdRef.current = [];
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
    [hist, histIdx, loadDir, setSearch, setPendingFocus]
  );

  const goBack = useCallback(async () => {
    if (histIdx <= 0) return;
    fwdRef.current = []; // 历史后退属分支跳转，前进重入栈作废
    const idx = histIdx - 1;
    setSearch("");
    const result = await loadDir(hist[idx]);
    if (!result) return; // 该历史项及其回退均失效：停留在当前视图
    if (result.path !== hist[idx]) {
      setHist((prev) => prev.map((p, i) => (i === idx ? result.path : p)));
    }
    setHistIdx(idx);
  }, [hist, histIdx, loadDir, setSearch]);

  const goForward = useCallback(async () => {
    if (histIdx >= hist.length - 1) return;
    fwdRef.current = []; // 历史前进属分支跳转，前进重入栈作废
    const idx = histIdx + 1;
    setSearch("");
    const result = await loadDir(hist[idx]);
    if (!result) return;
    if (result.path !== hist[idx]) {
      setHist((prev) => prev.map((p, i) => (i === idx ? result.path : p)));
    }
    setHistIdx(idx);
  }, [hist, histIdx, loadDir, setSearch]);

  const goUp = useCallback(async () => {
    const parent = parentOf(path);
    if (parent && parent !== path) {
      // 上退：记录被离开的目录，供跨层 → 重入
      fwdRef.current.push(path);
      await navigate(parent, { keepForward: true });
    }
  }, [path, navigate]);

  /** 前进重入：无聚焦行时按上退栈重入最近离开的目录（跨层对称） */
  const stepForward = useCallback(() => {
    const target = fwdRef.current.pop();
    if (target) void navigate(target, { keepForward: true });
  }, [navigate]);

  const reload = useCallback(
    async (opts: { noErrorUi?: boolean } = {}) => {
      // 记住此刻的选中集，重载后用「仍存在」的路径恢复选中，
      // 避免打标签改名后外部 watch 触发的自动刷新把选中清空。
      // 从 ref 读取而非依赖 selected：保持 reload 身份稳定，避免选中变化重建监听
      // （应尽量避免把高状态放入 reload 的依赖，见下方 watch effect）。
      const prevSelected = new Set(selectedRef.current);
      // silent：后台刷新不触发 loading 闪烁（轮询/自动刷新/F5 复用）
      const result = await loadDir(path, { silent: true, noErrorUi: opts.noErrorUi });
      const list = result?.list ?? null;
      if (prevSelected.size && list) {
        const live = new Set(list.map((e) => e.path));
        const keep = [...prevSelected].filter((p) => live.has(p));
        if (keep.length) setSelected(new Set(keep));
      }
      return result;
    },
    [path, loadDir, selectedRef, setSelected]
  );

  // 外部对当前目录的变动（增删改）自动刷新。
  // 本地路径用 watchImmediate（事件驱动）；UNC 网络共享不支持文件监听，
  // 降级为 3 秒定时轮询，避免外部改动无法反映到列表。
  // 依赖里只有 path：reload 已去掉 selected 依赖，选中变化不再重建订阅
  // （否则每次点击都会 dispose + 重建 watch，UNC 轮询的 inFlight/timeouts 也会被复位）。
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
            if (timeouts === 3) showNotice("error", `网络路径响应超时：${path}`);
            return;
          }
          const stuck = timeouts >= 3;
          timeouts = 0;
          if (r === null) showNotice("error", `无法访问网络路径：${path}`);
          else if (stuck) clearNotice(); // 超时恢复后清除提示
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
      .catch((e) => showNotice("error", `自动刷新监听失败：${e}`)); // 便于排查授权/路径问题
    return () => {
      alive = false;
      window.clearTimeout(timer);
      unlisten?.();
    };
  }, [path, reload, showNotice, clearNotice, selfOpAt]);

  /** 打开条目：目录则进入并把光标恢复记录，文件则交给系统默认应用 */
  const openItem = useCallback(
    (entry: FileEntry) => {
      if (entry.is_dir) {
        lastEnterRef.current = { parent: path, childPath: entry.path };
        navigate(entry.path);
      } else openInDefault(entry.path).catch((e) => showNotice("error", String(e)));
    },
    [navigate, path, showNotice]
  );

  // 当前所在的盘符（UNC 路径时无盘符）
  const currentDrive = drives.find((d) => path.startsWith(d)) ?? null;

  return {
    path,
    entries,
    drives,
    hist,
    histIdx,
    loading,
    currentDrive,
    navigate,
    goBack,
    goForward,
    goUp,
    stepForward,
    reload,
    openItem,
    pendingFocus,
    setPendingFocus,
  };
}
