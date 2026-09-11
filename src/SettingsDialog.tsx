import { useEffect, useState } from "react";
import { Dialog, DialogBackdrop, DialogPanel, DialogTitle, Transition } from "@headlessui/react";
import { ConfirmDialog } from "./Dialog";
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

  const [sepDraft, setSepDraft] = useState(settings.tagSeparator);
  const [sepPending, setSepPending] = useState<string | null>(null);

  // 每次打开或外部生效值变化时，重置草稿与待确认态
  useEffect(() => {
    if (open) {
      setSepDraft(settings.tagSeparator);
      setSepPending(null);
    }
  }, [open, settings.tagSeparator]);

  // 输入即触发确认：与当前生效值不同且非空时，弹警告框等待确认
  const onSepInput = (value: string) => {
    setSepDraft(value);
    const next = value.trim();
    if (!next || next === settings.tagSeparator) return;
    setSepPending(next);
  };

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
                <div
                  className="theme-seg"
                  role="radiogroup"
                  aria-label="主题"
                  onKeyDown={(ev) => {
                    // 单选组约定：方向键切换并同步聚焦，Home/End 跳首尾
                    const i = THEME_OPTIONS.findIndex((o) => o.value === settings.theme);
                    const cur = i < 0 ? 0 : i;
                    const last = THEME_OPTIONS.length - 1;
                    let next = -1;
                    if (ev.key === "ArrowRight" || ev.key === "ArrowDown") next = (cur + 1) % THEME_OPTIONS.length;
                    else if (ev.key === "ArrowLeft" || ev.key === "ArrowUp") next = (cur - 1 + THEME_OPTIONS.length) % THEME_OPTIONS.length;
                    else if (ev.key === "Home") next = 0;
                    else if (ev.key === "End") next = last;
                    if (next < 0) return;
                    ev.preventDefault();
                    onChange({ theme: THEME_OPTIONS[next].value });
                    ev.currentTarget
                      .querySelectorAll<HTMLButtonElement>('[role="radio"]')
                      [next]?.focus();
                  }}
                >
                  {THEME_OPTIONS.map((opt) => (
                    <button
                      key={opt.value}
                      role="radio"
                      aria-checked={settings.theme === opt.value}
                      tabIndex={settings.theme === opt.value ? 0 : -1}
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
                  value={sepDraft}
                  onChange={(e) => onSepInput(e.target.value)}
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

            <ConfirmDialog
              open={sepPending !== null}
              danger
              title="修改标签分隔符？"
              confirmLabel="修改"
              message={
                `分隔符将从 “${settings.tagSeparator}” 改为 “${sepPending ?? settings.tagSeparator}”。\n` +
                "修改后，已用旧分隔符标记的标签将不再被识别，可能显示为普通文件名。"
              }
              onConfirm={() => {
                const next = sepPending ?? settings.tagSeparator;
                setSepPending(null);
                setSepDraft(next);
                onChange({ tagSeparator: next });
              }}
              onCancel={() => {
                setSepPending(null);
                setSepDraft(settings.tagSeparator);
              }}
            />
          </DialogPanel>
        </div>
      </Dialog>
    </Transition>
  );
}