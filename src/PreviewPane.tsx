import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import type { FileEntry } from "./types";
import { previewAssetUrl, readTextPreview } from "./api";
import { IconClose } from "./icons";

// 预览支持的文件扩展名白名单（小写）
const IMG_EXT = ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico", "avif"];
const VIDEO_EXT = ["mp4", "webm", "ogg", "mov", "mkv"];
const AUDIO_EXT = ["mp3", "wav", "ogg", "flac", "m4a", "aac"];
const PDF_EXT = ["pdf"];
const TEXT_EXT = [
  "txt", "md", "markdown", "json", "js", "ts", "tsx", "jsx", "rs", "toml",
  "yaml", "yml", "xml", "html", "htm", "css", "csv", "log", "ini", "conf",
  "sh", "py", "go", "java", "c", "cpp", "h", "hpp", "cs", "rb", "php", "sql",
  "bat", "ps1", "vue", "svelte",
];

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function formatTime(sec: number): string {
  if (!sec) return "-";
  const d = new Date(sec * 1000);
  const p = (x: number) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

type PreviewPaneProps = {
  entry: FileEntry | null;
  onClose: () => void;
};

/**
 * 空格预览面板：右侧抽屉式浮层。
 * 按扩展名分发：图片/视频/音频/PDF 走 asset 协议直链，文本走后端 read_text_preview
 * （截断到 1 MiB），其他格式显示文件元信息 + 「无法预览此格式」。
 */
export default function PreviewPane({ entry, onClose }: PreviewPaneProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [textContent, setTextContent] = useState<{ text: string; truncated: boolean } | null>(null);

  // 文件切换时重新加载文本内容（仅文本类）
  useEffect(() => {
    setError("");
    setTextContent(null);
    if (!entry) return;
    const ext = entry.ext.toLowerCase();
    if (!TEXT_EXT.includes(ext)) return;
    let cancelled = false;
    setLoading(true);
    readTextPreview(entry.path)
      .then((r) => {
        if (cancelled) return;
        setTextContent(r);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [entry]);

  if (!entry) return null;

  const ext = entry.ext.toLowerCase();
  const url = previewAssetUrl(entry.path);

  let body: ReactNode;
  if (error) {
    body = <div className="preview-fallback">无法加载：{error}</div>;
  } else if (IMG_EXT.includes(ext)) {
    body = <img className="preview-media preview-img" src={url} alt={entry.name} />;
  } else if (VIDEO_EXT.includes(ext)) {
    body = <video className="preview-media" src={url} controls />;
  } else if (AUDIO_EXT.includes(ext)) {
    body = <audio className="preview-media" src={url} controls />;
  } else if (PDF_EXT.includes(ext)) {
    body = <iframe className="preview-media preview-pdf" src={url} title={entry.name} />;
  } else if (TEXT_EXT.includes(ext)) {
    body = loading ? (
      <div className="preview-loading">加载中…</div>
    ) : textContent ? (
      <pre className="preview-text">
        {textContent.text}
        {textContent.truncated && (
          <span className="preview-truncated">{"\n\n（仅显示前 1 MiB）"}</span>
        )}
      </pre>
    ) : null;
  } else {
    body = (
      <div className="preview-fallback">
        <div className="preview-meta-row">
          <span className="preview-label">名称</span>
          <span className="preview-value">{entry.name}</span>
        </div>
        <div className="preview-meta-row">
          <span className="preview-label">大小</span>
          <span className="preview-value">{formatSize(entry.size)}</span>
        </div>
        <div className="preview-meta-row">
          <span className="preview-label">修改时间</span>
          <span className="preview-value">{formatTime(entry.modified)}</span>
        </div>
        <div className="preview-meta-row">
          <span className="preview-label">类型</span>
          <span className="preview-value">{entry.ext ? `.${entry.ext}` : "未知"}</span>
        </div>
        <div className="preview-hint">无法预览此格式</div>
      </div>
    );
  }

  return (
    <aside className="preview-pane" role="complementary" aria-label="文件预览">
      <header className="preview-pane-header">
        <span className="preview-title" title={entry.name}>{entry.name}</span>
        <button
          className="preview-close"
          onClick={onClose}
          aria-label="关闭预览 (Esc)"
          title="关闭预览 (Esc)"
        >
          <IconClose />
        </button>
      </header>
      <div className="preview-body">{body}</div>
    </aside>
  );
}
