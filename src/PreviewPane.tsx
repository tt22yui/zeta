import { Fragment, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Transition } from "@headlessui/react";
import { Marked } from "marked";
import DOMPurify from "dompurify";
import type { FileEntry } from "./types";
import { openInDefault, openUrlInDefault, previewAssetUrl, readTextPreview } from "./api";
import { IconClose, IconMusic, IconPause, IconPlay } from "./icons";

// 预览支持的文件扩展名白名单（小写）
const IMG_EXT = ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico", "avif"];
const VIDEO_EXT = ["mp4", "webm", "ogg", "mov", "mkv"];
const AUDIO_EXT = ["mp3", "wav", "ogg", "flac", "m4a", "aac"];
const PDF_EXT = ["pdf"];
const MD_EXT = ["md", "markdown"];
const TEXT_EXT = [
  "txt", "json", "js", "ts", "tsx", "jsx", "rs", "toml",
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
 * 基于 headlessui Dialog（非模态，不禁用列表交互）+ Transition 动画。
 * 按扩展名分发：图片/视频/音频/PDF 走 asset 协议直链，文本走后端 read_text_preview
 * （截断到 1 MiB），其他格式显示文件元信息 + 「无法预览此格式」。
 */
export default function PreviewPane({ entry, onClose }: PreviewPaneProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [textContent, setTextContent] = useState<{ text: string; truncated: boolean } | null>(null);
  // 媒体（图片/视频）加载状态：ready 触发淡入，mediaError 触发兜底提示
  const [ready, setReady] = useState(false);
  const [mediaError, setMediaError] = useState(false);
  // 记录媒体元素的 error.code/message，便于区分「文件损坏」与「编解码/容器不被支持」
  const [mediaErrorDetail, setMediaErrorDetail] = useState("");

  // 文件切换时重置并重新加载（文本走 readTextPreview，媒体靠 DOM onLoad 自驱）
  useEffect(() => {
    setError("");
    setTextContent(null);
    setReady(false);
    setMediaError(false);
    setMediaErrorDetail("");
    if (!entry) return;
    const ext = entry.ext.toLowerCase();
    if (!TEXT_EXT.includes(ext) && !MD_EXT.includes(ext)) return;
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
    // 依赖路径而非 entry 对象：reload 每次都会生成全新的 entry 对象，
    // 若按对象身份比较，任何自动刷新（UNC 轮询下每 3 秒）都会重读 1 MiB 文本。
  }, [entry?.path]);

  // Markdown 富文本：文本读取完成后渲染；失败时记录可读错误，用于回退源文本并提示定位
  const [mdHtml, setMdHtml] = useState("");
  const [mdError, setMdError] = useState("");
  useEffect(() => {
    if (!entry || !textContent) {
      setMdHtml("");
      setMdError("");
      return;
    }
    try {
      setMdHtml(renderMarkdown(textContent.text, dirnameOf(entry.path)));
      setMdError("");
    } catch (err) {
      setMdHtml("");
      setMdError(String(err));
    }
    // 同上传入路径而非对象：同路径的 entry 对象被 reload 换新时无需重新解析 Markdown
  }, [entry?.path, textContent]);

  // 媒体加载失败：按 code 给出友好提示（4=格式不支持，3=损坏，2=读取失败）
  const handleMediaError = (e: React.SyntheticEvent<HTMLMediaElement>) => {
    setMediaErrorDetail(mediaErrText(e.currentTarget.error?.code));
    setMediaError(true);
  };

  // body 内容：仅当 entry 非 null 时计算
  let body: ReactNode = null;
  if (entry) {
    const ext = entry.ext.toLowerCase();
    const url = previewAssetUrl(entry.path);

    if (error) {
      body = <div className="preview-fallback">无法加载：{error}</div>;
    } else if (mediaError) {
      body = (
        <div className="preview-fallback">
          无法加载此文件{mediaErrorDetail ? `（${mediaErrorDetail}）` : ""}
        </div>
      );
    } else if (IMG_EXT.includes(ext)) {
      body = (
        <div className="preview-stage">
          {!ready && (
            <div className="preview-stage-placeholder">
              <span className="preview-stage-spinner" aria-label="加载中" />
            </div>
          )}
          <img
            className="preview-stage-media preview-img"
            src={url}
            alt={entry.name}
            style={{ opacity: ready ? 1 : 0 }}
            onLoad={() => setReady(true)}
            onError={() => setMediaError(true)}
          />
        </div>
      );
    } else if (VIDEO_EXT.includes(ext)) {
      body = (
        <div className="preview-stage">
          {!ready && (
            <div className="preview-stage-placeholder">
              <span className="preview-stage-spinner" aria-label="加载中" />
            </div>
          )}
          <video
            className="preview-stage-media preview-video"
            src={url}
            controls
            autoPlay
            muted
            preload="metadata"
            style={{ opacity: ready ? 1 : 0 }}
            onLoadedData={() => setReady(true)}
            onError={handleMediaError}
          />
        </div>
      );
    } else if (AUDIO_EXT.includes(ext)) {
      body = (
        <div className="preview-stage preview-stage-audio">
          <AudioPlayer key={entry.path} url={url} entry={entry} />
        </div>
      );
    } else if (PDF_EXT.includes(ext)) {
      body = <iframe className="preview-media preview-pdf" src={url} title={entry.name} />;
    } else if (MD_EXT.includes(ext)) {
      // Markdown：渲染为富文本而非源文件；渲染失败时回退到源文本，避免白屏
      body = loading ? (
        <div className="preview-loading">加载中…</div>
      ) : textContent ? mdHtml ? (
        <Fragment>
          <div
            className="preview-markdown"
            onClick={(ev) => {
              const a = (ev.target as HTMLElement).closest("a");
              if (!a) return;
              // 预览里的链接不能在应用内导航：Webview 一旦跳走就回不来了（且无外部导航守卫），
              // 因此统一拦截，交给系统默认应用打开
              ev.preventDefault();
              const href = a.getAttribute("href") ?? "";
              if (!href || href.startsWith("#")) return;
              const isWeb = /^(https?:|mailto:|tel:)/i.test(href);
              void (isWeb ? openUrlInDefault(href) : openInDefault(href)).catch((err) =>
                console.error("打开链接失败:", err)
              );
            }}
            dangerouslySetInnerHTML={{ __html: mdHtml }}
          />
          {textContent.truncated && <div className="preview-markdown-note">（内容已截断，仅显示前 1 MiB）</div>}
        </Fragment>
      ) : (
        <Fragment>
          <pre className="preview-text">
            {textContent.text}
            {textContent.truncated && (
              <span className="preview-truncated">{"\n\n（仅显示前 1 MiB）"}</span>
            )}
          </pre>
          <div className="preview-markdown-note">（Markdown 渲染失败：{mdError}）</div>
        </Fragment>
      ) : null;
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
  }

  return (
    <Transition
      appear
      show={!!entry}
      as={Fragment}
      enter="zeta-preview-enter"
      enterFrom="zeta-preview-enter-from"
      enterTo="zeta-preview-enter-to"
      leave="zeta-preview-leave"
      leaveFrom="zeta-preview-leave-from"
      leaveTo="zeta-preview-leave-to"
    >
      <aside className="preview-pane" role="complementary" aria-label="文件预览">
        <header className="preview-pane-header">
          <span className="preview-title" title={entry?.name ?? ""}>{entry?.name ?? ""}</span>
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
    </Transition>
  );
}

/** 时长格式化为 mm:ss（用于音频进度展示） */
function formatDur(sec: number | undefined): string {
  if (sec == null || !Number.isFinite(sec)) return "0:00";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

// 按媒体元素 error.code 转为友好文案：4=容器/编解码不受支持，3=文件损坏，2=读取失败
function mediaErrText(code: number | undefined): string {
  switch (code) {
    case 4:
      return "该音视频格式不支持预览";
    case 3:
      return "文件损坏，无法解码";
    case 2:
      return "文件读取失败，无法预览";
    default:
      return "无法加载此文件";
  }
}

/**
 * 空格预览·音频播放器：自定义控制条 + Web Audio 实时频谱可视化。
 * 用 <audio> 做播放（隐藏默认控件），AnalyserNode 从其拉取频率数据绘制到 canvas；
 * 未播放时显示居中的音乐图标，播放后淡出并转为频谱动画。
 * 用 key 绑定文件路径：切换文件时整体卸载重建，规避 createMediaElementSource 每个元素只能调用一次的限制。
 */
function AudioPlayer({ url, entry }: { url: string; entry: FileEntry }) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [graphReady, setGraphReady] = useState(false);
  const [audioError, setAudioError] = useState("");
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState<number | undefined>(undefined);

  const ctxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const dataRef = useRef<Uint8Array<ArrayBuffer> | null>(null);
  const rafRef = useRef(0);
  const playingRef = useRef(false);

  // 组件卸载时释放音频分析资源
  useEffect(() => {
    return () => {
      cancelAnimationFrame(rafRef.current);
      playingRef.current = false;
      analyserRef.current = null;
      dataRef.current = null;
      setGraphReady(false);
      const c = ctxRef.current;
      ctxRef.current = null;
      if (c) c.close().catch(() => {});
    };
  }, []);

  // 惰性建立 <audio> → analyser → destination 分析管线；在用户「播放」手势内调用，
  // 规避自动播放策略与启动期创建异常；失败则降级为纯播放（无声频段，照常出声）
  const ensureGraph = () => {
    if (ctxRef.current) return;
    const audio = audioRef.current;
    if (!audio) return;
    try {
      const ctx = new AudioContext();
      const source = ctx.createMediaElementSource(audio);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      const data = new Uint8Array(new ArrayBuffer(analyser.frequencyBinCount));
      source.connect(analyser);
      analyser.connect(ctx.destination);
      ctxRef.current = ctx;
      analyserRef.current = analyser;
      dataRef.current = data;
      setGraphReady(true);
    } catch {
      // Web Audio 不可用：降级为纯播放控制（不报错）
    }
  };

  const stopDraw = () => {
    playingRef.current = false;
    cancelAnimationFrame(rafRef.current);
  };

  // 以 rAF 循环从 analyser 取频域数据绘制频谱柱（强调色，左低频到右高频）
  const startDraw = () => {
    if (!canvasRef.current || !analyserRef.current) return;
    playingRef.current = true;
    const g2d = canvasRef.current.getContext("2d");
    if (!g2d) return;

    const paint = () => {
      const canvas = canvasRef.current;
      const analyser = analyserRef.current;
      const data = dataRef.current;
      if (!playingRef.current || !canvas || !analyser || !data) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      const rect = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const w = Math.max(1, Math.floor(rect.width));
      const h = Math.max(1, Math.floor(rect.height));
      if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
        canvas.width = w * dpr;
        canvas.height = h * dpr;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      analyser.getByteFrequencyData(data);
      ctx.clearRect(0, 0, w, h);
      const accent =
        getComputedStyle(document.documentElement)
          .getPropertyValue("--accent")
          .trim() || "#5b5be0";
      const bars = Math.min(data.length, 48);
      const gap = 3;
      const bw = (w - gap * (bars - 1)) / bars;
      // data 从低频开始，反向取低频在前（音高感知更悦目），高低错落
      for (let i = bars - 1; i >= 0; i--) {
        const idx = Math.floor((data.length - 1) * (1 - i / bars));
        const v = data[idx] / 255;
        const bh = Math.max(1, v * h);
        ctx.fillStyle = accent;
        ctx.globalAlpha = 0.35 + 0.65 * (i / bars);
        ctx.fillRect(i * (bw + gap), h - bh, bw, bh);
      }
      ctx.globalAlpha = 1;
      rafRef.current = requestAnimationFrame(paint);
    };
    paint();
  };

  const toggle = () => {
    const audio = audioRef.current;
    if (!audio) return;
    ensureGraph();
    const ctx = ctxRef.current;
    if (ctx && ctx.state === "suspended") ctx.resume().catch(() => {});
    if (audio.paused) audio.play().catch(() => {});
    else audio.pause();
  };

  const seek = (e: { clientX: number; currentTarget: HTMLDivElement }) => {
    const audio = audioRef.current;
    if (!audio || !Number.isFinite(audio.duration)) return;
    const r = e.currentTarget.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    audio.currentTime = ratio * audio.duration;
  };

  const pct = duration ? Math.min(100, (current / duration) * 100) : 0;

  return (
    <div className="preview-audio">
      <span className="preview-audio-name" title={entry.name}>{entry.name}</span>
      <span className="preview-audio-meta">
        {formatSize(entry.size)} · {entry.ext ? `.${entry.ext}` : "未知"}
      </span>
      <div className="preview-visual" onClick={toggle} title="播放 / 暂停">
        {audioError ? (
          <span className="preview-audio-error">{audioError}</span>
        ) : (
          <>
          <IconMusic size={84} className={playing && graphReady ? "preview-audio-art hidden" : "preview-audio-art"} />
          <canvas ref={canvasRef} className="preview-visual-canvas" aria-hidden="true" />
          </>
        )}
      </div>
      <div className="preview-progress" onClick={seek}>
        <div className="preview-progress-fill" style={{ width: `${pct}%` }} />
      </div>
      <div className="preview-controls">
        <button
          className="preview-playbtn"
          onClick={toggle}
          aria-label={playing ? "暂停" : "播放"}
          title={playing ? "暂停" : "播放"}
        >
          {playing ? <IconPause size={18} /> : <IconPlay size={18} />}
        </button>
        <span className="preview-audio-time">{formatDur(current)}</span>
        <span className="preview-audio-time preview-audio-time-total">{formatDur(duration)}</span>
      </div>
      <audio
        ref={audioRef}
        src={url}
        preload="auto"
        autoPlay
        hidden
        onTimeUpdate={(e) => setCurrent(e.currentTarget.currentTime)}
        onLoadedMetadata={(e) =>
          setDuration(Number.isFinite(e.currentTarget.duration) ? e.currentTarget.duration : undefined)
        }
        onPlay={() => {
          // 注意：自动播放路径不得调用 ensureGraph。
          // createMediaElementSource 会把 <audio> 输出从扬声器改路由到 AudioContext，
          // 而自动播放下该 Context 因无用户手势处于 suspended，声音会被吞掉（表现为预览不了）。
          setPlaying(true);
          startDraw();
        }}
        onPause={() => { setPlaying(false); stopDraw(); }}
        onEnded={() => { setPlaying(false); stopDraw(); }}
        onError={(e) => setAudioError(mediaErrText(e.currentTarget.error?.code))}
      />
    </div>
  );
}

/** 取路径所在目录（兼容 Windows \ 与 macOS / 分隔符） */
function dirnameOf(p: string): string {
  const i = Math.max(p.lastIndexOf("\\"), p.lastIndexOf("/"));
  return i > 0 ? p.slice(0, i) : ".";
}

/** 目录 + 相对路径拼接为系统风格绝对路径 */
function joinPath(dir: string, rel: string): string {
  const sep = dir.includes("\\") ? "\\" : "/";
  return (dir.endsWith(sep) ? dir : dir + sep) + rel.replace(/[\\/]/g, sep);
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** 目录 -> Marked 实例：renderer 需闭包捕获「文件所在目录」，按目录缓存，避免每次渲染都重新构造 */
const MD_PARSERS = new Map<string, Marked>();

function markdownParser(dir: string): Marked {
  const cached = MD_PARSERS.get(dir);
  if (cached) return cached;
  const md = new Marked();
  // 自定义渲染：相对图片解析到文件同目录并通过 asset 协议加载；链接则按同目录解析成绝对路径
  // 注意 use({renderer}) 用 for...in 遍历，须传对象字面量（class 实例方法不可枚举，不生效）
  md.use({
    renderer: {
      image: ({ href, title, text: alt }: { href?: string; title?: string | null; text?: string }) => {
        let src = href ?? "";
        if (src && !/^(https?:|data:|#|\/|\w+:)/i.test(src)) {
          src = previewAssetUrl(joinPath(dir, src));
        }
        return `<img src="${escapeHtml(src)}" alt="${escapeHtml(alt ?? "")}"${title ? ` title="${escapeHtml(title)}"` : ""} loading="lazy">`;
      },
      link: ({ href, title, text }: { href?: string; title?: string | null; text?: string }) => {
        let url = href ?? "";
        // 无 scheme 的相对链接解析为绝对路径：点击时由系统默认应用打开（不在 Webview 内导航）
        if (url && !/^([a-z][a-z0-9+.-]*:|#|\/)/i.test(url)) {
          url = joinPath(dir, url);
        }
        return `<a href="${escapeHtml(url)}"${title ? ` title="${escapeHtml(title)}"` : ""}>${text ?? ""}</a>`;
      },
    },
  });
  if (MD_PARSERS.size >= 32) MD_PARSERS.clear(); // 防御无界增长
  MD_PARSERS.set(dir, md);
  return md;
}

/** 把 markdown 文本渲染为已净化的 HTML：相对路径图片解析到文件同目录并走 asset 协议 */
function renderMarkdown(text: string, dir: string): string {
  const raw = markdownParser(dir).parse(text) as string;
  // 预览内容来自任意本地文件，收紧默认白名单：禁止表单与可嵌入对象，降低 UI 欺骗面
  return DOMPurify.sanitize(raw, {
    FORBID_TAGS: [
      "form",
      "input",
      "button",
      "textarea",
      "select",
      "option",
      "iframe",
      "object",
      "embed",
    ],
  });
}