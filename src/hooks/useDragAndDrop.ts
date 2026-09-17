import { useCallback, useEffect, useRef, useState } from "react";
import type { DragEvent as ReactDragEvent, MutableRefObject } from "react";
import { getCurrentWindow, cursorPosition } from "@tauri-apps/api/window";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { startDrag } from "@crabnebula/tauri-plugin-drag";
import { moveIntoFolder } from "../api";
import type { FileEntry } from "../types";
import { makeDragCanvas } from "../drag";
import { hitRowAtCursor } from "../util";
import type { NoticeSeverity } from "../useNotice";

const win = getCurrentWindow();

type Params = {
  selected: Set<string>;
  reload: () => Promise<unknown>;
  entriesRef: MutableRefObject<FileEntry[]>;
  /** 标记本应用发起的文件操作时刻，让紧随其后的 watch 自动刷新跳过，避免重复加载 */
  selfOpAt: MutableRefObject<number>;
  showNotice: (severity: NoticeSeverity, msg: string) => void;
};

/**
 * 拖放：单一手势、按"落在哪"区分功能 ——
 *   落在本窗口的文件夹行上 → 应用内移动（剪切）
 *   落在窗口外（资源管理器/飞书等）→ 复制给对方，携带真实文件句柄
 * 统一走原生 OS 拖拽（HTML5 拖拽给不出真实文件句柄，无法对外复制）。
 */
export function useDragAndDrop({ selected, reload, entriesRef, selfOpAt, showNotice }: Params) {
  // 内部拖放：当前被悬停命中的文件夹行路径（用于落点高亮）
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  // 是否正在拖拽：用于展示"可放置"提示与状态栏指引
  const [dragging, setDragging] = useState(false);
  // 刚落下的目标文件夹行路径：给它一个短暂的"已接收"动画
  const [acceptedPath, setAcceptedPath] = useState<string | null>(null);
  // 窗口原点（物理像素）与缩放：把拖放事件/光标坐标换算成 CSS 像素需要
  const winOriginRef = useRef({ x: 0, y: 0 });
  const winScaleRef = useRef(1);
  // drop 回调里用最新落点兜底（监听闭包的注册时机早于状态更新）
  const dropTargetRef = useRef<string | null>(null);
  dropTargetRef.current = dropTarget;
  // 本轮拖拽是否收到过 over 事件：决定要不要启用低频轮询兜底
  const sawOverRef = useRef(false);
  const draggingRef = useRef(false);
  draggingRef.current = dragging;

  /** 内部拖放「剪切」：把 paths 移动到目标文件夹并给出反馈 */
  const moveIntoFolderFrom = useCallback(
    async (dest: string, paths: string[]) => {
      selfOpAt.current = Date.now();
      try {
        await moveIntoFolder(paths, dest);
        await reload();
        // 目标行闪一下"已接收"，让落点结果可见（目标文件夹仍在列表里）
        setAcceptedPath(dest);
        window.setTimeout(() => setAcceptedPath((cur) => (cur === dest ? null : cur)), 700);
        const name = dest.split(/[\\/]/).filter(Boolean).pop() ?? dest;
        showNotice("success", `已移动 ${paths.length} 项到「${name}」`);
      } catch (e) {
        showNotice("error", String(e));
      }
    },
    [reload, showNotice, selfOpAt]
  );

  // 拖拽中的落点高亮：主来源是 webview 的 enter/over 事件（推送式、延迟低，不需要 IPC 往返）。
  // 兜底：某些平台/场景下自拖自落不送 over，则在 300ms 后启用低频轮询（150ms），
  // 且一旦收到过 over 就不再轮询 —— 避免两套来源叠加造成抖动。
  useEffect(() => {
    let alive = true;
    let unlisten: (() => void) | undefined;
    const hitAt = (px: number, py: number) => {
      const scale = winScaleRef.current || window.devicePixelRatio || 1;
      return hitRowAtCursor(px, py, winOriginRef.current, scale);
    };
    getCurrentWebview()
      .onDragDropEvent((ev) => {
        if (!alive) return;
        const p = ev.payload;
        if (p.type === "leave") {
          // 指针离开窗口：没有落点行（"可放置"虚线框仍保留到拖拽结束）
          setDropTarget(null);
          return;
        }
        if (p.type === "enter" || p.type === "over") {
          sawOverRef.current = true;
          const hit = hitAt(p.position.x, p.position.y);
          const next = hit?.isDir ? hit.path : null;
          setDropTarget((cur) => (cur === next ? cur : next));
          return;
        }
        // drop：按落点判断功能 —— 命中文件夹行且拖的是本目录条目 → 移动
        setDropTarget(null);
        setDragging(false); // 兜底：原生拖拽的 Promise 若未及时结束，这里也收掉"拖拽中"
        const hit = hitAt(p.position.x, p.position.y);
        const dest = hit?.isDir ? hit.path : dropTargetRef.current;
        if (!dest) return;
        const internal = p.paths.filter((q) => entriesRef.current.some((en) => en.path === q));
        if (internal.length === 0) return; // 从系统拖进来的外部文件不动
        void moveIntoFolderFrom(dest, internal);
      })
      .then((fn) => {
        if (alive) unlisten = fn;
        else fn();
      })
      .catch((e) => console.error("注册拖放监听失败:", e));
    return () => {
      alive = false;
      unlisten?.();
    };
  }, [moveIntoFolderFrom, entriesRef]);

  useEffect(() => {
    if (!dragging) return;
    let cancelled = false;
    let inFlight = false;
    let timer: number | undefined;
    const arm = window.setTimeout(() => {
      if (cancelled || sawOverRef.current) return; // over 事件可用 → 无需轮询
      timer = window.setInterval(async () => {
        if (cancelled || inFlight || sawOverRef.current || !draggingRef.current) return;
        inFlight = true;
        try {
          const p = await cursorPosition();
          const scale = winScaleRef.current || window.devicePixelRatio || 1;
          const hit = hitRowAtCursor(p.x, p.y, winOriginRef.current, scale);
          const next = hit?.isDir ? hit.path : null;
          setDropTarget((cur) => (cur === next ? cur : next));
        } catch {
          /* 取不到光标：忽略，下一轮再试 */
        } finally {
          inFlight = false;
        }
      }, 150);
    }, 300);
    return () => {
      cancelled = true;
      window.clearTimeout(arm);
      if (timer !== undefined) window.clearInterval(timer);
    };
  }, [dragging]);

  /**
   * 行拖拽开始。记录窗口原点/缩放，先让"可放置"提示绘制出来（原生拖拽会接管消息循环，
   * 期间未必还能重绘），再交给原生拖拽插件。
   */
  const dragStart = useCallback(
    (ev: ReactDragEvent<HTMLDivElement>, e: FileEntry) => {
      // 单一手势、按"落在哪"区分功能：
      //   落在本窗口的文件夹行上 → 应用内移动（剪切）
      //   落在窗口外（资源管理器/飞书等）→ 复制给对方，携带真实文件句柄
      // 因此这里统一走原生 OS 拖拽（HTML5 拖拽给不出真实文件句柄，无法对外复制）。
      ev.preventDefault();
      const paths = selected.has(e.path) && selected.size > 1 ? [...selected] : [e.path];
      sawOverRef.current = false;
      setDragging(true);
      void (async () => {
        // 记录窗口原点与缩放：拖放事件/兜底轮询给的都是物理像素
        try {
          const [origin, scale] = await Promise.all([win.innerPosition(), win.scaleFactor()]);
          winOriginRef.current = { x: origin.x, y: origin.y };
          winScaleRef.current = scale || 1;
        } catch {
          /* 取不到就退回 devicePixelRatio */
        }
        // 先让"可放置"提示绘制出来：原生拖拽会接管消息循环，期间未必还能重绘
        await new Promise((r) => setTimeout(r, 40));
        try {
          await startDrag({
            item: paths,
            icon: makeDragCanvas(paths.length).toDataURL("image/png"),
            mode: "copy",
          });
        } catch (err) {
          console.error("原生拖拽失败:", err);
        } finally {
          setDragging(false);
          setDropTarget(null);
        }
      })();
    },
    [selected]
  );

  return { dropTarget, dragging, acceptedPath, dragStart };
}
