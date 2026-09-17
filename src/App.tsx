import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FileEntry } from "./types";
import type { RowActions } from "./FileRow";
import { ContextMenu } from "./ContextMenu";
import { IconClose, IconSearch, IconSettings } from "./icons";
import { useNotice } from "./useNotice";
import PreviewPane from "./PreviewPane";
import { ConfirmDialog, PromptDialog } from "./Dialog";
import { SettingsDialog } from "./SettingsDialog";
import { isEditableTarget, isInteractiveTarget, isMac, parentOf } from "./util";
import { TitleBar } from "./components/TitleBar";
import { Toolbar } from "./components/Toolbar";
import { AddressBar } from "./components/AddressBar";
import { FileTable } from "./components/FileTable";
import { TagSidebar } from "./components/TagSidebar";
import { StatusBar } from "./components/StatusBar";
import { useWindowState } from "./hooks/useWindowState";
import { useSettings } from "./hooks/useSettings";
import { useFileBrowser } from "./hooks/useFileBrowser";
import { useFileList } from "./hooks/useFileList";
import { useHistory } from "./hooks/useHistory";
import { useSelection } from "./hooks/useSelection";
import { useAddressBar } from "./hooks/useAddressBar";
import { useDragAndDrop } from "./hooks/useDragAndDrop";
import { useFileActions } from "./hooks/useFileActions";

export default function App() {
  // 统一轻提示：单一底部 Toaster（info/success/warning 自动消失，error 常驻可手动关闭）
  const { notice, clearNotice, showNotice, copyWithNotice } = useNotice();
  // 窗口最大化状态与运行时版本号
  const { isMax, appVersion } = useWindowState();
  // 设置：单键 JSON（zeta.settings）持久化，集中管理
  const { settings, updateSettings, settingsOpen, setSettingsOpen } = useSettings();

  const [search, setSearch] = useState("");
  // 选中提升到 App：加载目录要清空、reload 要恢复，提升后可避免「导航 ↔ 选中」循环依赖
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [cursor, setCursor] = useState(-1);
  // selected 的同步镜像：reload 读取「重载前的选中集」，但不放进依赖（避免重建文件监听）
  const selectedRef = useRef<Set<string>>(new Set());
  selectedRef.current = selected;
  // 空格预览面板：当前预览的文件路径；null 表示面板关闭
  const [previewPath, setPreviewPath] = useState<string | null>(null);
  // 记录本应用发起的文件操作时间点：随后较短窗口内的 watch 自动刷新会被跳过
  const selfOpAt = useRef(0);
  // 当前目录条目的同步镜像：drop 事件回调里判断"落下的路径是否属于本目录"
  const entriesRef = useRef<FileEntry[]>([]);
  // 列表滚动容器（用于 PageUp/PageDown 翻页步长）
  const bodyRef = useRef<HTMLDivElement | null>(null);
  // 弹层 / 对话框 / 地址栏编辑中：全局导航键（裸 ←→）不应改动背后的列表
  const popupOpenRef = useRef(false);

  // 目录浏览与导航
  const {
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
  } = useFileBrowser({
    restoreLastPath: settings.restoreLastPath,
    showNotice,
    clearNotice,
    setSearch,
    setSelected,
    setCursor,
    selectedRef,
    selfOpAt,
  });
  entriesRef.current = entries;

  // 撤销/重做：可用态 + 动作
  const {
    canUndo,
    canRedo,
    refresh: refreshHistory,
    undo: doUndo,
    redo: doRedo,
  } = useHistory({ reload, showNotice, selfOpAt });

  // 应用内变更后：reload 再刷新撤销/重做可用态。watch/轮询仍用原始 reload，避免频繁 IPC。
  const reloadAfterMutation = useCallback(
    async (opts: { noErrorUi?: boolean } = {}) => {
      const r = await reload(opts);
      await refreshHistory();
      return r;
    },
    [reload, refreshHistory]
  );

  // 列表视图派生：搜索过滤 / 排序 / 标签计数 / 统计
  const { sortKey, sortDesc, applySort, visibleEntries, tagCounts, folders, files } = useFileList(
    entries,
    search
  );

  // 空格预览面板当前条目：从 visibleEntries 按 previewPath 派生，列表刷新后自动同步
  const previewEntry = useMemo(
    () => (previewPath ? visibleEntries.find((e) => e.path === previewPath) ?? null : null),
    [previewPath, visibleEntries]
  );

  // 选中与键盘导航
  const selection = useSelection({
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
    reload: reloadAfterMutation,
    bodyRef,
    selfOpAt,
  });
  const {
    rowRefs,
    focusRow,
    selectOnly,
    rowClick,
    clearSelection,
    handleRowKeyDown,
    handleTableKeyDown,
    handleAppKeyDown,
    renamingIdx,
    setRenamingIdx,
    renameRef,
    renameCommitted,
    startRename,
    commitRename,
  } = selection;

  // 地址栏一族：编辑态、访问历史、面包屑、盘符/收藏下拉
  const address = useAddressBar({ path, navigate, settings });
  const { closeAllPopups } = address;

  // 拖放：内部移动 + 对外复制
  const { dropTarget, dragging, acceptedPath, dragStart } = useDragAndDrop({
    selected,
    reload: reloadAfterMutation,
    entriesRef,
    selfOpAt,
    showNotice,
  });

  // 文件操作与弹窗编排：打标签、右键菜单、解散/收入文件夹、删除到回收站
  const {
    ctxMenu,
    openCtxMenu,
    openEmptyCtxMenu,
    closeCtxMenu,
    dialog,
    setDialog,
    dissolving,
    applyTagToSelection,
    applyTagFromSidebar,
    removeTagFrom,
    clearAllTags,
    requestDissolve,
    requestCollect,
    requestDelete,
  } = useFileActions({
    selected,
    setSelected,
    entries,
    reload: reloadAfterMutation,
    showNotice,
    clearNotice,
    selfOpAt,
    selectOnly,
    setCursor,
    closeAllPopups,
    path,
  });

  // 弹层 / 对话框开启时，全局导航键让位
  popupOpenRef.current = !!(
    address.histOpen ||
    address.crumbMenu ||
    address.driveOpen ||
    address.favOpen ||
    ctxMenu ||
    dialog ||
    settingsOpen ||
    address.addrEdit
  );

  // 全局快捷键（window 级捕获监听，焦点在窗口内非输入框处一律生效）：
  // 裸 ←=返回上一层 · 裸 →=进入当前选中项 · F2=重命名 · F5=刷新 · Delete=删除 · Ctrl+Z/Ctrl+Shift+Z=撤销/重做。
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      const { altKey, key } = ev;
      const t = ev.target as HTMLElement | null;
      const inInput = !!(t && isEditableTarget(t));
      if (key === "F2") {
        // 输入框内（改名片/地址栏/标签输入）不拦截，避免误触发重命名
        if (inInput) return;
        ev.preventDefault();
        startRename();
        ev.stopImmediatePropagation();
        return;
      }
      if (key === "F5") {
        ev.preventDefault();
        reload();
        ev.stopImmediatePropagation();
        return;
      }
      // 撤销 / 重做：输入框内让位给文本编辑
      if ((ev.ctrlKey || ev.metaKey) && !altKey && (key === "z" || key === "Z")) {
        if (inInput) return;
        ev.preventDefault();
        if (ev.shiftKey) doRedo();
        else doUndo();
        ev.stopImmediatePropagation();
        return;
      }
      // 删除到回收站：输入框/自带语义的控件/弹层内不响应
      if (key === "Delete" && !ev.ctrlKey && !ev.metaKey && !altKey) {
        if (inInput) return;
        if (t && isInteractiveTarget(t)) return;
        if (popupOpenRef.current) return;
        if (selected.size === 0) return;
        ev.preventDefault();
        requestDelete([...selected]);
        ev.stopImmediatePropagation();
        return;
      }
      if (key !== "ArrowLeft" && key !== "ArrowRight") return;
      if (inInput) return;
      if (altKey) return;
      // 弹层/对话框打开时裸 ←→ 属于该弹层的交互，不能顺手改动背后的列表
      if (popupOpenRef.current) return;
      if (key === "ArrowLeft") {
        ev.preventDefault();
        void goUp();
      } else if (key === "ArrowRight") {
        ev.preventDefault();
        // 有聚焦行则进入该项；无聚焦行则按上退栈跨层重入
        if (cursor >= 0) openItem(visibleEntries[cursor]);
        else stepForward();
      } else {
        return;
      }
      ev.stopImmediatePropagation();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [
    goUp,
    openItem,
    cursor,
    visibleEntries,
    stepForward,
    startRename,
    reload,
    doUndo,
    doRedo,
    requestDelete,
    selected,
  ]);

  // 行组件的事件入口：每帧刷新为最新闭包（行组件只持有这个 ref，故 memo 命中时也不会用到旧状态）
  const rowActionsRef = useRef<RowActions>({
    attachRef: () => {},
    dragStart: () => {},
    click: () => {},
    dblclick: () => {},
    keydown: () => {},
    contextMenu: () => {},
    renameCommit: () => {},
    renameCancel: () => {},
    removeTag: () => {},
  });
  rowActionsRef.current = {
    attachRef: (el, idx) => {
      rowRefs.current[idx] = el;
    },
    dragStart,
    click: rowClick,
    dblclick: (e) => openItem(e),
    keydown: handleRowKeyDown,
    contextMenu: (ev, e) => {
      ev.stopPropagation();
      const target = ev.target as HTMLElement;
      if (target.closest(".chip")) return; // 标签 chip 交给其自身的移除逻辑
      openCtxMenu(ev.nativeEvent, e, selected);
    },
    renameCommit: () => void commitRename(),
    renameCancel: () => {
      renameCommitted.current = true;
      setRenamingIdx(null);
    },
    removeTag: (e, t) => removeTagFrom(e, t),
  };

  return (
    <div
      className="app"
      onKeyDown={handleAppKeyDown}
      onContextMenu={(e) => e.preventDefault()}
    >
      {/* 自定义标题栏（跨平台统一风格，可拖拽） */}
      <TitleBar isMac={isMac} isMax={isMax} appVersion={appVersion} />

      {/* 顶部工具栏 */}
      <header className="topbar">
        <Toolbar
          histIdx={histIdx}
          histLen={hist.length}
          canUp={!!parentOf(path)}
          goBack={goBack}
          goForward={goForward}
          goUp={goUp}
          onRefresh={() => void reload()}
          canUndo={canUndo}
          canRedo={canRedo}
          onUndo={doUndo}
          onRedo={doRedo}
          path={path}
          favorites={address.favorites}
          favOpen={address.favOpen}
          setFavOpen={address.setFavOpen}
          toggleFavorite={address.toggleFavorite}
          drives={drives}
          driveOpen={address.driveOpen}
          setDriveOpen={address.setDriveOpen}
          currentDrive={currentDrive}
          closeAllPopups={address.closeAllPopups}
          navigate={navigate}
          favWrapRef={address.favWrapRef}
          driveWrapRef={address.driveWrapRef}
        />

        <AddressBar
          path={path}
          addrEdit={address.addrEdit}
          addrValue={address.addrValue}
          setAddrValue={address.setAddrValue}
          addrRef={address.addrRef}
          addrWrapRef={address.addrWrapRef}
          beginAddrEdit={address.beginAddrEdit}
          commitAddr={address.commitAddr}
          cancelAddr={address.cancelAddr}
          histOpen={address.histOpen}
          setHistOpen={address.setHistOpen}
          addrHist={address.addrHist}
          setAddrHist={address.setAddrHist}
          histFocus={address.histFocus}
          setHistFocus={address.setHistFocus}
          histPanelRef={address.histPanelRef}
          histItemRefs={address.histItemRefs}
          histKeyNav={address.histKeyNav}
          crumbMenu={address.crumbMenu}
          setCrumbMenu={address.setCrumbMenu}
          openCrumbMenu={address.openCrumbMenu}
          closeCrumbMenuSoon={address.closeCrumbMenuSoon}
          keepCrumbMenu={address.keepCrumbMenu}
          navigate={navigate}
          isFavorite={address.isFavorite}
          toggleFavorite={address.toggleFavorite}
          closeAllPopups={address.closeAllPopups}
          showNotice={showNotice}
        />

        {/* 筛选框：位于地址栏最右侧 */}
        <div className="search-wrap">
          <IconSearch size={15} />
          <input
            className="search-input"
            autoComplete="off"
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

      {notice && (
        <div key={notice.id} className={`notice ${notice.severity}`} role={notice.severity === "error" ? "alert" : "status"}>
          <span className="notice-msg">{notice.msg}</span>
          {notice.severity === "error" && (
            <button className="notice-close" onClick={clearNotice} aria-label="关闭" title="关闭">
              <IconClose size={14} />
            </button>
          )}
        </div>
      )}

      <div className="content">
        <FileTable
          path={path}
          entries={visibleEntries}
          search={search}
          loading={loading}
          cursor={cursor}
          selected={selected}
          renamingIdx={renamingIdx}
          dissolving={dissolving}
          dragging={dragging}
          dropTarget={dropTarget}
          acceptedPath={acceptedPath}
          sortKey={sortKey}
          sortDesc={sortDesc}
          applySort={applySort}
          renameRef={renameRef}
          bodyRef={bodyRef}
          actions={rowActionsRef}
          onTableClick={(ev) => {
            // 点击空白处取消选择（点行内由行处理器接管）
            if ((ev.target as HTMLElement).closest(".row")) return;
            clearSelection();
            // 焦点交给光标行，保留方向键继续移动；无光标行时落回容器以便重新导航
            if (cursor >= 0 && cursor < visibleEntries.length) focusRow(cursor);
            else (ev.currentTarget as HTMLElement).focus();
          }}
          onTableKeyDown={handleTableKeyDown}
          onBodyContextMenu={(ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            openEmptyCtxMenu(ev.nativeEvent.clientX, ev.nativeEvent.clientY);
          }}
        />

        {/* 右侧：打标签工具 + 标签展示 */}
        <TagSidebar
          tagCounts={tagCounts}
          selectedCount={selected.size}
          onApplyTag={applyTagToSelection}
          onApplyFromSidebar={applyTagFromSidebar}
        />
      </div>

      {/* 底部状态栏 */}
      <StatusBar
        selectedCount={selected.size}
        folders={folders}
        files={files}
        dragging={dragging}
        dropTarget={dropTarget}
      />

      {/* 自定义右键菜单 */}
      {ctxMenu && (
        <ContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          paths={ctxMenu.paths}
          single={ctxMenu.single}
          allDirs={ctxMenu.allDirs}
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
              setRenamingIdx(i);
            }
          }}
          onDissolve={() => {
            const single = ctxMenu.single;
            // 多选且全为文件夹 → 逐个别解散；单选文件夹 → 单个解散
            const dirs = ctxMenu.allDirs
              ? ctxMenu.paths
              : single && single.is_dir
                ? [single.path]
                : [];
            if (!dirs.length) return;
            const label =
              dirs.length === 1 ? `「${single!.name}」` : `所选 ${dirs.length} 个文件夹`;
            closeCtxMenu();
            requestDissolve(dirs, label);
          }}
          onCollect={() => {
            const paths = ctxMenu.paths;
            if (!paths.length) return;
            closeCtxMenu();
            requestCollect(paths);
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
            copyWithNotice(single.name, "文件名");
          }}
          onCopyPath={() => {
            const single = ctxMenu.single;
            if (!single) return;
            closeCtxMenu();
            copyWithNotice(single.path, "路径");
          }}
          onDelete={() => {
            if (!ctxMenu.paths.length) return;
            const paths = ctxMenu.paths;
            closeCtxMenu();
            requestDelete(paths);
          }}
        />
      )}

      {/* 空格预览面板：右侧抽屉式浮层 */}
      <PreviewPane
        entry={previewEntry}
        onClose={() => setPreviewPath(null)}
        onNotice={(msg) => showNotice("error", msg)}
      />

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
