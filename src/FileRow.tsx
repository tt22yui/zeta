import { memo } from "react";
import type {
  DragEvent as ReactDragEvent,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
} from "react";
import type { FileEntry } from "./types";
import { IconClose, IconFolder } from "./icons";
import { extStyle, formatDate, formatSize, tagColor } from "./util";

/** 统一的文件/文件夹类型图标 */
function FileGlyph({ entry }: { entry: FileEntry }) {
  if (entry.is_dir) {
    return (
      <span className="glyph dir" title="文件夹" aria-hidden="true">
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
      aria-hidden="true"
    >
      <span className="glyph-label">{s.label}</span>
    </span>
  );
}

/**
 * 行事件处理器集合。
 * 父组件每帧把最新闭包写进一个 ref，行组件在事件触发时才从 ref 读取，
 * 这样即便该行因 memo 被跳过渲染，也不会执行到过期闭包。
 */
export type RowActions = {
  attachRef: (el: HTMLDivElement | null, idx: number) => void;
  dragStart: (ev: ReactDragEvent<HTMLDivElement>, entry: FileEntry) => void;
  click: (ev: ReactMouseEvent<HTMLDivElement>, entry: FileEntry, idx: number) => void;
  dblclick: (entry: FileEntry) => void;
  keydown: (ev: ReactKeyboardEvent<HTMLDivElement>) => void;
  contextMenu: (ev: ReactMouseEvent<HTMLDivElement>, entry: FileEntry) => void;
  renameCommit: () => void;
  renameCancel: () => void;
  removeTag: (entry: FileEntry, tag: string) => void;
};

type RowProps = {
  entry: FileEntry;
  idx: number;
  isCursor: boolean;
  isSelected: boolean;
  isRenaming: boolean;
  isDissolving: boolean;
  /** 拖拽进行中且本行是文件夹：显示"可放置"提示 */
  isDroppable: boolean;
  /** 当前落点（松手即移动到这里） */
  isDropTarget: boolean;
  /** 刚接收了本次拖放的条目：播一下"已接收"动画 */
  isAccepted: boolean;
  renameRef: { current: HTMLInputElement | null };
  actions: { current: RowActions };
};

/**
 * 单行（memo 化）。
 * props 只有数据布尔量、下标与两个稳定引用，因此与行无关的 state（通知、标签输入、
 * 弹层开关、搜索框文字等）变化不会再让整表重渲染；只有 isCursor/isSelected 等真正
 * 变化的那一两行才重新渲染。
 */
export const Row = memo(function Row({
  entry: e,
  idx,
  isCursor,
  isSelected,
  isRenaming,
  isDissolving,
  isDroppable,
  isDropTarget,
  isAccepted,
  renameRef,
  actions,
}: RowProps) {
  return (
    <div
      ref={(el) => actions.current.attachRef(el, idx)}
      tabIndex={isCursor ? 0 : -1}
      role="option"
      aria-selected={isSelected}
      // data-row-* 是行身份的显式标记，便于调试与将来做行级别的外部定位/测试
      data-row-path={e.path}
      data-row-is-dir={e.is_dir ? "1" : "0"}
      className={`row ${isCursor ? "focused" : ""} ${isSelected ? "selected" : ""} ${isDissolving ? "row-dissolving" : ""} ${isDroppable ? "droppable" : ""} ${isDropTarget ? "drop-target" : ""} ${isAccepted ? "drop-accepted" : ""}`}
      draggable={!isRenaming}
      onDragStart={(ev) => actions.current.dragStart(ev, e)}
      onClick={(ev) => actions.current.click(ev, e, idx)}
      onDoubleClick={() => actions.current.dblclick(e)}
      onKeyDown={(ev) => actions.current.keydown(ev)}
      onContextMenu={(ev) => actions.current.contextMenu(ev, e)}
    >
      {isDropTarget && <span className="drop-badge">松手移入此文件夹</span>}
      <span className="col name">
        <FileGlyph entry={e} />
        {isRenaming ? (
          <input
            ref={renameRef}
            className="rename-input"
            autoComplete="off"
            // 非受控：输入过程只改 DOM，不触发整表重渲染；提交时从 ref 取值
            defaultValue={e.name}
            onMouseDown={(ev2) => ev2.stopPropagation()}
            onDoubleClick={(ev2) => ev2.stopPropagation()}
            onClick={(ev2) => ev2.stopPropagation()}
            onKeyDown={(ev2) => {
              ev2.stopPropagation();
              if (ev2.key === "Enter") {
                ev2.preventDefault();
                actions.current.renameCommit();
              } else if (ev2.key === "Escape") {
                ev2.preventDefault();
                actions.current.renameCancel();
              }
            }}
            onBlur={() => actions.current.renameCommit()}
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
              actions.current.removeTag(e, t);
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
  );
});
