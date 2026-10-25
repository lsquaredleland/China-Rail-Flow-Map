// lib/camera: pure camera maths. The projection test checks our
// px = lon*scale + tx, py = -lat*scale + ty against deck.gl's
// OrthographicViewport (flipY: false), the contract the deck renderer relies on.
import { expect, test } from "bun:test";
import { OrthographicView } from "@deck.gl/core";
import {
  fitCountryView,
  fitExtentView,
  fitGuangzhouInitialView,
  fitHomeView,
  stationT,
  viewStateToView,
  viewToViewState,
  zoomBounds,
} from "../src/lib";

// deterministic PRNG so failures reproduce
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randView(r: () => number) {
  const W = 300 + r() * 1700;
  const H = 300 + r() * 1100;
  const scale = 5 + r() * 4000;
  return { W, H, view: { scale, tx: (r() - 0.5) * 6 * W, ty: (r() - 0.5) * 6 * H } };
}

test("view <-> viewState round trip to 1e-9 (relative)", () => {
  const r = rng(1);
  for (let i = 0; i < 500; i++) {
    const { W, H, view } = randView(r);
    const back = viewStateToView(viewToViewState(view, W, H), W, H);
    expect(Math.abs(back.scale / view.scale - 1)).toBeLessThan(1e-9);
    expect(Math.abs(back.tx - view.tx) / Math.max(1, Math.abs(view.tx))).toBeLessThan(1e-9);
    expect(Math.abs(back.ty - view.ty) / Math.max(1, Math.abs(view.ty))).toBeLessThan(1e-9);
  }
});

test("M8: viewToViewState projects like OrthographicViewport to 1e-6 px", () => {
  const r = rng(2);
  let worst = 0;
  for (let z = 0; z < 5; z++) {
    // a camera centred on China at app-range scales (about 15 to 1200)
    // (integer sizes: deck's Viewport rounds fractional width/height)
    const W = Math.round(300 + r() * 1700);
    const H = Math.round(300 + r() * 1100);
    const scale = 15 * Math.pow(80, r());
    const view = { scale, tx: W / 2 - (80 + r() * 50) * scale, ty: H / 2 + (20 + r() * 30) * scale };
    const vs = viewToViewState(view, W, H);
    const vp = new OrthographicView({ id: "map", flipY: false }).makeViewport({
      width: W,
      height: H,
      viewState: vs,
    });
    for (let i = 0; i < 1000; i++) {
      const lon = 70 + r() * 70;
      const lat = 15 + r() * 40;
      const [x, y] = vp.project([lon, lat, 0]);
      worst = Math.max(worst, Math.abs(x - (lon * view.scale + view.tx)), Math.abs(y - (-lat * view.scale + view.ty)));
    }
  }
  expect(worst).toBeLessThan(1e-6);
});

test("zoomBounds clamps at fitScale*0.55 and fitScale*60 (log2 form)", () => {
  for (const f of [3, 7.5, 31.2]) {
    const b = zoomBounds(f);
    expect(b.min).toBe(f * 0.55);
    expect(b.max).toBe(f * 60);
    expect(b.minZoom).toBeCloseTo(Math.log2(f * 0.55), 12);
    expect(b.maxZoom).toBeCloseTo(Math.log2(f * 60), 12);
  }
});

test("stationT: 0 at the national fit, 1 at max zoom, clamped", () => {
  const f = 9;
  const at = (scale: number) => stationT({ scale, tx: 0, ty: 0 }, f);
  expect(at(f)).toBe(0);
  expect(at(f * 60)).toBeCloseTo(1, 12);
  expect(at(f * 0.55)).toBe(0);
  expect(at(f * 600)).toBe(1);
  expect(at(f * Math.sqrt(60))).toBeCloseTo(0.5, 12);
});

// The pre-extraction maths from components/map/camera.ts fitExtent, verbatim.
function legacyFit(W: number, H: number, lon0: number, lat0: number, lon1: number, lat1: number, pad: number) {
  const s = Math.min(W / (lon1 - lon0), H / (lat1 - lat0)) * (pad || 0.97);
  return { scale: s, tx: (W - (lon0 + lon1) * s) / 2, ty: (H + (lat0 + lat1) * s) / 2 };
}

test("fitExtentView equals the legacy fitExtent on 100 random extents", () => {
  const r = rng(3);
  for (let i = 0; i < 100; i++) {
    const W = 300 + r() * 1700;
    const H = 300 + r() * 1100;
    const lon0 = 70 + r() * 30;
    const lat0 = 15 + r() * 15;
    const lon1 = lon0 + 1 + r() * 40;
    const lat1 = lat0 + 1 + r() * 25;
    const pad = i % 3 === 0 ? 0 : 0.9 + r() * 0.1;
    expect(fitExtentView(W, H, lon0, lat0, lon1, lat1, pad)).toEqual(legacyFit(W, H, lon0, lat0, lon1, lat1, pad));
  }
});

test("named fits use the documented extents and padding", () => {
  const W = 1200;
  const H = 800;
  const e = { lon0: 73.5, lat0: 18.1, lon1: 135.1, lat1: 53.6 };
  expect(fitCountryView(W, H, e)).toEqual(legacyFit(W, H, e.lon0, e.lat0, e.lon1, e.lat1, 0.97));
  expect(fitGuangzhouInitialView(W, H)).toEqual(legacyFit(W, H, 102.0, 20.8, 122.5, 36.8, 0.96));
  expect(fitHomeView(W, H, [113.26, 23.13])).toEqual(
    legacyFit(W, H, 113.26 - 1.7, 23.13 - 1.3, 113.26 + 1.7, 23.13 + 1.3, 0.98),
  );
});

test("fit puts the extent centre at the canvas centre", () => {
  const v = fitExtentView(1000, 600, 100, 20, 120, 40, 0.97);
  expect(v.scale * 110 + v.tx).toBeCloseTo(500, 9);
  expect(-v.scale * 30 + v.ty).toBeCloseTo(300, 9);
});
