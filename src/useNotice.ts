import { useCallback, useEffect, useRef, useState } from "react";
import { copyText } from "./api";

/** 统一轻提示：severity 决定左侧语义色条与是否自动消失（error 常驻手动关闭） */
export type NoticeSeverity = "info" | "success" | "warning" | "error";
export type Notice = { id: number; severity: NoticeSeverity; msg: string } | null;

/**
 * 底部 Toaster 状态：info/success/warning 自动消失，error 常驻可手动关闭。
 * 调用点分散在快捷键与右键菜单，集中在一处便于统一时长与清理定时器。
 */
export function useNotice() {
  const [notice, setNotice] = useState<Notice>(null);
  const noticeTimer = useRef<number>();
  const noticeIdRef = useRef(0);

  const clearNotice = useCallback(() => {
    window.clearTimeout(noticeTimer.current);
    setNotice(null);
  }, []);

  const showNotice = useCallback((severity: NoticeSeverity, msg: string) => {
    const id = ++noticeIdRef.current;
    setNotice({ id, severity, msg });
    window.clearTimeout(noticeTimer.current);
    if (severity !== "error") {
      const dur = severity === "warning" ? 3500 : 2000;
      noticeTimer.current = window.setTimeout(() => {
        setNotice((cur) => (cur && cur.id === id ? null : cur));
      }, dur);
    }
  }, []);

  /** 复制到剪贴板并反馈失败：调用点分散在快捷键与右键菜单，统一封装避免静默失败 */
  const copyWithNotice = useCallback(
    (text: string, what: string) => {
      void copyText(text).catch((e) => showNotice("error", `复制${what}失败：${e}`));
    },
    [showNotice]
  );

  // 卸载时清掉延时器：否则卸载后回调仍会触发 setState（并可能改动已卸载组件的状态）
  useEffect(() => () => window.clearTimeout(noticeTimer.current), []);

  return { notice, clearNotice, showNotice, copyWithNotice };
}
