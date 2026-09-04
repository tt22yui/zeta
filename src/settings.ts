/** 设置集中存储：单键 JSON（zeta.settings），宽容解析 + 默认值回退。 */

export type ThemeMode = "system" | "light" | "dark";

export interface Settings {
  /** 外观：主题三态 */
  theme: ThemeMode;
  /** 历史：地址栏历史条数上限（1..100） */
  addrHistLimit: number;
  /** 历史：启动时是否恢复上次浏览路径 */
  restoreLastPath: boolean;
  /** 标签：标签分隔符（单字符，默认 #） */
  tagSeparator: string;
}

export const SETTINGS_KEY = "zeta.settings";

export const SETTINGS_DEFAULTS: Settings = {
  theme: "system",
  addrHistLimit: 30,
  restoreLastPath: true,
  tagSeparator: "#",
};

const THEME_MODES: ThemeMode[] = ["system", "light", "dark"];

/** 宽容解析本地设置：字段缺失/类型错/越界均回退默认并 clamp。 */
export function loadSettings(): Settings {
  let raw: unknown = null;
  try {
    raw = JSON.parse(window.localStorage.getItem(SETTINGS_KEY) ?? "{}");
  } catch {
    raw = null; // 损坏的 JSON 走全默认
  }
  const o = (raw ?? {}) as Record<string, unknown>;

  const theme: ThemeMode = THEME_MODES.includes(o.theme as ThemeMode)
    ? (o.theme as ThemeMode)
    : SETTINGS_DEFAULTS.theme;

  const limitRaw =
    typeof o.addrHistLimit === "number" && Number.isFinite(o.addrHistLimit)
      ? Math.round(o.addrHistLimit)
      : SETTINGS_DEFAULTS.addrHistLimit;
  const addrHistLimit = Math.min(100, Math.max(1, limitRaw));

  const restoreLastPath =
    typeof o.restoreLastPath === "boolean"
      ? o.restoreLastPath
      : SETTINGS_DEFAULTS.restoreLastPath;

  const tagSeparator =
    typeof o.tagSeparator === "string" && o.tagSeparator.trim().length > 0
      ? o.tagSeparator
      : SETTINGS_DEFAULTS.tagSeparator;

  return { theme, addrHistLimit, restoreLastPath, tagSeparator };
}

/** 持久化设置到单键 JSON。 */
export function saveSettings(s: Settings): void {
  try {
    window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch {
    // localStorage 不可用（隐私模式等）时静默忽略，不影响运行
  }
}

/** 把主题三态解析为实际渲染使用的字面量；system 依赖 matchMedia。 */
export function resolveTheme(mode: ThemeMode): "light" | "dark" {
  if (mode === "system") {
    return window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
  }
  return mode;
}

/**
 * 落地主题到 <html data-theme>，供 styles.css 的 `html[data-theme="dark"]` 覆盖生效。
 * `"light"` 与缺失时 :root 浅色自然生效，无需显式 data-theme。
 */
export function applyTheme(mode: ThemeMode): void {
  const resolved = resolveTheme(mode);
  const root = document.documentElement;
  if (resolved === "dark") {
    root.setAttribute("data-theme", "dark");
  } else {
    root.removeAttribute("data-theme");
  }
}

/** 订阅系统深浅色变化，返回注销函数。system 模式下用于实时跟随。 */
export function watchSystemTheme(handler: () => void): () => void {
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  mq.addEventListener("change", handler);
  return () => mq.removeEventListener("change", handler);
}