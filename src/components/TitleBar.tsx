import { getCurrentWindow } from "@tauri-apps/api/window";
import { IconClose, IconMaximize, IconMinus, IconRestore } from "../icons";

const win = getCurrentWindow();

type TitleBarProps = {
  isMac: boolean;
  isMax: boolean;
  appVersion: string;
};

/** 自定义标题栏（跨平台统一风格，可拖拽） */
export function TitleBar({ isMac, isMax, appVersion }: TitleBarProps) {
  return (
    <header
      className="titlebar"
      data-tauri-drag-region
      onDoubleClick={(e) => {
        if ((e.target as HTMLElement).closest(".win-control, .traffic")) return;
        win.toggleMaximize();
      }}
    >
      {isMac ? (
        <div className="traffic">
          <button className="t-btn close" title="关闭" onClick={() => win.close()} />
          <button className="t-btn minimize" title="最小化" onClick={() => win.minimize()} />
          <button
            className="t-btn maximize"
            title={isMax ? "还原" : "最大化"}
            onClick={() => win.toggleMaximize()}
          />
        </div>
      ) : null}

      <div className="titlebar-id" data-tauri-drag-region>
        <span className="titlebar-mark" aria-hidden="true">
          #
        </span>
        <span className="titlebar-name" data-tauri-drag-region>
          标签匣
          {appVersion ? (
            <span className="titlebar-ver" data-tauri-drag-region>
              v{appVersion}
            </span>
          ) : null}
        </span>
      </div>

      {!isMac ? (
        <div className="win-control">
          <button title="最小化" onClick={() => win.minimize()}>
            <IconMinus size={15} />
          </button>
          <button title={isMax ? "还原" : "最大化"} onClick={() => win.toggleMaximize()}>
            {isMax ? <IconRestore size={14} /> : <IconMaximize size={13} />}
          </button>
          <button className="close" title="关闭" onClick={() => win.close()}>
            <IconClose size={15} />
          </button>
        </div>
      ) : null}
    </header>
  );
}
