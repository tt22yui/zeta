import { useCallback, useEffect, useRef, useState } from "react";
import type { MutableRefObject } from "react";
import { canRedo, canUndo, redo, undo } from "../api";
import type { NoticeSeverity } from "../useNotice";

type Params = {
  reload: () => Promise<unknown>;
  showNotice: (severity: NoticeSeverity, msg: string) => void;
  /** 标记本应用发起的操作时刻，让紧随其后的 watch 自动刷新跳过 */
  selfOpAt: MutableRefObject<number>;
};

/**
 * 撤销/重做：维护可用态（后端 History 栈），并暴露 undo/redo 动作。
 * 可用态刷新时机：挂载时、撤销/重做前后；其余变更操作由调用方在完成后调用 refresh()。
 */
export function useHistory({ reload, showNotice, selfOpAt }: Params) {
  const [canUndoState, setCanUndoState] = useState(false);
  const [canRedoState, setCanRedoState] = useState(false);
  // 防并发：连续快捷键不叠加执行
  const busyRef = useRef(false);

  const refresh = useCallback(async () => {
    try {
      const [u, r] = await Promise.all([canUndo(), canRedo()]);
      setCanUndoState(u);
      setCanRedoState(r);
    } catch {
      /* 后端未就绪时忽略，按钮保持当前态 */
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const run = useCallback(
    async (kind: "undo" | "redo") => {
      if (busyRef.current) return;
      busyRef.current = true;
      selfOpAt.current = Date.now();
      try {
        if (kind === "undo") await undo();
        else await redo();
        await reload();
        await refresh();
        showNotice("success", kind === "undo" ? "已撤销" : "已重做");
      } catch (e) {
        showNotice("error", String(e));
        // 失败会把条目放回栈：可用态以最新为准
        await refresh();
      } finally {
        busyRef.current = false;
      }
    },
    [reload, refresh, showNotice, selfOpAt]
  );

  const doUndo = useCallback(() => void run("undo"), [run]);
  const doRedo = useCallback(() => void run("redo"), [run]);

  return { canUndo: canUndoState, canRedo: canRedoState, refresh, undo: doUndo, redo: doRedo };
}
