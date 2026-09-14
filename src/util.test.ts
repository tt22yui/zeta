import { describe, expect, it, vi, afterEach } from "vitest";
import {
  TIMEOUT,
  dirnameOf,
  escapeHtml,
  extStyle,
  formatDate,
  formatSize,
  isEditableTarget,
  isInteractiveTarget,
  joinPath,
  parentOfFor,
  rowAtPoint,
  tagColor,
  withTimeout,
} from "./util";

describe("formatSize", () => {
  it("0 与负数返回空串（目录/未知大小不显示）", () => {
    expect(formatSize(0)).toBe("");
    expect(formatSize(-1)).toBe("");
  });

  it("按 1024 进位并保留合适的小数位", () => {
    expect(formatSize(512)).toBe("512 B");
    expect(formatSize(1024)).toBe("1.0 KB");
    expect(formatSize(1536)).toBe("1.5 KB");
    expect(formatSize(1024 * 1024)).toBe("1.0 MB");
    expect(formatSize(1024 * 1024 * 1024)).toBe("1.0 GB");
  });

  it("大于等于 100 时去掉小数位", () => {
    expect(formatSize(Math.round(195.3 * 1024))).toBe("195 KB");
  });
});

describe("formatDate", () => {
  it("0 或未设置时返回空串", () => {
    expect(formatDate(0)).toBe("");
  });

  it("输出 YYYY-MM-DD HH:mm 且个位数补零", () => {
    const sec = 1700000000; // 具体时区无关：用本地时间构造期望值
    const d = new Date(sec * 1000);
    const p = (x: number) => String(x).padStart(2, "0");
    expect(formatDate(sec)).toBe(
      `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
    );
    expect(formatDate(sec)).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  });
});

describe("tagColor", () => {
  it("同名标签颜色稳定，且取自标签色板", () => {
    const a = tagColor("工作");
    expect(tagColor("工作")).toBe(a);
    expect(a).toMatch(/^var\(--tc-[1-6]\)$/);
  });

  it("空标签也能得到合法颜色（不抛错）", () => {
    expect(tagColor("")).toMatch(/^var\(--tc-[1-6]\)$/);
  });
});

describe("extStyle", () => {
  it("已知扩展名大小写无关", () => {
    expect(extStyle("png").label).toBe("IMG");
    expect(extStyle("PNG").label).toBe("IMG");
    expect(extStyle("Pdf").label).toBe("PDF");
  });

  it("未知扩展名取前 3 位大写，空扩展名回退 FILE", () => {
    expect(extStyle("bin").label).toBe("BIN");
    expect(extStyle("verylongext").label).toBe("VER");
    expect(extStyle("").label).toBe("FILE");
  });

  it("同一未知扩展名返回缓存对象（渲染期不再新建对象）", () => {
    expect(extStyle("zzz")).toBe(extStyle("zzz"));
  });
});

describe("parentOfFor（Windows 分支）", () => {
  it("逐级上退", () => {
    expect(parentOfFor("C:\\a\\b", false)).toBe("C:\\a");
    expect(parentOfFor("C:\\a", false)).toBe("C:\\");
    expect(parentOfFor("C:\\", false)).toBeNull();
  });

  it("UNC 共享根不可再上，其下可逐级上退", () => {
    expect(parentOfFor("\\\\server\\share", false)).toBeNull();
    expect(parentOfFor("\\\\server\\share\\dir", false)).toBe("\\\\server\\share");
  });
});

describe("parentOfFor（macOS 分支）", () => {
  it("根目录与一级目录", () => {
    expect(parentOfFor("/Users/a/b", true)).toBe("/Users/a");
    // 一级目录的上级是根目录（此前实现会返回 null，导致 macOS 上无法回退到 /）
    expect(parentOfFor("/Users", true)).toBe("/");
    expect(parentOfFor("/Applications", true)).toBe("/");
    // 根目录没有上级，避免自我循环
    expect(parentOfFor("/", true)).toBeNull();
    expect(parentOfFor("//", true)).toBeNull();
  });
});

describe("joinPath / dirnameOf", () => {
  it("按目录风格拼接相对路径并统一分隔符", () => {
    expect(joinPath("C:\\docs", "img/a.png")).toBe("C:\\docs\\img\\a.png");
    expect(joinPath("C:\\docs\\", "a.png")).toBe("C:\\docs\\a.png");
    expect(joinPath("/home/u", "img\\a.png")).toBe("/home/u/img/a.png");
  });

  it("取所在目录，纯文件名回退为当前目录", () => {
    expect(dirnameOf("C:\\docs\\a.md")).toBe("C:\\docs");
    expect(dirnameOf("/home/u/a.md")).toBe("/home/u");
    expect(dirnameOf("a.md")).toBe(".");
  });
});

describe("escapeHtml", () => {
  it("转义全部 5 个字符", () => {
    expect(escapeHtml(`<a href="x" title='y'>&`)).toBe(
      "&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;"
    );
  });
});

describe("键盘目标判定", () => {
  it("可编辑控件为 true：选择器需覆盖 input/textarea/select/contenteditable", () => {
    const seen: string[] = [];
    const hit = { closest: (s: string) => (seen.push(s), {} as never) } as unknown as HTMLElement;
    const miss = { closest: () => null } as unknown as HTMLElement;
    expect(isEditableTarget(hit)).toBe(true);
    expect(isEditableTarget(miss)).toBe(false);
    expect(seen[0]).toContain("input");
    expect(seen[0]).toContain("textarea");
    expect(seen[0]).toContain("select");
    expect(seen[0]).toContain("contenteditable");
  });

  it("自带按键语义的控件为 true", () => {
    const btn = { closest: () => ({}) as never } as unknown as HTMLElement;
    const div = { closest: () => null } as unknown as HTMLElement;
    expect(isInteractiveTarget(btn)).toBe(true);
    expect(isInteractiveTarget(div)).toBe(false);
  });
});

describe("rowAtPoint（内部拖放落点命中）", () => {
  /** 用最小 document/element 桩替代真实 DOM：只验证命中逻辑本身 */
  function installDocStub(el: unknown) {
    (globalThis as unknown as { document: unknown }).document = {
      elementFromPoint: () => el as Element | null,
    };
  }
  function rowEl(path: string | undefined, isDir: boolean) {
    // closest 命中时返回的"行元素"需要带 dataset（生产代码从中读 data-row-*）
    const row = { dataset: { rowPath: path, rowIsDir: isDir ? "1" : "0" } };
    return {
      closest: (sel: string) => (sel === "[data-row-path]" ? (row as never) : null),
    };
  }

  afterEach(() => {
    delete (globalThis as unknown as { document?: unknown }).document;
  });

  it("命中文件夹行时返回路径并标记为目录", () => {
    installDocStub(rowEl("C:\\a\\sub", true));
    expect(rowAtPoint(10, 20)).toEqual({ path: "C:\\a\\sub", isDir: true });
  });

  it("命中文件行时 isDir 为 false（调用方据此拒绝落点）", () => {
    installDocStub(rowEl("C:\\a\\f.txt", false));
    expect(rowAtPoint(10, 20)).toEqual({ path: "C:\\a\\f.txt", isDir: false });
  });

  it("落点不在列表行上时返回 null", () => {
    installDocStub({ closest: () => null, dataset: {} });
    expect(rowAtPoint(10, 20)).toBeNull();
    installDocStub(null);
    expect(rowAtPoint(10, 20)).toBeNull();
  });

  it("行元素缺少 data-row-path 时视为未命中", () => {
    installDocStub(rowEl(undefined, true));
    expect(rowAtPoint(10, 20)).toBeNull();
  });
});

describe("withTimeout", () => {
  it("按时返回时透传结果，并清掉超时定时器", async () => {
    vi.useFakeTimers();
    try {
      const p = withTimeout(Promise.resolve("ok"), 1000);
      const r = await p;
      expect(r).toBe("ok");
      // 定时器已 clearTimeout：不留悬挂句柄
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("失败（而非超时）返回 null，便于与超时区分", async () => {
    const r = await withTimeout(Promise.reject(new Error("boom")), 1000);
    expect(r).toBeNull();
  });

  it("超时返回 TIMEOUT 哨兵", async () => {
    const never = new Promise<null>(() => {});
    const r = await withTimeout(never, 5);
    expect(r).toBe(TIMEOUT);
  });

  it("调用方成功返回 null 时也是 null（不与超时混淆）", async () => {
    const r = await withTimeout(Promise.resolve(null), 1000);
    expect(r).toBeNull();
    expect(r).not.toBe(TIMEOUT);
  });
});
