import { useCallback, useEffect, useState } from "react";
import { setTagSeparator } from "../api";
import { applyTheme, loadSettings, saveSettings, watchSystemTheme } from "../settings";
import type { Settings } from "../settings";

/**
 * 应用设置：单键 JSON（zeta.settings）持久化 + 主题落地 + 标签分隔符同步。
 * 设置面板开关也在此，便于 App 只做编排。
 */
export function useSettings() {
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const [settingsOpen, setSettingsOpen] = useState(false);

  // 主题落地 + system 模式跟随系统深浅色变化
  useEffect(() => {
    applyTheme(settings.theme);
    const unsub = watchSystemTheme(() => {
      if (settings.theme === "system") applyTheme("system");
    });
    return unsub;
  }, [settings.theme]);

  // 启动与变更时把标签分隔符同步到后端内存态（持久化由 zeta.settings 负责）
  useEffect(() => {
    void setTagSeparator(settings.tagSeparator).catch(() => {});
  }, [settings.tagSeparator]);

  const updateSettings = useCallback((patch: Partial<Settings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      saveSettings(next);
      return next;
    });
  }, []);

  return { settings, updateSettings, settingsOpen, setSettingsOpen };
}
