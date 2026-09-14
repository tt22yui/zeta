import { describe, expect, it, vi } from "vitest";
import {
  DND_MIME,
  TIMEOUT,
  dirnameOf,
  escapeHtml,
  extStyle,
  formatDate,
  formatSize,
  hasInternalDrag,
  isEditableTarget,
  isInteractiveTarget,
  joinPath,
  parentOfFor,
  readInternalDrag,
  tagColor,
  withTimeout,
  writeInternalDrag,
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

describe("内部拖拽数据（应用内移动）", () => {
  /** 最小 DataTransfer 桩：只需要 setData/getData/types/effectAllowed */
  function makeDt(types: string[] = []) {
    const store = new Map<string, string>();
    return {
      store,
      types,
      effectAllowed: "none",
      setData: (t: string, v: string) => void store.set(t, v),
      getData: (t: string) => store.get(t) ?? "",
    } as unknown as DataTransfer & { store: Map<string, string> };
  }

  it("写入后能被识别为内部拖拽，并带上纯文本兜底与 move 语义", () => {
    const dt = makeDt();
    writeInternalDrag(dt, ["C:\\a\\x.txt", "C:\\a\\y.txt"]);
    expect(dt.effectAllowed).toBe("move");
    const raw = (dt as unknown as { store: Map<string, string> }).store;
    expect(JSON.parse(raw.get(DND_MIME) as string)).toEqual(["C:\\a\\x.txt", "C:\\a\\y.txt"]);
    expect(raw.get("text/plain")).toBe("C:\\a\\x.txt\nC:\\a\\y.txt");
  });

  it("hasInternalDrag 只看 types（dragover 阶段读不到 getData）", () => {
    expect(hasInternalDrag(makeDt([DND_MIME, "text/plain"]))).toBe(true);
    expect(hasInternalDrag(makeDt(["text/plain"]))).toBe(false);
    expect(hasInternalDrag(makeDt(["Files"]))).toBe(false);
    expect(hasInternalDrag(null)).toBe(false);
  });

  it("readInternalDrag 解析出路径列表（仅 drop 阶段可用）", () => {
    const dt = makeDt();
    writeInternalDrag(dt, ["/home/u/a"]);
    expect(readInternalDrag(dt)).toEqual(["/home/u/a"]);
  });

  it("非内部拖拽、空数组、损坏 JSON、混入非字符串都返回 null", () => {
    const empty = makeDt();
    expect(readInternalDrag(empty)).toBeNull(); // 没有该 MIME
    const bad = makeDt();
    bad.setData(DND_MIME, "{坏掉的");
    expect(readInternalDrag(bad)).toBeNull();
    const notArray = makeDt();
    notArray.setData(DND_MIME, JSON.stringify({ a: 1 }));
    expect(readInternalDrag(notArray)).toBeNull();
    const mixed = makeDt();
    mixed.setData(DND_MIME, JSON.stringify(["/ok", 42]));
    expect(readInternalDrag(mixed)).toBeNull();
    const emptyList = makeDt();
    emptyList.setData(DND_MIME, JSON.stringify([]));
    expect(readInternalDrag(emptyList)).toBeNull();
    expect(readInternalDrag(null)).toBeNull();
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
