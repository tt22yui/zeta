import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SETTINGS_DEFAULTS, SETTINGS_KEY, loadSettings, resolveTheme, saveSettings } from "./settings";

/** 最小 localStorage/matchMedia 桩：settings.ts 在调用时才读 window，故可在 import 之后注入 */
function installWindowStub(initial: Record<string, string> = {}, dark = false) {
  const store = new Map(Object.entries(initial));
  const localStorage = {
    getItem: (k: string) => (store.has(k) ? (store.get(k) as string) : null),
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  };
  const matchMedia = (q: string) => ({
    matches: dark && q.includes("dark"),
    media: q,
    addEventListener: () => {},
    removeEventListener: () => {},
  });
  (globalThis as unknown as { window: unknown }).window = { localStorage, matchMedia };
  return { store, localStorage };
}

afterEach(() => {
  delete (globalThis as unknown as { window?: unknown }).window;
});

describe("loadSettings", () => {
  beforeEach(() => installWindowStub());

  it("无存储内容时返回默认值", () => {
    expect(loadSettings()).toEqual(SETTINGS_DEFAULTS);
  });

  it("JSON 损坏时全量回退默认值", () => {
    installWindowStub({ [SETTINGS_KEY]: "{ 坏掉的 json" });
    expect(loadSettings()).toEqual(SETTINGS_DEFAULTS);
  });

  it("字段类型错误时逐项回退", () => {
    installWindowStub({
      [SETTINGS_KEY]: JSON.stringify({
        theme: "neon",
        addrHistLimit: "多",
        restoreLastPath: "yes",
        tagSeparator: 42,
      }),
    });
    expect(loadSettings()).toEqual(SETTINGS_DEFAULTS);
  });

  it("历史条数越界时 clamp 到 1..100", () => {
    installWindowStub({ [SETTINGS_KEY]: JSON.stringify({ addrHistLimit: 0 }) });
    expect(loadSettings().addrHistLimit).toBe(1);
    installWindowStub({ [SETTINGS_KEY]: JSON.stringify({ addrHistLimit: 999 }) });
    expect(loadSettings().addrHistLimit).toBe(100);
    installWindowStub({ [SETTINGS_KEY]: JSON.stringify({ addrHistLimit: 12.6 }) });
    expect(loadSettings().addrHistLimit).toBe(13); // 四舍五入
  });

  it("分隔符为纯空白时回退默认", () => {
    installWindowStub({ [SETTINGS_KEY]: JSON.stringify({ tagSeparator: "   " }) });
    expect(loadSettings().tagSeparator).toBe(SETTINGS_DEFAULTS.tagSeparator);
  });

  it("合法自定义值被保留", () => {
    installWindowStub({
      [SETTINGS_KEY]: JSON.stringify({
        theme: "dark",
        addrHistLimit: 50,
        restoreLastPath: false,
        tagSeparator: "@",
      }),
    });
    expect(loadSettings()).toEqual({
      theme: "dark",
      addrHistLimit: 50,
      restoreLastPath: false,
      tagSeparator: "@",
    });
  });
});

describe("saveSettings", () => {
  it("以单键 JSON 写入 localStorage", () => {
    const { localStorage } = installWindowStub();
    const spy = vi.spyOn(localStorage, "setItem");
    saveSettings({ ...SETTINGS_DEFAULTS, theme: "light" });
    expect(spy).toHaveBeenCalledTimes(1);
    const [key, value] = spy.mock.calls[0];
    expect(key).toBe(SETTINGS_KEY);
    expect(JSON.parse(value as string).theme).toBe("light");
  });

  it("localStorage 不可用时静默失败（不抛错）", () => {
    (globalThis as unknown as { window: unknown }).window = {
      get localStorage() {
        throw new Error("隐私模式");
      },
    };
    expect(() => saveSettings(SETTINGS_DEFAULTS)).not.toThrow();
  });
});

describe("resolveTheme", () => {
  it("system 跟随系统深色偏好", () => {
    installWindowStub({}, true);
    expect(resolveTheme("system")).toBe("dark");
    installWindowStub({}, false);
    expect(resolveTheme("system")).toBe("light");
  });

  it("显式指定时忽略系统偏好", () => {
    installWindowStub({}, true);
    expect(resolveTheme("light")).toBe("light");
    installWindowStub({}, false);
    expect(resolveTheme("dark")).toBe("dark");
  });
});
