import { describe, expect, it, vi, afterEach } from "vitest";
import type { FileEntry } from "./types";
import {
  TIMEOUT,
  buildBreadcrumbs,
  dirnameOf,
  escapeHtml,
  extStyle,
  filterAndSortEntries,
  formatDate,
  formatSize,
  hitRowAtCursor,
  isEditableTarget,
  isInteractiveTarget,
  isUncPath,
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

  it("hitRowAtCursor：按窗口相对约定（物理像素 ÷ 缩放）命中", () => {
    const seen: [number, number][] = [];
    (globalThis as unknown as { document: unknown }).document = {
      elementFromPoint: (x: number, y: number) => {
        seen.push([x, y]);
        // 只有窗口相对换算后的坐标才落在行上
        return x === 100 && y === 50 ? (rowEl("C:\\a\\dir", true) as never) : null;
      },
    };
    expect(hitRowAtCursor(200, 100, { x: 999, y: 999 }, 2)).toEqual({
      path: "C:\\a\\dir",
      isDir: true,
    });
    expect(seen[0]).toEqual([100, 50]);
  });

  it("hitRowAtCursor：窗口相对失配时退回屏幕相对（减去窗口原点）", () => {
    const seen: [number, number][] = [];
    (globalThis as unknown as { document: unknown }).document = {
      elementFromPoint: (x: number, y: number) => {
        seen.push([x, y]);
        return x === 100 && y === 50 ? (rowEl("C:\\a\\dir", true) as never) : null;
      },
    };
    // 光标物理坐标是屏幕相对：窗口原点 (200,100)、scale 1 → 相对坐标 (100,50)
    expect(hitRowAtCursor(300, 150, { x: 200, y: 100 }, 1)).toEqual({
      path: "C:\\a\\dir",
      isDir: true,
    });
    expect(seen).toEqual([
      [300, 150],
      [100, 50],
    ]);
  });

  it("hitRowAtCursor：两种约定都不命中时为 null", () => {
    (globalThis as unknown as { document: unknown }).document = {
      elementFromPoint: () => null,
    };
    expect(hitRowAtCursor(10, 20, { x: 0, y: 0 }, 1)).toBeNull();
  });
});

describe("buildBreadcrumbs", () => {
  it("Windows 盘符路径逐级展开，盘符段带反斜杠", () => {
    expect(buildBreadcrumbs("C:\\Users\\me", false)).toEqual([
      { label: "C:", path: "C:\\" },
      { label: "Users", path: "C:\\Users\\" },
      { label: "me", path: "C:\\Users\\me\\" },
    ]);
  });

  it("Windows UNC 以共享为根，不把主机名当一级", () => {
    expect(buildBreadcrumbs("\\\\server\\share\\sub", false)).toEqual([
      { label: "\\\\server\\share", path: "\\\\server\\share" },
      { label: "sub", path: "\\\\server\\share\\sub" },
    ]);
  });

  it("macOS 以 / 为根逐级拼接", () => {
    expect(buildBreadcrumbs("/Users/me", true)).toEqual([
      { label: "/", path: "/" },
      { label: "Users", path: "/Users" },
      { label: "me", path: "/Users/me" },
    ]);
  });

  it("空路径回退为根", () => {
    expect(buildBreadcrumbs("", false)).toEqual([{ label: "/", path: "/" }]);
  });
});

describe("filterAndSortEntries", () => {
  function fe(name: string, isDir: boolean, size: number, modified: number): FileEntry {
    return {
      name,
      path: `C:\\tmp\\${name}`,
      is_dir: isDir,
      is_hidden: false,
      ext: name.includes(".") ? name.split(".").pop()! : "",
      base: name,
      tags: [],
      size,
      modified,
    };
  }

  const b = fe("b.txt", false, 20, 200);
  const a = fe("a.txt", false, 10, 100);
  const dir = fe("zdir", true, 0, 50);
  const list = [b, a, dir];

  it("目录始终排在文件前，名称按升序", () => {
    expect(filterAndSortEntries(list, "", "name", false).map((e) => e.name)).toEqual([
      "zdir",
      "a.txt",
      "b.txt",
    ]);
  });

  it("名称排序忽略大小写并数字感知", () => {
    const items = [fe("file10.txt", false, 0, 0), fe("file2.txt", false, 0, 0)];
    expect(filterAndSortEntries(items, "", "name", false).map((e) => e.name)).toEqual([
      "file2.txt",
      "file10.txt",
    ]);
  });

  it("大小/时间排序：降序反转，目录仍在前", () => {
    expect(filterAndSortEntries(list, "", "size", true).map((e) => e.name)).toEqual([
      "zdir",
      "b.txt",
      "a.txt",
    ]);
    expect(filterAndSortEntries(list, "", "modified", false).map((e) => e.name)).toEqual([
      "zdir",
      "a.txt",
      "b.txt",
    ]);
  });

  it("按名称子串过滤（大小写不敏感），不改变原数组", () => {
    const before = list.slice();
    expect(filterAndSortEntries(list, "A.TXT", "name", false).map((e) => e.name)).toEqual([
      "a.txt",
    ]);
    expect(list).toEqual(before);
  });
});

describe("isUncPath", () => {
  it("识别反斜杠与正斜杠两种 UNC 写法", () => {
    expect(isUncPath("\\\\server\\share")).toBe(true);
    expect(isUncPath("//server/share/file.txt")).toBe(true);
  });

  it("本地路径与相对路径不算 UNC", () => {
    expect(isUncPath("C:\\Users\\me")).toBe(false);
    expect(isUncPath("/Users/me")).toBe(false);
    expect(isUncPath("\\\\")).toBe(true); // 仅前缀也算（与后端 is_unc 一致）
    expect(isUncPath("")).toBe(false);
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
