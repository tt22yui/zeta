/**
 * 拖拽影像（canvas）：多选时在右下角标出「N 项」。
 * 拖拽时取 toDataURL 交给原生拖拽插件的 icon。
 * 按数量缓存，避免每次拖拽重复绘制。
 */
const DRAG_ICONS = new Map<number, HTMLCanvasElement>();

export function makeDragCanvas(count: number): HTMLCanvasElement {
  const cached = DRAG_ICONS.get(count);
  if (cached) return cached;
  const c = document.createElement("canvas");
  c.width = 72;
  c.height = 72;
  const ctx = c.getContext("2d");
  if (ctx) {
    ctx.clearRect(0, 0, 72, 72);
    // 底层两页淡色，示意多文件
    ctx.fillStyle = "rgba(120,124,150,0.5)";
    ctx.beginPath();
    ctx.roundRect(15, 27, 40, 38, 6);
    ctx.fill();
    ctx.fillStyle = "rgba(168,172,196,0.75)";
    ctx.beginPath();
    ctx.roundRect(13, 16, 40, 38, 6);
    ctx.fill();
    // 首页白底
    ctx.fillStyle = "#ffffff";
    ctx.beginPath();
    ctx.roundRect(11, 5, 40, 38, 6);
    ctx.fill();
    ctx.strokeStyle = "rgba(96,100,128,0.85)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.roundRect(11, 5, 40, 38, 6);
    ctx.stroke();
    // 内容示意线
    ctx.strokeStyle = "rgba(150,154,180,0.9)";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(19, 17);
    ctx.lineTo(43, 17);
    ctx.moveTo(19, 27);
    ctx.lineTo(39, 27);
    ctx.moveTo(19, 35);
    ctx.lineTo(39, 35);
    ctx.stroke();
    // 多选时标出数量，拖拽影像里就能看出"拖了几项"
    if (count > 1) {
      const label = count > 99 ? "99+" : String(count);
      ctx.font = "600 15px system-ui, -apple-system, 'Segoe UI', sans-serif";
      const w = ctx.measureText(label).width + 14;
      ctx.fillStyle = "#5b5be0";
      ctx.beginPath();
      ctx.roundRect(72 - w - 2, 72 - 24, w, 22, 11);
      ctx.fill();
      ctx.fillStyle = "#ffffff";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(label, 72 - w / 2 - 2, 72 - 13);
    }
  }
  if (DRAG_ICONS.size >= 32) DRAG_ICONS.clear(); // 防御无界增长
  DRAG_ICONS.set(count, c);
  return c;
}
