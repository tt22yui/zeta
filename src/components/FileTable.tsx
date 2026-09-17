import type { MouseEvent as ReactMouseEvent, MutableRefObject } from "react";
import type { FileEntry } from "../types";
import { Row } from "../FileRow";
import type { RowActions } from "../FileRow";
import { IconFolder, IconSortArrow } from "../icons";

type SortKey = "name" | "size" | "modified";

type FileTableProps = {
  path: string;
  entries: FileEntry[];
  search: string;
  loading: boolean;
  cursor: number;
  selected: Set<string>;
  renamingIdx: number | null;
  dissolving: Set<string>;
  dragging: boolean;
  dropTarget: string | null;
  acceptedPath: string | null;
  sortKey: SortKey;
  sortDesc: boolean;
  applySort: (k: SortKey) => void;
  renameRef: MutableRefObject<HTMLInputElement | null>;
  bodyRef: MutableRefObject<HTMLDivElement | null>;
  actions: MutableRefObject<RowActions>;
  onTableClick: (ev: ReactMouseEvent<HTMLDivElement>) => void;
  onTableKeyDown: (ev: React.KeyboardEvent<HTMLDivElement>) => void;
  onBodyContextMenu: (ev: ReactMouseEvent<HTMLDivElement>) => void;
};

/** 中央文件列表：表头（排序）+ 加载/空态 + 行渲染 */
export function FileTable({
  path,
  entries,
  search,
  loading,
  cursor,
  selected,
  renamingIdx,
  dissolving,
  dragging,
  dropTarget,
  acceptedPath,
  sortKey,
  sortDesc,
  applySort,
  renameRef,
  bodyRef,
  actions,
  onTableClick,
  onTableKeyDown,
  onBodyContextMenu,
}: FileTableProps) {
  return (
    <main className="filer">
      {search && (
        <div className="filer-head">
          <span className="result-count">共 {entries.length} 项</span>
        </div>
      )}

      <div className="table" tabIndex={0} onClick={onTableClick} onKeyDown={onTableKeyDown}>
        <div className="table-head">
          <button
            className={`col name ${sortKey === "name" ? "sorted" : ""}`}
            title={sortKey === "name" ? (sortDesc ? "名称降序" : "名称升序") : "按名称排序"}
            onClick={(ev) => {
              ev.stopPropagation();
              applySort("name");
            }}
          >
            名称
            {sortKey === "name" && <IconSortArrow dir={sortDesc ? "desc" : "asc"} />}
          </button>
          <span className="col tags">标签</span>
          <button
            className={`col date ${sortKey === "modified" ? "sorted" : ""}`}
            title={sortKey === "modified" ? (sortDesc ? "时间降序" : "时间升序") : "按修改时间排序"}
            onClick={(ev) => {
              ev.stopPropagation();
              applySort("modified");
            }}
          >
            修改日期
            {sortKey === "modified" && <IconSortArrow dir={sortDesc ? "desc" : "asc"} />}
          </button>
          <button
            className={`col size ${sortKey === "size" ? "sorted" : ""}`}
            title={sortKey === "size" ? (sortDesc ? "大小降序" : "大小升序") : "按大小排序"}
            onClick={(ev) => {
              ev.stopPropagation();
              applySort("size");
            }}
          >
            大小
            {sortKey === "size" && <IconSortArrow dir={sortDesc ? "desc" : "asc"} />}
          </button>
        </div>

        {loading ? (
          <div className="state loading">
            <span className="spinner" />
            载入中…
          </div>
        ) : entries.length === 0 ? (
          <div className="state empty">
            <IconFolder size={34} className="empty-icon" />
            <p>{search ? "没有匹配的文件" : "此目录为空"}</p>
          </div>
        ) : (
          <div
            key={path}
            className="table-body dir-enter"
            ref={bodyRef}
            role="listbox"
            aria-multiselectable="true"
            aria-label="文件列表"
            onContextMenu={onBodyContextMenu}
          >
            {entries.map((e, idx) => (
              <Row
                key={e.path}
                entry={e}
                idx={idx}
                isCursor={idx === cursor}
                isSelected={selected.has(e.path)}
                isRenaming={idx === renamingIdx}
                isDissolving={dissolving.has(e.path)}
                isDroppable={dragging && e.is_dir}
                isDropTarget={dropTarget === e.path}
                isAccepted={acceptedPath === e.path}
                renameRef={renameRef}
                actions={actions}
              />
            ))}
          </div>
        )}
      </div>
    </main>
  );
}
