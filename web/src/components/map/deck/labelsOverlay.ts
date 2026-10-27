/* City labels and the origin diamond, drawn with Canvas 2D onto the existing
   transparent `#map` canvas (D5): the same text engine and `placeLabels` as
   the former Canvas renderer, so placement is unchanged;
   glyph anti-aliasing is softer on a transparent canvas (C21). The canvas
   also stays the pointer-capturing element (D17). */
import { isTrainShown, nat, natCityR, natState, palette, placeLabels, stationT } from "../../../lib";
import type { MapCtx } from "../context";
import { nationalLabelPoints, LABEL_TRAINS_PER_UNIT } from "./layers/national";
import { glowOf, shownTrains } from "./layers/trains";

const fontOf = (fs: number, weight: string) =>
  weight +
  " " +
  fs +
  "px Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Noto Sans SC', sans-serif";

/** Clears the overlay and draws labels + origin diamond for the current view. */
export function drawLabelsOverlay(M: MapCtx) {
  const { S, P, canvasRef, points } = M;
  const canvas = canvasRef.current;
  const cur = P.current.cur;
  if (!canvas || !cur) return;
  const st = S.current;
  const w = Math.round(st.W * st.DPR);
  const h = Math.round(st.H * st.DPR);
  // resize() already sizes the canvas; assigning width clears it, so only on a mismatch.
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const dark = P.current.dark;
  const pal = palette(dark);
  ctx.setTransform(st.DPR, 0, 0, st.DPR, 0, 0);
  ctx.clearRect(0, 0, st.W, st.H);
  const national = P.current.national;
  ctx.textBaseline = "middle";
  const nothingToName = national && (!P.current.showLabels || !st.natCities);
  const labels = nothingToName ? [] : placeLabels(
    national
      ? nationalLabelPoints(P.current.atlas, st.natCities!)
      : st.unlitCities
        ? points().filter((c) => !st.unlitCities!.has(c.idx))
        : points(),
    st.view,
    st.W,
    st.H,
    (text, fs, weight) => {
      ctx.font = fontOf(fs, weight);
      const key = text + "|" + fs + "|" + weight;
      let tw = st.labelWidthCache.get(key);
      if (tw === undefined) {
        tw = ctx.measureText(text).width;
        st.labelWidthCache.set(key, tw);
      }
      return tw;
    },
    {
      origin: national ? null : { zh: cur.o.zh, en: cur.en, pt: cur.o.pt },
      radius: national ? (n) => natCityR(n * LABEL_TRAINS_PER_UNIT) : undefined,
      panelDest: P.current.panelDest ?? null,
      showDest: P.current.showLabels,
      fitScale: st.fitScale,
      sk: stationT(st.view, st.fitScale),
    },
  );
  for (const { box, style, text, x, y, align } of labels) {
    ctx.font = fontOf(style.fs, style.weight);
    if (style.isBoxed) {
      ctx.fillStyle = dark ? "#1A1B1E" : "#ffffff";
      ctx.fillRect(box.x, box.y, box.w, box.h);
      ctx.strokeStyle = dark ? "#EDEDEA" : "#111111";
      ctx.lineWidth = 1;
      ctx.strokeRect(box.x, box.y, box.w, box.h);
      ctx.fillStyle = dark ? "#EDEDEA" : "#111111";
    } else {
      ctx.fillStyle = pal.labelHalo;
      ctx.fillRect(box.x, box.y, box.w, box.h);
      ctx.fillStyle = pal.label;
    }
    ctx.textAlign = align;
    ctx.fillText(text, x, y);
  }
  if (national) {
    drawNationalTags(M, ctx);
    return;
  }
  drawTrainTags(M, ctx);
  // The origin's diamond; its disc is a deck layer (P1b.3).
  const cx = M.X(cur.o.pt[0]);
  const cy = M.Y(cur.o.pt[1]);
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(Math.PI / 4);
  ctx.fillStyle = dark ? "#1A1B1E" : "#ffffff";
  ctx.fillRect(-2.2, -2.2, 4.4, 4.4);
  ctx.restore();
}

/* The hovered / selected / isolated train's code tag (map/trains.ts), above
   the dots. The same visibility rules as the dot layer. */
function drawTrainTags(M: MapCtx, ctx: CanvasRenderingContext2D) {
  const { S, P } = M;
  const st = S.current;
  if (!st.animEnabled) return;
  const tl = M.activeTimeline();
  if (!tl) return;
  const iso = P.current.isolatedTrainCode;
  const hov = st.hover && st.hover.kind === "train" ? st.hover.train.code : null;
  const sel = P.current.selectedTrainCode;
  if (!iso && !hov && !sel) return;
  const shown = shownTrains(M.activeTrainsAt(tl, st.animTime), (c) => isTrainShown(P.current, st, st.animTime, c), iso);
  for (const tr of shown) {
    const isIsolated = iso === tr.code;
    if (!(isIsolated || hov === tr.code || sel === tr.code)) continue;
    const px = M.X(tr.lon);
    const py = M.Y(tr.lat);
    if (px < -20 || px > st.W + 20 || py < -20 || py > st.H + 20) continue;
    paintTag(ctx, px, py, isIsolated ? `${tr.code} · ${tr.progressPct}%` : tr.code, tr.cls);
  }
}

/* The code tag above a dot, in its class colour. */
function paintTag(ctx: CanvasRenderingContext2D, px: number, py: number, tagText: string, cls: string) {
  const g = glowOf(cls);
  const glow = `rgb(${g[0]},${g[1]},${g[2]})`;
  ctx.font = "bold 10px monospace";
  const tagW = ctx.measureText(tagText).width + 8;
  const tagH = 16;
  const tagX = px - tagW / 2;
  const tagY = py - 18;
  ctx.fillStyle = "rgba(15, 23, 42, 0.90)";
  ctx.beginPath();
  ctx.roundRect(tagX, tagY, tagW, tagH, 3);
  ctx.fill();
  ctx.strokeStyle = glow;
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.fillStyle = "#FFFFFF";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(tagText, px, tagY + tagH / 2);
}

/* National mode: the same tag on the hovered / selected / isolated train's dot
   (the last frame's dots, `natPick`); the isolated one also shows its progress. */
function drawNationalTags(M: MapCtx, ctx: CanvasRenderingContext2D) {
  const { S, P } = M;
  const st = S.current;
  const f = st.natPick;
  const atlas = P.current.atlas;
  if (!f || !atlas) return;
  const iso = P.current.isolatedTrainCode;
  const hov = st.hover && st.hover.kind === "train" ? st.hover.train.code : null;
  const sel = P.current.selectedTrainCode;
  if (!iso && !hov && !sel) return;
  const tt = atlas.data.train_table;
  for (let i = 0; i < f.count; i++) {
    const q = f.qOf[i];
    const row = tt[f.tl.tIdx[q]];
    if (!row || !(row.code === iso || row.code === hov || row.code === sel)) continue;
    const px = M.X(f.buf[i * 6]);
    const py = M.Y(f.buf[i * 6 + 1]);
    if (px < -20 || px > st.W + 20 || py < -20 || py > st.H + 20) continue;
    // The dot's distance along the run, for the isolated train's progress.
    const total = f.tl.total[q];
    let pct = "";
    if (row.code === iso && total > 0) {
      let j = i;
      while (j > 0 && f.qOf[j - 1] === q) j--;
      natState(f.tl, q, f.m + 1440 * (Math.ceil((f.tl.start[q] - f.m) / 1440) + (i - j)));
      pct = ` · ${Math.round((nat.dist / total) * 100)}%`;
    }
    paintTag(ctx, px, py, row.code + pct, row.class);
  }
}
