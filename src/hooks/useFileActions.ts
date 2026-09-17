import { useCallback, useEffect, useRef, useState } from "react";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import {
  addTag,
  collectIntoFolder,
  deleteFile,
  dissolveFolder,
  listDir,
  removeTag,
} from "../api";
import type { FileEntry } from "../types";
import { isUncPath } from "../util";
import type { NoticeSeverity } from "../useNotice";

/** 集中式弹窗编排：null=不弹；confirm 确认框 / prompt 输入框（替代原生 confirm/prompt） */
export type DialogState =
  | {
      kind: "confirm";
      title: string;
      message: string;
      danger?: boolean;
      confirmLabel?: string;
      action: () => void;
    }
  | {
      kind: "prompt";
      title: string;
      label: string;
      defaultValue?: string;
      action: (value: string) => void;
    }
  | null;

export type CtxMenuState = {
  x: number;
  y: number;
  paths: string[];
  single: FileEntry | null;
  allDirs: boolean;
} | null;

type Params = {
  selected: Set<string>;
  setSelected: Dispatch<SetStateAction<Set<string>>>;
  entries: FileEntry[];
  reload: () => Promise<unknown>;
  showNotice: (severity: NoticeSeverity, msg: string) => void;
  clearNotice: () => void;
  selfOpAt: MutableRefObject<number>;
  selectOnly: (i: number) => void;
  setCursor: Dispatch<SetStateAction<number>>;
  closeAllPopups: () => void;
  path: string;
};

/**
 * 文件操作与弹窗编排：打/删标签、清空标签、右键菜单、解散/收入文件夹、删除到回收站。
 * 命令层只做薄封装，失败统一走 showNotice。
 */
export function useFileActions({
  selected,
  setSelected,
  entries,
  reload,
  showNotice,
  clearNotice,
  selfOpAt,
  selectOnly,
  setCursor,
  closeAllPopups,
  path,
}: Params) {
  const [ctxMenu, setCtxMenu] = useState<CtxMenuState>(null);
  const [dialog, setDialog] = useState<DialogState>(null);
  // 解散文件夹动画：正在收缩淡出的行路径集合（动画结束才真正执行解散）
  const [dissolving, setDissolving] = useState<Set<string>>(new Set());
  // 删除防并发：批量删除逐项执行时不允许叠加触发
  const deleteBusyRef = useRef(false);

  // 点击菜单外部、滚动、Esc 时关闭右键菜单（空选区菜单同样适用）
  useEffect(() => {
    if (!ctxMenu) return;
    const close = () => setCtxMenu(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    // 延迟到本次右键事件之后再注册，避免弹出即被关闭
    const deferAdd = window.setTimeout(() => window.addEventListener("click", close), 0);
    window.addEventListener("keydown", onKey);
    window.addEventListener("scroll", close, true);
    return () => {
      window.clearTimeout(deferAdd);
      window.removeEventListener("click", close);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", close, true);
    };
  }, [ctxMenu]);

  /** 打标签输入框：给选中项打标签（已含该标签的项自动忽略） */
  const applyTagToSelection = useCallback(
    async (rawTag: string) => {
      selfOpAt.current = Date.now();
      const tag = rawTag.trim();
      if (!tag || selected.size === 0) {
        showNotice("error", selected.size === 0 ? "请先在列表中选择文件" : "标签不能为空");
        return;
      }
      clearNotice();
      try {
        // addTag 返回改名后的新路径，收集用于重载后恢复选中
        const newPaths: string[] = [];
        for (const p of selected) newPaths.push(await addTag(p, tag));
        await reload();
        if (newPaths.length) setSelected(new Set(newPaths));
      } catch (e) {
        showNotice("error", String(e));
      }
    },
    [selected, reload, showNotice, clearNotice, setSelected, selfOpAt]
  );

  /** 侧栏标签点击：给所有选中项打该标签，已含该标签的项自动忽略 */
  const applyTagFromSidebar = useCallback(
    async (tag: string) => {
      if (selected.size === 0) return;
      selfOpAt.current = Date.now();
      clearNotice();
      const byPath = new Map<string, string[]>();
      for (const e of entries) byPath.set(e.path, e.tags);
      const targets = [...selected].filter((p) => !(byPath.get(p) ?? []).includes(tag));
      // 所有选中项已含该标签：无需改动，保留当前选中直接返回
      if (targets.length === 0) return;
      try {
        const newPaths: string[] = [];
        for (const p of targets) newPaths.push(await addTag(p, tag));
        await reload();
        // 重载会清空选中，用改名后的新路径恢复选中
        setSelected(new Set(newPaths));
      } catch (e) {
        showNotice("error", String(e));
      }
    },
    [selected, entries, reload, showNotice, clearNotice, setSelected, selfOpAt]
  );

  const removeTagFrom = useCallback(
    async (entry: FileEntry, tag: string) => {
      selfOpAt.current = Date.now();
      try {
        await removeTag(entry.path, tag);
        await reload();
      } catch (e) {
        showNotice("error", String(e));
      }
    },
    [reload, showNotice, selfOpAt]
  );

  // 移除目标路径的所有标签：每移除一个就改名一次，需用返回的新路径作为下一次源路径
  const clearAllTags = useCallback(
    async (paths: string[]) => {
      selfOpAt.current = Date.now();
      try {
        for (const p of paths) {
          const e = entries.find((x) => x.path === p);
          if (!e) continue;
          let cur = p;
          for (const t of e.tags) cur = await removeTag(cur, t);
        }
        await reload();
      } catch (err) {
        showNotice("error", String(err));
      }
    },
    [entries, reload, showNotice, selfOpAt]
  );

  const closeCtxMenu = useCallback(() => setCtxMenu(null), []);

  /** 列表空白处右键：弹出「刷新」等空选区菜单 */
  const openEmptyCtxMenu = useCallback(
    (x: number, y: number) => {
      closeAllPopups();
      setCtxMenu({ x, y, paths: [], single: null, allDirs: false });
    },
    [closeAllPopups]
  );

  // 打开右键菜单；行已被多选时作用于整个多选，否则作用于该单行
  const openCtxMenu = useCallback(
    (e: MouseEvent, entry: FileEntry, selectedKeys: Set<string>) => {
      e.preventDefault();
      closeAllPopups();
      const inMulti =
        selectedKeys.size > 1 && selectedKeys.has(entry.path)
          ? Array.from(selectedKeys)
          : [entry.path];
      // 多选时「解散文件夹」仅当全部为目录才可用
      const allDirs =
        inMulti.length > 1 && inMulti.every((p) => entries.find((x) => x.path === p)?.is_dir);
      setCtxMenu({ x: e.clientX, y: e.clientY, paths: inMulti, single: entry, allDirs });
    },
    [entries, closeAllPopups]
  );

  /** 解散文件夹：确认后播放收缩动画再执行（可撤销） */
  const requestDissolve = useCallback(
    (dirs: string[], label: string) => {
      if (!dirs.length) return;
      setDialog({
        kind: "confirm",
        title: "解散文件夹",
        message: `解散${label}？\n其内部子项将分别上移到当前目录，空壳被删除（可撤销）。`,
        confirmLabel: "解散",
        action: () => {
          void (async () => {
            const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
            if (!reduce) {
              setDissolving(new Set(dirs));
              await new Promise((r) => setTimeout(r, 160));
            }
            selfOpAt.current = Date.now();
            try {
              for (const p of dirs) await dissolveFolder(p);
              setDissolving(new Set());
              await reload();
            } catch (e) {
              setDissolving(new Set());
              showNotice("error", String(e));
            }
          })();
        },
      });
    },
    [reload, showNotice, selfOpAt]
  );

  /** 收入文件夹：输入名称后新建文件夹并移入，完成后选中新文件夹（可撤销） */
  const requestCollect = useCallback(
    (paths: string[]) => {
      if (!paths.length) return;
      setDialog({
        kind: "prompt",
        title: "收入到文件夹",
        label: "文件夹名",
        defaultValue: "新建文件夹",
        action: (name) => {
          const trimmed = name.trim();
          void (async () => {
            selfOpAt.current = Date.now();
            try {
              const folderPath = await collectIntoFolder(paths, trimmed);
              await reload();
              // reload 后闭包 visibleEntries 是旧值，直接 listDir 拿最新列表做下标计算
              const fresh = await listDir(path);
              const i = fresh.findIndex((e) => e.path === folderPath);
              if (i >= 0) {
                setCursor(i);
                selectOnly(i);
              }
            } catch (e) {
              showNotice("error", String(e));
            }
          })();
        },
      });
    },
    [reload, path, setCursor, selectOnly, showNotice, selfOpAt]
  );

  /** 执行删除：本地走回收站（不确认），UNC 已由 requestDelete 二次确认；批量给出进度与失败汇总 */
  const performDelete = useCallback(
    async (targets: string[]) => {
      if (targets.length === 0 || deleteBusyRef.current) return;
      deleteBusyRef.current = true;
      selfOpAt.current = Date.now();
      clearNotice();
      const unc = targets.some(isUncPath);
      const total = targets.length;
      const failed: string[] = [];
      try {
        for (let i = 0; i < total; i++) {
          if (total > 1) showNotice("info", `正在删除…（${i + 1}/${total}）`);
          try {
            await deleteFile(targets[i]);
          } catch {
            failed.push(targets[i]);
          }
        }
      } finally {
        deleteBusyRef.current = false;
      }
      await reload();
      if (failed.length === 0) {
        showNotice("success", unc ? `已永久删除 ${total} 项` : `已删除 ${total} 项到回收站`);
      } else if (failed.length === total) {
        showNotice("error", `删除失败（${failed.length} 项）`);
      } else {
        showNotice("warning", `已删除 ${total - failed.length} 项，${failed.length} 项失败`);
      }
    },
    [reload, showNotice, clearNotice, selfOpAt]
  );

  /** 请求删除：本地路径直接进回收站；含网络路径时先二次确认（永久删除不可恢复） */
  const requestDelete = useCallback(
    (paths: string[]) => {
      const targets = paths.filter(Boolean);
      if (targets.length === 0) return;
      if (targets.some(isUncPath)) {
        setDialog({
          kind: "confirm",
          title: "永久删除",
          message: `所选 ${targets.length} 项包含网络路径（UNC），删除后无法从回收站恢复，将永久删除。`,
          danger: true,
          confirmLabel: "永久删除",
          action: () => void performDelete(targets),
        });
        return;
      }
      void performDelete(targets);
    },
    [performDelete]
  );

  return {
    ctxMenu,
    openCtxMenu,
    openEmptyCtxMenu,
    closeCtxMenu,
    dialog,
    setDialog,
    dissolving,
    applyTagToSelection,
    applyTagFromSidebar,
    removeTagFrom,
    clearAllTags,
    requestDissolve,
    requestCollect,
    requestDelete,
  };
}
