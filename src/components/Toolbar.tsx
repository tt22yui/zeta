import type { MutableRefObject } from "react";
import {
  IconArrowLeft,
  IconArrowRight,
  IconArrowUp,
  IconBookmark,
  IconFolder,
  IconGlobe,
  IconRedo,
  IconRefresh,
  IconSortArrow,
  IconUndo,
} from "../icons";
import { menuKeyNav } from "../menuNav";
import { isMac } from "../util";

type ToolbarProps = {
  histIdx: number;
  histLen: number;
  canUp: boolean;
  goBack: () => void;
  goForward: () => void;
  goUp: () => void;
  onRefresh: () => void;
  /** 撤销/重做可用态（来自后端 History 栈） */
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  /** 当前路径 */
  path: string;
  /** 收藏路径下拉 */
  favorites: string[];
  favOpen: boolean;
  setFavOpen: (open: boolean) => void;
  toggleFavorite: (path: string) => void;
  /** 盘符下拉 */
  drives: string[];
  driveOpen: boolean;
  setDriveOpen: (open: boolean) => void;
  currentDrive: string | null;
  /** 打开某个下拉前先收起其它下拉 */
  closeAllPopups: () => void;
  navigate: (dir: string) => void;
  favWrapRef: MutableRefObject<HTMLDivElement | null>;
  driveWrapRef: MutableRefObject<HTMLDivElement | null>;
};

/** 顶部左侧导航按钮 + 收藏 + 盘符下拉 */
export function Toolbar({
  histIdx,
  histLen,
  canUp,
  goBack,
  goForward,
  goUp,
  onRefresh,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  path,
  favorites,
  favOpen,
  setFavOpen,
  toggleFavorite,
  drives,
  driveOpen,
  setDriveOpen,
  currentDrive,
  closeAllPopups,
  navigate,
  favWrapRef,
  driveWrapRef,
}: ToolbarProps) {
  return (
    <div className="nav-btns">
      <button className="icon-btn" disabled={histIdx <= 0} onClick={goBack} title="后退" aria-label="后退">
        <IconArrowLeft size={16} />
      </button>
      <button
        className="icon-btn"
        disabled={histIdx >= histLen - 1}
        onClick={goForward}
        title="前进"
        aria-label="前进"
      >
        <IconArrowRight size={16} />
      </button>
      <button className="icon-btn" onClick={goUp} title="上一级" aria-label="上一级" disabled={!canUp}>
        <IconArrowUp size={16} />
      </button>
      <button className="icon-btn refresh-btn" onClick={onRefresh} title="刷新 (F5)" aria-label="刷新">
        <IconRefresh size={16} />
      </button>
      <button
        className="icon-btn"
        disabled={!canUndo}
        onClick={onUndo}
        title={isMac ? "撤销 (⌘Z)" : "撤销 (Ctrl+Z)"}
        aria-label="撤销"
      >
        <IconUndo size={16} />
      </button>
      <button
        className="icon-btn"
        disabled={!canRedo}
        onClick={onRedo}
        title={isMac ? "重做 (⌘⇧Z)" : "重做 (Ctrl+Shift+Z)"}
        aria-label="重做"
      >
        <IconRedo size={16} />
      </button>
      <div className="vsep" />
      <div className="fav-select" ref={favWrapRef} onKeyDown={(ev) => menuKeyNav(ev, () => setFavOpen(false))}>
        <button
          className={`icon-btn fav-trigger ${favOpen ? "active" : ""}`}
          onClick={(ev) => {
            ev.stopPropagation();
            const will = !favOpen;
            closeAllPopups();
            if (will) setFavOpen(true);
          }}
          title="收藏路径"
          aria-label="收藏路径"
          aria-haspopup="menu"
          aria-expanded={favOpen}
        >
          <IconBookmark size={16} filled={favorites.length > 0} />
        </button>
        {favOpen && (
          <div className="fav-menu" role="menu" aria-label="收藏路径">
            <div className="fav-menu-title">收藏路径</div>
            {favorites.length === 0 ? (
              <div className="fav-menu-empty">暂无收藏</div>
            ) : (
              favorites.map((p) => (
                // 行容器不承担交互：路径与删除各自是独立的 menuitem，
                // 避免此前「删除按钮（role=button）嵌套在按钮内」的非法结构与键盘不可达
                <div key={p} className={`fav-item ${p === path ? "cur" : ""}`}>
                  <button
                    role="menuitem"
                    className="fav-item-main"
                    title={p}
                    onClick={(ev) => {
                      ev.stopPropagation();
                      setFavOpen(false);
                      if (p !== path) void navigate(p);
                    }}
                  >
                    <IconFolder size={14} className="fav-item-icon" />
                    <span className="fav-item-path">{p}</span>
                  </button>
                  <button
                    role="menuitem"
                    className="fav-item-del"
                    aria-label={`从收藏中移除 ${p}`}
                    title="从收藏中移除"
                    onClick={(ev) => {
                      ev.stopPropagation();
                      toggleFavorite(p);
                    }}
                  >
                    ×
                  </button>
                </div>
              ))
            )}
          </div>
        )}
      </div>
      <div className="drive-select" ref={driveWrapRef} onKeyDown={(ev) => menuKeyNav(ev, () => setDriveOpen(false))}>
        <button
          className="drive-trigger"
          onClick={(ev) => {
            ev.stopPropagation();
            const will = !driveOpen;
            closeAllPopups();
            if (will) setDriveOpen(true);
          }}
          title={currentDrive ?? "网络位置（无盘符）"}
          aria-haspopup="menu"
          aria-expanded={driveOpen}
        >
          {currentDrive ? (
            <span>{currentDrive.replace("\\", "")}</span>
          ) : (
            <IconGlobe size={16} />
          )}
          <IconSortArrow dir="desc" size={11} className="caret" />
        </button>
        {driveOpen && (
          <div className="drive-menu" role="menu" aria-label="选择盘符">
            {drives.map((d) => (
              <button
                key={d}
                role="menuitem"
                className={`drive-item ${path.startsWith(d) ? "active" : ""}`}
                onClick={(ev) => {
                  ev.stopPropagation();
                  setDriveOpen(false);
                  navigate(d);
                }}
              >
                <span className="drive-item-label">{d.replace("\\", "")}</span>
                <span className="drive-item-path">{d}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
