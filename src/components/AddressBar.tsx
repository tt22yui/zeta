import { useLayoutEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, MutableRefObject } from "react";
import { copyText, openInDefault } from "../api";
import { IconCopy, IconFolder, IconOpenExternal, IconSortArrow, IconStar } from "../icons";
import { buildBreadcrumbs, isMac } from "../util";
import type { Crumb } from "../util";
import { menuKeyNav } from "../menuNav";
import type { NoticeSeverity } from "../useNotice";

type CrumbMenu = { path: string; left: number; top: number; items: string[] } | null;

type AddressBarProps = {
  path: string;
  // 编辑态
  addrEdit: boolean;
  addrValue: string;
  setAddrValue: (v: string) => void;
  addrRef: MutableRefObject<HTMLInputElement | null>;
  addrWrapRef: MutableRefObject<HTMLDivElement | null>;
  beginAddrEdit: () => void;
  commitAddr: () => void;
  cancelAddr: () => void;
  // 访问历史下拉
  histOpen: boolean;
  setHistOpen: (open: boolean) => void;
  addrHist: string[];
  setAddrHist: (updater: (prev: string[]) => string[]) => void;
  histFocus: number;
  setHistFocus: (i: number) => void;
  histPanelRef: MutableRefObject<HTMLDivElement | null>;
  histItemRefs: MutableRefObject<(HTMLButtonElement | null)[]>;
  histKeyNav: (ev: ReactKeyboardEvent) => void;
  // 面包屑子目录下拉
  crumbMenu: CrumbMenu;
  setCrumbMenu: (m: CrumbMenu) => void;
  openCrumbMenu: (dir: string, el: HTMLElement) => void;
  closeCrumbMenuSoon: () => void;
  keepCrumbMenu: () => void;
  navigate: (dir: string) => void;
  // 收藏
  isFavorite: boolean;
  toggleFavorite: (path: string) => void;
  closeAllPopups: () => void;
  showNotice: (severity: NoticeSeverity, msg: string) => void;
};

/** 地址栏：面包屑 / 编辑输入 / 访问历史 / 子目录下钻 / 收藏与复制等快捷按钮 */
export function AddressBar({
  path,
  addrEdit,
  addrValue,
  setAddrValue,
  addrRef,
  addrWrapRef,
  beginAddrEdit,
  commitAddr,
  cancelAddr,
  histOpen,
  setHistOpen,
  addrHist,
  setAddrHist,
  histFocus,
  setHistFocus,
  histPanelRef,
  histItemRefs,
  histKeyNav,
  crumbMenu,
  setCrumbMenu,
  openCrumbMenu,
  closeCrumbMenuSoon,
  keepCrumbMenu,
  navigate,
  isFavorite,
  toggleFavorite,
  closeAllPopups,
  showNotice,
}: AddressBarProps) {
  // 长路径自适应省略：面包屑栏实际渲染容器
  const crumbbarRef = useRef<HTMLDivElement | null>(null);
  // 保存最后一栏到最右端的面包屑段数（0 表示全部展示，>0 表示超出省略中间）
  const [keepTail, setKeepTail] = useState(-1);
  const lastPathRef = useRef<string>("");

  const breadcrumbs = useMemo(() => buildBreadcrumbs(path, isMac), [path]);

  // 长路径：面包屑自适应省略中间段。路径变化先全量展示，若溢出则逐步减少尾部保留段数，
  // 直到恰好放得下，保证「当前目录」始终可见且不横向滚动。
  useLayoutEffect(() => {
    const el = crumbbarRef.current;
    if (!el) return;
    const n = breadcrumbs.length;
    if (n <= 1) return;
    if (lastPathRef.current !== path) {
      lastPathRef.current = path;
      setKeepTail(-1); // 重新走全量测量
      return;
    }
    if (el.scrollWidth <= el.clientWidth) return; // 当前保留段数已放得下
    setKeepTail((k) => Math.max(1, (k < 0 ? n - 1 : k) - 1));
  }, [breadcrumbs, path, keepTail]);

  // 长路径渲染：保留尾部文件夹（含当前目录），过长时从根/左侧省略直至放得下
  const crumbN = breadcrumbs.length;
  const crumbK = keepTail < 0 ? crumbN : Math.min(keepTail, crumbN);
  const crumbStart = Math.max(0, crumbN - crumbK);
  const crumbShow: (Crumb | null)[] = [];
  if (crumbN > 0) {
    if (crumbStart > 0) crumbShow.push(null); // 左侧省略：被裁掉的祖先段
    for (let i = crumbStart; i < crumbN; i++) crumbShow.push(breadcrumbs[i]);
  }

  return (
    <div className="addrbar" ref={addrWrapRef} onMouseLeave={closeCrumbMenuSoon}>
      {addrEdit ? (
        <input
          ref={addrRef}
          className="addr-input"
          autoComplete="off"
          value={addrValue}
          onChange={(e) => setAddrValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              if (!addrValue.trim()) {
                // 清空输入后回车：保持编辑态，光标留在输入框，不跳转不退出
                addrRef.current?.focus();
                e.preventDefault();
                return;
              }
              commitAddr();
            } else if (e.key === "Escape") cancelAddr();
          }}
          onBlur={commitAddr}
        />
      ) : (
        <>
          <div className="crumbbar" ref={crumbbarRef} onClick={beginAddrEdit} title="点击编辑地址">
            {crumbShow.map((c, i) =>
              c === null ? (
                <span className="crumb crumb-ellipsis" key="ellipsis">
                  <span className="crumb-ellipsis-dot" aria-hidden="true">
                    …
                  </span>
                  <span className="crumb-sep">{isMac ? "/" : "\\"}</span>
                </span>
              ) : (
                <span className="crumb" key={i} onMouseEnter={(ev) => openCrumbMenu(c.path, ev.currentTarget)}>
                  <button
                    className={c.path === path ? "cur" : ""}
                    onClick={(ev) => {
                      ev.stopPropagation(); // 避免冒泡到容器的进入编辑态
                      setCrumbMenu(null);
                      navigate(c.path);
                    }}
                  >
                    {c.label}
                  </button>
                  <span className="crumb-sep">{isMac ? "/" : "\\"}</span>
                </span>
              )
            )}
          </div>
          <button
            className={`addr-edit-btn ${isFavorite ? "active" : ""}`}
            disabled={!path}
            onClick={(ev) => {
              ev.stopPropagation();
              if (isFavorite) {
                toggleFavorite(path);
                showNotice("info", "已取消收藏");
              } else {
                toggleFavorite(path);
                showNotice("success", "已收藏");
              }
            }}
            title={isFavorite ? "取消收藏当前路径" : "收藏当前路径"}
            aria-label={isFavorite ? "取消收藏当前路径" : "收藏当前路径"}
            aria-pressed={isFavorite}
          >
            <IconStar size={14} filled={isFavorite} />
          </button>
          <button
            className="addr-edit-btn"
            disabled={!path}
            onClick={(ev) => {
              ev.stopPropagation();
              void copyText(path).then(
                () => showNotice("success", "已复制地址"),
                () => showNotice("error", "复制失败")
              );
            }}
            title="复制地址"
            aria-label="复制地址"
          >
            <IconCopy size={14} />
          </button>
          <button
            className="addr-edit-btn"
            disabled={!path}
            onClick={(ev) => {
              ev.stopPropagation();
              void openInDefault(path).catch(() => showNotice("error", "打开失败"));
            }}
            title="用系统资源管理器打开"
            aria-label="用系统资源管理器打开"
          >
            <IconOpenExternal size={14} />
          </button>
          <button
            className={`addr-edit-btn ${histOpen ? "active" : ""}`}
            onClick={(ev) => {
              ev.stopPropagation();
              const will = !histOpen;
              closeAllPopups();
              if (will) setHistOpen(true);
            }}
            title="浏览访问历史"
            aria-label="浏览访问历史"
            aria-haspopup="menu"
            aria-expanded={histOpen}
          >
            <IconSortArrow dir="desc" size={12} className="caret" />
          </button>
          {histOpen && (
            <div
              className="addr-hist"
              role="menu"
              aria-label="最近的路径"
              tabIndex={-1}
              ref={histPanelRef}
              onKeyDown={histKeyNav}
            >
              <div className="addr-hist-title">最近的路径</div>
              {addrHist.length === 0 ? (
                <div className="addr-hist-empty">暂无记录</div>
              ) : (
                addrHist.map((p, i) => (
                  <button
                    key={p}
                    ref={(el) => {
                      histItemRefs.current[i] = el;
                    }}
                    role="menuitem"
                    tabIndex={histFocus === i ? 0 : -1}
                    className={`addr-hist-item ${p === path ? "cur" : ""} ${histFocus === i ? "focused" : ""}`}
                    onMouseEnter={(ev) => {
                      setHistFocus(i);
                      ev.currentTarget.focus({ preventScroll: true });
                    }}
                    onClick={(ev) => {
                      ev.stopPropagation();
                      setHistOpen(false);
                      if (p !== path) void navigate(p);
                    }}
                    title={p}
                  >
                    <IconFolder size={14} className="addr-hist-icon" />
                    <span className="addr-hist-path">{p}</span>
                    <span
                      className="addr-hist-del"
                      role="button"
                      tabIndex={-1}
                      aria-label={`从历史中移除 ${p}`}
                      title="从历史中移除"
                      onClick={(ev) => {
                        ev.stopPropagation();
                        setAddrHist((prev) => {
                          const next = prev.filter((x) => x !== p);
                          try {
                            localStorage.setItem("zeta.addrHist", JSON.stringify(next));
                          } catch {
                            /* 忽略 */
                          }
                          return next;
                        });
                      }}
                    >
                      ×
                    </span>
                  </button>
                ))
              )}
            </div>
          )}
          {crumbMenu && (
            <div
              className="crumb-menu"
              style={{ left: crumbMenu.left, top: crumbMenu.top }}
              role="menu"
              aria-label="子文件夹"
              onMouseEnter={keepCrumbMenu}
              onMouseLeave={closeCrumbMenuSoon}
              onKeyDown={(ev) => menuKeyNav(ev, () => setCrumbMenu(null))}
              onClick={(ev) => ev.stopPropagation()}
            >
              <div className="crumb-menu-title">{crumbMenu.path}</div>
              {crumbMenu.items.length === 0 ? (
                <div className="crumb-menu-empty">无子文件夹</div>
              ) : (
                crumbMenu.items.map((sub) => (
                  <button
                    key={sub}
                    className="crumb-menu-item"
                    role="menuitem"
                    onClick={() => {
                      setCrumbMenu(null);
                      if (sub !== path) void navigate(sub);
                    }}
                    title={sub}
                  >
                    <IconFolder size={14} className="crumb-menu-icon" />
                    <span className="crumb-menu-name">{sub.split(/\\|\//).filter(Boolean).pop()}</span>
                  </button>
                ))
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
