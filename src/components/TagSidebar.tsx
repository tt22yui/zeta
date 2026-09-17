import { useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { IconClose, IconTag } from "../icons";
import { tagColor } from "../util";

type TagSidebarProps = {
  /** 当前目录各标签的计数，按数量降序 */
  tagCounts: [string, number][];
  selectedCount: number;
  /** 给选中项打上输入框里的标签 */
  onApplyTag: (tag: string) => void;
  /** 点击侧栏已有标签：给选中项打该标签（自动忽略已含该标签的项） */
  onApplyFromSidebar: (tag: string) => void;
};

/** 右侧：打标签输入 + 当前目录标签列表 */
export function TagSidebar({
  tagCounts,
  selectedCount,
  onApplyTag,
  onApplyFromSidebar,
}: TagSidebarProps) {
  const [tagInput, setTagInput] = useState("");
  const tagInputRef = useRef<HTMLInputElement | null>(null);

  const apply = () => onApplyTag(tagInput);
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter") apply();
  };

  return (
    <aside className="tagbar">
      <div className="tagbar-group">
        <div className="tag-input-wrap">
          <input
            ref={tagInputRef}
            className="tag-input"
            autoComplete="off"
            placeholder="输入标签"
            value={tagInput}
            onChange={(e) => setTagInput(e.target.value)}
            onKeyDown={onKeyDown}
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
          <button
            className="tag-apply"
            onClick={apply}
            disabled={selectedCount === 0}
            title={selectedCount > 0 ? `给 ${selectedCount} 个选中项打标签` : "先选中文件"}
            aria-label="打标签"
          >
            <IconTag size={16} />
          </button>
        </div>
      </div>

      <div className="tagbar-group">
        <ul className="tag-list">
          {tagCounts.map(([tag, count]) => (
            <li key={tag}>
              <button
                className="tag-row"
                onClick={() => onApplyFromSidebar(tag)}
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
  );
}
