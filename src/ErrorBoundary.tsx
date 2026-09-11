import { Component } from "react";
import type { ErrorInfo, ReactNode } from "react";

type Props = { children: ReactNode };
type State = { error: Error | null };

/**
 * 顶层错误边界。
 * Tauri 里没有浏览器地址栏可用来自救，一旦渲染期抛异常就是永久白屏，
 * 因此这里兜底成可读提示 + 重新加载按钮（样式沿用主题令牌，不引入额外 CSS）。
 */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("界面渲染异常:", error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div
        style={{
          height: "100vh",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: "12px",
          padding: "24px",
          background: "var(--bg)",
          color: "var(--text)",
          font: "14px/1.6 system-ui, -apple-system, 'Segoe UI', sans-serif",
        }}
      >
        <div style={{ fontSize: "16px", fontWeight: 600 }}>界面出错了</div>
        <div
          style={{
            maxWidth: "560px",
            maxHeight: "40vh",
            overflow: "auto",
            color: "var(--text-2)",
            whiteSpace: "pre-wrap",
            wordBreak: "break-all",
            textAlign: "center",
          }}
        >
          {String(error)}
        </div>
        <button
          onClick={() => window.location.reload()}
          style={{
            height: "32px",
            padding: "0 14px",
            border: "1px solid var(--border-strong)",
            borderRadius: "var(--r-sm)",
            background: "var(--accent)",
            color: "var(--on-accent)",
            cursor: "pointer",
          }}
        >
          重新加载
        </button>
      </div>
    );
  }
}
