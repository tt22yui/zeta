import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import type { FileEntry } from "./types";
import { isMac } from "./util";

type ContextMenuProps = {
  x: number;
  y: number;
  paths: string[];
  single: FileEntry | null;
  allDirs: boolean;
  onClose: () => void;
  onRefresh: () => void;
  onOpenEntry: () => void;
  onRename: () => void;
  onClearTags: () => void;
  onCopyName: () => void;
  onCopyPath: () => void;
  onDissolve: () => void;
  onCollect: () => void;
  onDelete: () => void;
};

/**
 * 自定义右键菜单。
 * 无障碍：带 role=menu/menuitem、内部焦点管理（方向键/Home/End/Enter/Esc 导航），
 * 并按实际尺寸 clamp 到视口内，避免右下角溢出。
 */
export function ContextMenu(props: ContextMenuProps) {
  const { x, y, paths, single, allDirs, onClose, onRefresh, onOpenEntry, onRename, onClearTags, onCopyName, onCopyPath, onDissolve, onCollect, onDelete } = props;
  const menuRef = useRef<HTMLDivElement | null>(null);
  const itemRefs = useRef<(HTMLDivElement | null)[]>([]);

  // 组装菜单项：统一渲染便于键盘导航。
  // 用 useMemo 固定引用：否则键盘回调的依赖每次都变（菜单只在打开时渲染，实际开销本就不大）
  const items = useMemo(() => {
    const list: { key: string; label: string; danger: boolean; accel?: string; action: () => void }[] = [];
    const showClearTags = single ? single.tags.length > 0 : paths.length > 1;
    if (!paths.length) {
      list.push({ key: "refresh", label: "刷新", danger: false, action: onRefresh });
    } else {
      if (single)
        list.push({
          key: "open",
          label: single.is_dir ? "打开文件夹" : "打开文件",
          danger: false,
          action: onOpenEntry,
        });
      // 复制类操作：仅单选时展示，多选场景路径/文件名含义模糊
      // 加速键文案跟随平台惯例（macOS 显示 ⌘，与处理器的 metaKey 分支一致）
      if (single) {
        list.push({
          key: "copyname",
          label: "复制文件名",
          danger: false,
          accel: isMac ? "⌘C" : "Ctrl+C",
          action: onCopyName,
        });
        list.push({
          key: "copypath",
          label: "复制路径",
          danger: false,
          accel: isMac ? "⌘⇧C" : "Ctrl+Shift+C",
          action: onCopyPath,
        });
      }
      if (single) list.push({ key: "rename", label: "重命名", danger: false, action: onRename });
      // 解散文件夹：单选文件夹，或多选且全部为文件夹时可用
      if ((single && single.is_dir) || (paths.length > 1 && allDirs))
        list.push({ key: "dissolve", label: "解散文件夹", danger: false, action: onDissolve });
      // 收入文件夹：单选或多选都可用，须有至少一项选中
      list.push({ key: "collect", label: "收入到文件夹", danger: false, action: onCollect });
      if (showClearTags)
        list.push({ key: "cleartags", label: "移除全部标签", danger: false, action: onClearTags });
      // 删除放在末尾：本地走回收站，UNC 永久删除（App 侧对后者二次确认）
      list.push({ key: "delete", label: "删除", danger: true, accel: "Delete", action: onDelete });
    }
    return list;
  }, [
    paths,
    single,
    allDirs,
    onRefresh,
    onOpenEntry,
    onCopyName,
    onCopyPath,
    onRename,
    onDissolve,
    onCollect,
    onClearTags,
    onDelete,
  ]);

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
