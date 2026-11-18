// Parts adapted from Orca (https://github.com/stablyai/orca), MIT License, Copyright (c) 2026 Lovecast Inc.
// See licenses/Orca-MIT.txt.
import type { DraftMark } from '../shared/markup';
import { badgeInk, markFont, markHalo, markPrimitives, markStyle, type Primitive } from './markup-geometry';

function path(ctx: OffscreenCanvasRenderingContext2D, shape: Primitive) {
  ctx.beginPath();
  if (shape.kind === 'ellipse') ctx.ellipse(shape.cx, shape.cy, shape.rx, shape.ry, 0, 0, 2 * Math.PI);
  else if (shape.kind === 'line') {
    ctx.moveTo(shape.x1, shape.y1);
    ctx.lineTo(shape.x2, shape.y2);
  } else if (shape.kind === 'polyline') shape.points.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  else if (shape.kind === 'rect') ctx.roundRect(shape.x, shape.y, shape.width, shape.height, shape.radius);
  else if (shape.kind === 'badge') ctx.arc(shape.cx, shape.cy, shape.r, 0, 2 * Math.PI);
}

export async function composeMarkupPng(image: HTMLImageElement, marks: DraftMark[], fileName: string): Promise<File> {
  const w = image.naturalWidth,
    h = image.naturalHeight;
  if (!w || !h) throw new Error('图片无法加载，无法标注。');
  const budget = Math.min(1, 4096 / Math.max(w, h), Math.sqrt(12_000_000 / (w * h)));
  let blob!: Blob;
  for (const step of [1, 0.75, 0.5]) {
    const width = Math.max(1, Math.floor(w * budget * step)),
      height = Math.max(1, Math.floor(h * budget * step));
    const canvas = new OffscreenCanvas(width, height),
      ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('图片无法加载，无法标注。');
    ctx.drawImage(image, 0, 0, width, height);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    const style = markStyle(Math.max(width, height));
    for (const mark of marks)
      for (const shape of markPrimitives(mark, style, width / w, { width, height })) {
        ctx.strokeStyle = markHalo(mark.color);
        ctx.lineWidth = style.stroke + 2 * style.halo;
        if (shape.kind === 'text') {
          ctx.font = markFont(shape.size);
          ctx.textAlign = 'left';
          ctx.textBaseline = 'alphabetic';
          ctx.strokeText(shape.text, shape.x, shape.y);
          ctx.fillStyle = mark.color;
          ctx.fillText(shape.text, shape.x, shape.y);
        } else if (shape.kind === 'badge') {
          path(ctx, shape);
          ctx.lineWidth = 2 * style.halo;
          ctx.stroke();
          ctx.fillStyle = mark.color;
          ctx.fill();
          ctx.font = markFont(style.font);
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillStyle = badgeInk(mark.color);
          ctx.fillText(shape.text, shape.cx, shape.cy);
        } else {
          path(ctx, shape);
          ctx.stroke();
          ctx.strokeStyle = mark.color;
          ctx.lineWidth = style.stroke;
          ctx.stroke();
        }
      }
    blob = await canvas.convertToBlob({ type: 'image/png' });
    if (blob.size <= 6 * 1024 * 1024) break;
  }
  return new File([blob], fileName, { type: 'image/png' });
}
