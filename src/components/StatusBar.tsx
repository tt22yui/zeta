type StatusBarProps = {
  selectedCount: number;
  folders: number;
  files: number;
  dragging: boolean;
  dropTarget: string | null;
};

/** 底部状态栏：选中统计、目录统计、拖拽指引 */
export function StatusBar({ selectedCount, folders, files, dragging, dropTarget }: StatusBarProps) {
  return (
    <footer className="statusbar">
      <span>{selectedCount > 0 ? `已选 ${selectedCount} 项` : ""}</span>
      {selectedCount > 0 && <span className="vsep" />}
      <span>
        {folders} 个文件夹 · {files} 个文件
      </span>
      <span className="spacer" />
      {/* 拖拽中给出明确指引：能拖到哪、松手会发生什么 */}
      {dragging ? (
        <span className="hint hint-drag">
          {dropTarget
            ? "松手：移动到高亮的文件夹"
            : "拖到文件夹行即可移动到该文件夹 · 拖到窗口外可复制给其它应用"}
        </span>
      ) : (
        /* 底部快捷提示：宽窗显示完整键盘捷径；窄窗收敛为高频句，避免被 55% 裁成断句 */
        <span className="hint">
          <span className="hint-long">
            单击选中 · ↑↓/Home/End 移动 · Shift 范围多选 · Enter/→ 打开 · Backspace/← 上级 · F2
            重命名 · F5 刷新 · 输入字符定位
          </span>
          <span className="hint-short">↑↓ 移动 · Shift 多选 · Enter 打开 · ← 上级 · F2 重命名</span>
        </span>
      )}
    </footer>
  );
}
