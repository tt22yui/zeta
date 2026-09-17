import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getVersion } from "@tauri-apps/api/app";

const win = getCurrentWindow();

/**
 * 窗口级状态与一次性副作用：启动显示、运行时版本号、最大化状态监听。
 * 窗口以 visible:false 启动，React 首帧提交后立即显示，避免白屏/跳动。
 * 注意不能用 requestAnimationFrame：隐藏窗口时 rAF 被暂停，show 不会触发
 * （后端另有 5 秒 fail-safe 兜底，见 lib.rs setup）。
 */
export function useWindowState() {
  const [isMax, setIsMax] = useState(false);
  const [appVersion, setAppVersion] = useState("");

  useEffect(() => {
    void win.show();
  }, []);

  // 读取运行时版本号，展示在标题栏品牌标识右侧
  useEffect(() => {
    getVersion()
      .then(setAppVersion)
      .catch(() => {});
  }, []);

  // 窗口最大化状态监听（用于切换 ”最大化/还原“ 图标）
  useEffect(() => {
    let mounted = true;
    win
      .isMaximized()
      .then((m) => mounted && setIsMax(m))
      .catch(() => {});
    const unlisten = win.onResized(() => {
      win.isMaximized().then((m) => mounted && setIsMax(m)).catch(() => {});
    });
    return () => {
      mounted = false;
      unlisten.then((f) => f && f()).catch(() => {});
    };
  }, []);

  return { isMax, appVersion };
}
