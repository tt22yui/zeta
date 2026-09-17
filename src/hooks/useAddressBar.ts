import { useCallback, useEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { getHomeDir, listSubdirs } from "../api";
import { isMac } from "../util";
import type { Settings } from "../settings";

type Params = {
  path: string;
  navigate: (dir: string) => void | Promise<void>;
  settings: Settings;
};

/** 读取 localStorage 里的字符串数组，容错非数组/混入非字符串的脏数据 */
function loadStringList(key: string): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(key) ?? "[]");
    return Array.isArray(raw) ? raw.filter((p): p is string => typeof p === "string") : [];
  } catch {
    return [];
  }
}

/**
 * 地址栏一族的状态：编辑态、访问历史、面包屑子目录下拉、盘符/收藏下拉、收藏路径。
 * 这些状态彼此无关列表与选择，集中在自定义 hook 里，App 只负责编排。
 */
export function useAddressBar({ path, navigate, settings }: Params) {
  const [addrEdit, setAddrEdit] = useState(false);
  const [addrValue, setAddrValue] = useState("");
  // 地址栏历史：已成功进入过的目录（去重、最近优先、持久化）
  const [addrHist, setAddrHist] = useState<string[]>(() => loadStringList("zeta.addrHist"));
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
  // 盘符下拉
  const [driveOpen, setDriveOpen] = useState(false);
  // 收藏路径：持久化到 localStorage，最近加入置顶
  const [favorites, setFavorites] = useState<string[]>(() => loadStringList("zeta.favorites"));
  const [favOpen, setFavOpen] = useState(false);

  const addrRef = useRef<HTMLInputElement | null>(null);
  const addrWrapRef = useRef<HTMLDivElement | null>(null);
  const histPanelRef = useRef<HTMLDivElement | null>(null);
  const histItemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const crumbCloseTimer = useRef<number>();
  const driveWrapRef = useRef<HTMLDivElement | null>(null);
  const favWrapRef = useRef<HTMLDivElement | null>(null);

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

  // 地址栏进入编辑态时聚焦并全选
  useEffect(() => {
    if (addrEdit && addrRef.current) {
      addrRef.current.focus();
      addrRef.current.select();
    }
  }, [addrEdit]);

  // 卸载时清掉面包屑关闭延时器：否则卸载后回调仍会触发 setState
  useEffect(() => () => window.clearTimeout(crumbCloseTimer.current), []);

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
  const openCrumbMenu = useCallback(async (dir: string, el: HTMLElement) => {
    window.clearTimeout(crumbCloseTimer.current);
    const r = el.getBoundingClientRect();
    const left = Math.max(4, Math.min(r.left, window.innerWidth - 224));
    let items: string[];
    try {
      items = await listSubdirs(dir);
    } catch {
      items = [];
    }
    setHistOpen(false);
    setDriveOpen(false);
    setFavOpen(false);
    setCrumbMenu({ path: dir, left, top: r.bottom + 4, items });
  }, []);

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

  /** 切换收藏：加入（置顶去重）或移除，并持久化 */
  const toggleFavorite = useCallback((p: string) => {
    setFavorites((prev) => {
      const already = prev.includes(p);
      const next = already ? prev.filter((x) => x !== p) : [p, ...prev].slice(0, 50);
      try {
        localStorage.setItem("zeta.favorites", JSON.stringify(next));
      } catch {
        /* 忽略 */
      }
      return next;
    });
  }, []);

  // 收敛所有下拉/弹层：地址栏历史、面包屑子目录、盘符、收藏
  const closeAllPopups = useCallback(() => {
    setHistOpen(false);
    setCrumbMenu(null);
    setDriveOpen(false);
    setFavOpen(false);
  }, []);

  // 点击面包屑下拉外部或 Esc 时关闭
  useEffect(() => {
    if (!crumbMenu) return;
    const onDoc = (e: MouseEvent) => {
      if (!addrWrapRef.current?.contains(e.target as Node)) setCrumbMenu(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setCrumbMenu(null);
    };
    // 延迟到本次按钮事件之后再注册，避免「打开即关闭」；若期间面板已被关闭，
    // cleanup 必须连这个待执行的回调一起取消，否则监听器会在 cleanup 之后被永久挂上（泄漏并持有过期闭包）
    const deferAdd = window.setTimeout(() => window.addEventListener("mousedown", onDoc, true), 0);
    window.addEventListener("keydown", onKey);
    return () => {
      window.clearTimeout(deferAdd);
      window.removeEventListener("mousedown", onDoc, true);
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
    const deferAdd = window.setTimeout(() => window.addEventListener("mousedown", onDoc, true), 0);
    window.addEventListener("keydown", onKey);
    return () => {
      window.clearTimeout(deferAdd);
      window.removeEventListener("mousedown", onDoc, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [driveOpen]);

  // 点击收藏下拉外部或 Esc 时关闭
  useEffect(() => {
    if (!favOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (!favWrapRef.current?.contains(e.target as Node)) setFavOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setFavOpen(false);
    };
    const deferAdd = window.setTimeout(() => window.addEventListener("mousedown", onDoc, true), 0);
    window.addEventListener("keydown", onKey);
    return () => {
      window.clearTimeout(deferAdd);
      window.removeEventListener("mousedown", onDoc, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [favOpen]);

  // 点击地址栏历史下拉外部或 Esc 时关闭
  useEffect(() => {
    if (!histOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (!addrWrapRef.current?.contains(e.target as Node)) setHistOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setHistOpen(false);
    };
    const deferAdd = window.setTimeout(
      () => window.addEventListener("mousedown", onDoc, true),
      0
    ); // 延迟到本次按钮事件之后，避免打开即关闭
    window.addEventListener("keydown", onKey);
    return () => {
      window.clearTimeout(deferAdd);
      window.removeEventListener("mousedown", onDoc, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [histOpen]);

  return {
    // 编辑态
    addrEdit,
    addrValue,
    setAddrValue,
    addrRef,
    addrWrapRef,
    beginAddrEdit,
    commitAddr,
    cancelAddr,
    // 访问历史
    addrHist,
    setAddrHist,
    histOpen,
    setHistOpen,
    histFocus,
    setHistFocus,
    histPanelRef,
    histItemRefs,
    histKeyNav,
    // 面包屑
    crumbMenu,
    setCrumbMenu,
    openCrumbMenu,
    closeCrumbMenuSoon,
    keepCrumbMenu,
    // 盘符 / 收藏
    driveOpen,
    setDriveOpen,
    driveWrapRef,
    favOpen,
    setFavOpen,
    favWrapRef,
    favorites,
    toggleFavorite,
    isFavorite: favorites.includes(path),
    // 通用
    closeAllPopups,
  };
}
