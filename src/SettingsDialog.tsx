import { Dialog, DialogBackdrop, DialogPanel, DialogTitle, Transition } from "@headlessui/react";
import type { Settings, ThemeMode } from "./settings";

export type SettingsDialogProps = {
  open: boolean;
  settings: Settings;
  onChange: (patch: Partial<Settings>) => void;
  onClose: () => void;
};

const THEME_OPTIONS: { value: ThemeMode; label: string }[] = [
  { value: "system", label: "跟随系统" },
  { value: "light", label: "浅色" },
  { value: "dark", label: "深色" },
];

export function SettingsDialog(props: SettingsDialogProps) {
  const { open, settings, onChange, onClose } = props;

  return (
    <Transition appear show={open}>
      <Dialog as="div" className="zeta-dialog" onClose={onClose}>
        <DialogBackdrop className="zeta-backdrop" />
        <div className="zeta-dialog-center">
          <DialogPanel className="zeta-panel zeta-settings-panel">
            <DialogTitle className="zeta-dialog-title">设置</DialogTitle>

            {/* 外观 */}
            <section className="set-group">
              <h3 className="set-group-title">外观</h3>
              <div className="set-row">
                <span className="set-label">主题</span>
                <div className="theme-seg" role="radiogroup" aria-label="主题">
                  {THEME_OPTIONS.map((opt) => (
                    <button
                      key={opt.value}
                      role="radio"
                      aria-checked={settings.theme === opt.value}
                      className={
                        "theme-seg-item" +
                        (settings.theme === opt.value ? " selected" : "")
                      }
                      onClick={() => onChange({ theme: opt.value })}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>
            </section>

            {/* 历史 */}
            <section className="set-group">
              <h3 className="set-group-title">历史</h3>
              <div className="set-row">
                <label className="set-label" htmlFor="zeta-set-hist-limit">
                  地址栏历史条数
                </label>
                <input
                  id="zeta-set-hist-limit"
                  className="set-input"
                  type="number"
                  min={1}
                  max={100}
                  value={settings.addrHistLimit}
                  onChange={(e) => {
                    const n = Number(e.target.value);
                    if (Number.isFinite(n)) onChange({ addrHistLimit: n });
                  }}
                />
              </div>
              <div className="set-row">
                <span className="set-label">启动恢复上次路径</span>
                <button
                  role="switch"
                  aria-checked={settings.restoreLastPath}
                  className={
                    "set-toggle" + (settings.restoreLastPath ? " on" : "")
                  }
                  onClick={() =>
                    onChange({ restoreLastPath: !settings.restoreLastPath })
                  }
                >
                  <span className="set-toggle-thumb" />
                </button>
              </div>
            </section>

            {/* 标签 */}
            <section className="set-group">
              <h3 className="set-group-title">标签</h3>
              <div className="set-row">
                <label className="set-label" htmlFor="zeta-set-tag-sep">
                  标签分隔符
                </label>
                <input
                  id="zeta-set-tag-sep"
                  className="set-input set-input-sep"
                  value={settings.tagSeparator}
                  onChange={(e) => onChange({ tagSeparator: e.target.value })}
                  maxLength={2}
                />
              </div>
              <p className="set-hint">
                仅首字符生效，避开 Windows 文件名禁止字符（\ / : * ? “  &lt; &gt; |）。
              </p>
            </section>

            {/* 插件（占位） */}
            <section className="set-group">
              <h3 className="set-group-title">插件</h3>
              <p className="set-hint">插件管理即将推出</p>
            </section>

            <div className="zeta-dialog-actions">
              <button className="btn primary" onClick={onClose}>
                关闭
              </button>
            </div>
          </DialogPanel>
        </div>
      </Dialog>
    </Transition>
  );
}