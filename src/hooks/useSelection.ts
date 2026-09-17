import { useCallback, useEffect, useRef, useState } from "react";
import type {
  Dispatch,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  MutableRefObject,
  SetStateAction,
} from "react";
import { flushSync } from "react-dom";
import { renameFile } from "../api";
import type { FileEntry } from "../types";
import { isEditableTarget, isInteractiveTarget } from "../util";
import type { NoticeSeverity } from "../useNotice";

type Params = {
  // 选中状态由 App 持有：loadDir/reload 需要清空/恢复选中，提升后可避免跨 hook 循环依赖
  selected: Set<string>;
  setSelected: Dispatch<SetStateAction<Set<string>>>;
  cursor: number;
  setCursor: Dispatch<SetStateAction<number>>;
  visibleEntries: FileEntry[];
  pendingFocus: string | null;
  setPendingFocus: (p: string | null) => void;
  openItem: (entry: FileEntry) => void;
  goUp: () => void;
  previewPath: string | null;
  setPreviewPath: (p: string | null) => void;
  copyWithNotice: (text: string, what: string) => void;
  showNotice: (severity: NoticeSeverity, msg: string) => void;
  reload: () => Promise<unknown>;
  /** 列表滚动容器（用于 PageUp/PageDown 翻页步长） */
  bodyRef: MutableRefObject<HTMLDivElement | null>;
  /** 标记本应用发起的文件操作时刻，让紧随其后的 watch 自动刷新跳过 */
  selfOpAt: MutableRefObject<number>;
};

/**
 * 列表选中与键盘导航：光标行、范围多选、行内重命名、打字定位。
 * 光标行下标（列表内 roving tabindex）与行 DOM 引用集中在此，行组件只读 ref。
 */
export function useSelection({
  selected,
  setSelected,
  cursor,
  setCursor,
  visibleEntries,
  pendingFocus,
  setPendingFocus,
  openItem,
  goUp,
  previewPath,
  setPreviewPath,
  copyWithNotice,
  showNotice,
  reload,
  bodyRef,
  selfOpAt,
}: Params) {
  const rowRefs = useRef<(HTMLDivElement | null)[]>([]);
  // Shift 范围多选的锚点行下标
  const anchor = useRef(-1);
  // 行内重命名（输入值由输入框自身持有，不再放 state）
  const [renamingIdx, setRenamingIdx] = useState<number | null>(null);
  const renameRef = useRef<HTMLInputElement | null>(null);
  const renameCommitted = useRef(false);
  // 类型定位（打字跳转）缓冲
  const typeBuf = useRef("");
  const typeTimer = useRef<number>();

  // 进入行内重命名时聚焦并全选
  useEffect(() => {
    if (renamingIdx != null) {
      renameRef.current?.focus();
      renameRef.current?.select();
    }
  }, [renamingIdx]);

  // 卸载时清掉类型定位延时器：否则卸载后回调仍会触发 setState
  useEffect(() => () => window.clearTimeout(typeTimer.current), []);

  // visibleEntries 变化时钳制光标落在有效范围内
  useEffect(() => {
    if (visibleEntries.length === 0) setCursor(-1);
    else if (cursor >= visibleEntries.length) setCursor(visibleEntries.length - 1);
  }, [visibleEntries.length, cursor, setCursor]);

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
    [visibleEntries, focusRow, setSelected, setCursor]
  );

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
    [visibleEntries, focusRow, setSelected, setCursor]
  );

  // PageUp/PageDown 翻页步长：按可见区域能容纳的行数。
  // 行高取首行实测值（而非硬编码常量），避免与 CSS 里的 .row 高度脱钩。
  const pageStep = useCallback(() => {
    const body = bodyRef.current;
    if (!body) return 8;
    const rowH = body.firstElementChild?.getBoundingClientRect().height;
    const h = rowH && rowH > 0 ? rowH : 40; // 兜底值与 styles.css 的 .row min-height 一致
    return Math.max(1, Math.floor(body.clientHeight / h) - 1);
  }, [bodyRef]);

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
  }, [setSelected]);

  const clearSelection = useCallback(() => {
    setSelected(new Set());
    anchor.current = -1;
  }, [setSelected]);

  // 返回上级后恢复光标：在加载完成的列表里定位最近进入的那个子目录
  useEffect(() => {
    if (!pendingFocus) return;
    const i = visibleEntries.findIndex((e) => e.path === pendingFocus);
    if (i < 0) return; // 列表还没加载到位，等下次 visibleEntries 变化再试
    selectOnly(i);
    setPendingFocus(null);
  }, [pendingFocus, visibleEntries, selectOnly, setPendingFocus]);

  // 键盘把选中光标移到第 n 行时，若预览已打开则跟随光标：
  // 文件切换预览（手势内同步挂载保证带声自动播放）、目录关闭预览。
  const syncPreview = useCallback(
    (n: number) => {
      if (!previewPath) return;
      const target = visibleEntries[n];
      if (!target) return;
      if (target.is_dir) setPreviewPath(null);
      else flushSync(() => setPreviewPath(target.path));
    },
    [previewPath, visibleEntries, setPreviewPath]
  );

  // 行点击：Shift 范围多选、Ctrl 切换、普通点击替换单选；预览已打开时跟随选中
  const rowClick = useCallback(
    (ev: ReactMouseEvent<HTMLDivElement>, e: FileEntry, idx: number) => {
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
        // 预览已打开时跟随选中：点到文件切换预览、点到目录关闭预览。
        // flushSync 在手势内同步挂载新媒体，保证带声自动播放
        if (previewPath) flushSync(() => setPreviewPath(e.is_dir ? null : e.path));
      }
    },
    [cursor, setRange, focusRow, toggleSelect, selectOnly, previewPath, setPreviewPath, setCursor]
  );

  // 行内键盘移动（焦点在行上时）
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
          syncPreview(n);
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
          else {
            selectOnly(0);
            syncPreview(0);
          }
          break;
        case "End":
          ev.preventDefault();
          if (shift) setRange(anchor.current < 0 ? i : anchor.current, L - 1, true);
          else {
            selectOnly(L - 1);
            syncPreview(L - 1);
          }
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
      syncPreview,
      setCursor,
    ]
  );

  // 取消选择后焦点在列表容器时，方向键重新起导航（光标 -1 时从首行开始）
  const handleTableKeyDown = useCallback(
    (ev: ReactKeyboardEvent) => {
      if (cursor >= 0) return;
      if (visibleEntries.length === 0) return;
      if (["ArrowDown", "End", "PageDown", "ArrowUp", "Home", "PageUp"].includes(ev.key)) {
        ev.preventDefault();
        selectOnly(0);
      }
    },
    [cursor, visibleEntries, selectOnly]
  );

  // 全局快捷键：Ctrl+A 全选、Esc 清除、空格预览、复制路径/文件名、打字定位（输入框内不响应）
  // 注意：删除与撤销/重做暂无快捷键（后端命令已就绪，界面未接入，见 PLAN.md）
  const handleAppKeyDown = useCallback(
    (ev: ReactKeyboardEvent) => {
      const t = ev.target as HTMLElement | null;
      // 输入框内一律让位给文本编辑
      if (t && isEditableTarget(t)) return;
      // 焦点在按钮/链接/菜单项上时，空格要留给它们自身的激活语义
      const onControl = !!t && isInteractiveTarget(t);
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
        if (target) copyWithNotice(target.path, "路径");
        return;
      }
      // 复制文件名：Ctrl+C（仅文本，非文件级剪贴板）
      if (ctrl && !ev.shiftKey && (ev.key === "C" || ev.key === "c")) {
        ev.preventDefault();
        const target = visibleEntries.find((e) => selected.has(e.path));
        if (target) copyWithNotice(target.name, "文件名");
        return;
      }
      // 空格预览：打开时再按关闭；未打开时预览当前选中文件（目录不预览）
      // 焦点在按钮等控件上时不拦截，否则按钮按空格既激活不了、还会顺手弹预览
      if ((ev.key === " " || ev.code === "Space") && !onControl) {
        ev.preventDefault();
        if (previewPath) {
          setPreviewPath(null);
        } else {
          const target = visibleEntries.find((e) => selected.has(e.path));
          // flushSync：让预览媒体在本次键盘手势内同步挂载，带声自动播放才被浏览器放行
          if (target && !target.is_dir) flushSync(() => setPreviewPath(target.path));
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
        anchor.current = -1;
        return;
      }
      // F2 / F5 由 App 的 window 捕获层统一处理（会 stopImmediatePropagation），此处不再重复
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
    [
      visibleEntries,
      selected,
      selectOnly,
      cursor,
      previewPath,
      setPreviewPath,
      copyWithNotice,
      setSelected,
    ]
  );

  // 行内重命名：提交（Enter / 失焦）
  const commitRename = useCallback(async () => {
    if (renameCommitted.current) return;
    renameCommitted.current = true;
    selfOpAt.current = Date.now();
    const idx = renamingIdx;
    const entry = idx == null ? null : visibleEntries[idx];
    // 值从输入框 DOM 读取（该输入框是非受控的）：避免每个按键都 setState 让整表重渲染
    const v = (renameRef.current?.value ?? "").trim();
    setRenamingIdx(null);
    if (!entry || !v || v === entry.name) return;
    const newPath = entry.path.slice(0, entry.path.length - entry.name.length) + v;
    try {
      await renameFile(entry.path, newPath);
      await reload();
    } catch (e) {
      showNotice("error", String(e));
    }
  }, [renamingIdx, visibleEntries, reload, showNotice, selfOpAt]);

  // 开始对光标行重命名（F2）；输入框自身以 defaultValue 承载初值，无需再写状态
  const startRename = useCallback(() => {
    if (cursor < 0) return;
    renameCommitted.current = false;
    setRenamingIdx(cursor);
  }, [cursor]);

  return {
    selected,
    setSelected,
    cursor,
    setCursor,
    anchor,
    rowRefs,
    focusRow,
    selectOnly,
    setRange,
    pageStep,
    toggleSelect,
    clearSelection,
    rowClick,
    handleRowKeyDown,
    handleTableKeyDown,
    handleAppKeyDown,
    syncPreview,
    // 重命名
    renamingIdx,
    setRenamingIdx,
    renameRef,
    renameCommitted,
    startRename,
    commitRename,
  };
}
