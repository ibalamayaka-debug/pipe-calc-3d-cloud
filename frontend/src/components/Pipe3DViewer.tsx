import React, { useCallback, useEffect, useRef, useState } from 'react';
import '@kitware/vtk.js/Rendering/Profiles/Geometry';
import vtkGenericRenderWindow from '@kitware/vtk.js/Rendering/Misc/GenericRenderWindow';
import vtkXMLPolyDataReader from '@kitware/vtk.js/IO/XML/XMLPolyDataReader';
import vtkPolyData from '@kitware/vtk.js/Common/DataModel/PolyData';
import vtkPoints from '@kitware/vtk.js/Common/Core/Points';
import vtkCellArray from '@kitware/vtk.js/Common/Core/CellArray';
import vtkDataArray from '@kitware/vtk.js/Common/Core/DataArray';
import vtkMapper from '@kitware/vtk.js/Rendering/Core/Mapper';
import vtkActor from '@kitware/vtk.js/Rendering/Core/Actor';
import vtkColorTransferFunction from '@kitware/vtk.js/Rendering/Core/ColorTransferFunction';
import { ColorMode, ScalarMode } from '@kitware/vtk.js/Rendering/Core/Mapper/Constants';
import { Box, Compass, Layers, Pause, Play, Scissors } from 'lucide-react';
import { TRANSLATIONS, type Lang } from '../i18n';
import type { FieldId, PaletteId, PipeCalcResponse } from '../types';

interface Props {
  lang: Lang;
  result: PipeCalcResponse | null;
  field: FieldId;
  palette: PaletteId;
  showWall: boolean;
  wallOpacity: number;
  cutaway: boolean;
  onToggleCutaway: () => void;
  showLong: boolean;
  showCross: boolean;
  showStreams: boolean;
  showEdges: boolean;
  playing: boolean;
  onTogglePlay: () => void;
  loading: boolean;
}

type RGB = [number, number, number];
const RAINBOW_STOPS: Array<[number, RGB]> = [
  [0.0, [20, 62, 204]],
  [0.24, [0, 176, 245]],
  [0.48, [34, 204, 102]],
  [0.72, [250, 212, 24]],
  [0.88, [249, 115, 22]],
  [1.0, [220, 28, 38]],
];
const THERMAL_STOPS: Array<[number, RGB]> = [
  [0.0, [26, 20, 56]],
  [0.25, [110, 28, 124]],
  [0.52, [214, 68, 54]],
  [0.78, [249, 152, 24]],
  [1.0, [254, 248, 178]],
];
const RAINBOW_CSS = 'linear-gradient(90deg, #143ecc 0%, #00b0f5 24%, #22cc66 48%, #fad418 72%, #f97316 88%, #dc1c26 100%)';
const THERMAL_CSS = 'linear-gradient(90deg, #1a1438 0%, #6e1c7c 25%, #d64436 52%, #f99818 78%, #fef8b2 100%)';
const STEPS = 54;
const SIDES = 5;

interface StreamLine { pts: Float32Array; u: Float32Array; nrm: Float32Array; bnm: Float32Array; phase: number; waves: number; }
interface AnimStream { lines: StreamLine[]; poly: ReturnType<typeof vtkPolyData.newInstance>; cols: Uint8Array; colArr: ReturnType<typeof vtkDataArray.newInstance>; }

function sampleStops(stops: Array<[number, RGB]>, tRaw: number): RGB {
  const t = Math.min(Math.max(tRaw, 0), 1);
  let s0 = stops[0], s1 = stops[stops.length - 1];
  for (let i = 0; i < stops.length - 1; i++) {
    if (t >= stops[i][0] && t <= stops[i + 1][0]) { s0 = stops[i]; s1 = stops[i + 1]; break; }
  }
  const f = (t - s0[0]) / Math.max(s1[0] - s0[0], 1e-6);
  return [s0[1][0] + (s1[1][0] - s0[1][0]) * f, s0[1][1] + (s1[1][1] - s0[1][1]) * f, s0[1][2] + (s1[1][2] - s0[1][2]) * f];
}

function applyStops(lut: ReturnType<typeof vtkColorTransferFunction.newInstance>, stops: Array<[number, RGB]>, lo: number, hi: number) {
  lut.removeAllPoints();
  const span = Math.max(hi - lo, 1e-5);
  for (const [pos, [r, g, b]] of stops) lut.addRGBPoint(lo + pos * span, r / 255, g / 255, b / 255);
  lut.setMappingRange(lo, hi);
  lut.updateRange();
}

function parseVtp(buf: ArrayBuffer) {
  const r = vtkXMLPolyDataReader.newInstance();
  r.parseAsArrayBuffer(buf);
  return r.getOutputData(0);
}

function makeCutawayWall(fullPoly: ReturnType<typeof vtkPolyData.newInstance>) {
  const pts = fullPoly.getPoints().getData() as Float32Array;
  const polys = fullPoly.getPolys().getData() as Uint32Array;
  const outPolys: number[] = [];
  let i = 0;
  while (i < polys.length) {
    const n = polys[i];
    let zSum = 0;
    for (let k = 1; k <= n; k++) zSum += pts[polys[i + k] * 3 + 2];
    if (zSum / n <= 0.0005) {
      outPolys.push(n);
      for (let k = 1; k <= n; k++) outPolys.push(polys[i + k]);
    }
    i += n + 1;
  }
  const cut = vtkPolyData.newInstance();
  cut.shallowCopy(fullPoly);
  const ca = vtkCellArray.newInstance();
  ca.setData(new Uint32Array(outPolys));
  cut.setPolys(ca);
  return cut;
}

function activeRange(poly: ReturnType<typeof vtkPolyData.newInstance>, field: string): [number, number] {
  const arr = poly.getPointData().getArrayByName(field) || poly.getPointData().getArrayByName('U_mag');
  if (!arr) return [0.05, 1];
  const sorted = Array.from(arr.getData() as Float32Array).sort((a, b) => a - b);
  const n = sorted.length;
  if (n < 10) return [sorted[0] ?? 0, sorted[n - 1] ?? 1];
  if (field === 'p_pa') {
    const lo = sorted[Math.floor(n * 0.01)];
    const hi = sorted[Math.floor(n * 0.99)];
    return hi > lo ? [lo, hi] : [lo, lo + 1];
  }
  const hi = Math.max(sorted[Math.floor(n * 0.99)], 1e-4);
  const thr = hi * 0.015;
  let lo = sorted[0];
  for (let i = 0; i < n; i++) { if (sorted[i] > thr) { lo = sorted[i]; break; } }
  if (lo >= hi * 0.9) lo = hi * 0.04;
  return [lo, hi];
}

function buildAnimStreams(rawPoly: ReturnType<typeof parseVtp>, tubeR: number): AnimStream {
  const rawPts = rawPoly.getPoints().getData() as Float32Array | Float64Array;
  const rawLines = rawPoly.getLines().getData() as Uint32Array | Int32Array;
  const rawUArr = rawPoly.getPointData().getArrayByName('U_mag');
  const rawU = rawUArr ? (rawUArr.getData() as Float32Array | Float64Array) : null;
  const lines: StreamLine[] = [];
  let cursor = 0, lc = 0;
  while (cursor < rawLines.length) {
    const n = rawLines[cursor++];
    if (n < 4) { cursor += n; continue; }
    const sCum = new Float32Array(n);
    for (let k = 1; k < n; k++) {
      const i0 = rawLines[cursor + k - 1], i1 = rawLines[cursor + k];
      sCum[k] = sCum[k - 1] + Math.hypot(rawPts[i1 * 3] - rawPts[i0 * 3], rawPts[i1 * 3 + 1] - rawPts[i0 * 3 + 1], rawPts[i1 * 3 + 2] - rawPts[i0 * 3 + 2]);
    }
    const tot = sCum[n - 1];
    if (tot <= 1e-5) { cursor += n; continue; }
    const pts = new Float32Array(STEPS * 3), uVals = new Float32Array(STEPS);
    let seg = 0;
    for (let s = 0; s < STEPS; s++) {
      const tt = (s / (STEPS - 1)) * tot;
      while (seg < n - 2 && sCum[seg + 1] < tt) seg++;
      const f = Math.min(Math.max((tt - sCum[seg]) / Math.max(sCum[seg + 1] - sCum[seg], 1e-8), 0), 1);
      const i0 = rawLines[cursor + seg], i1 = rawLines[cursor + seg + 1];
      pts[s * 3] = rawPts[i0 * 3] + (rawPts[i1 * 3] - rawPts[i0 * 3]) * f;
      pts[s * 3 + 1] = rawPts[i0 * 3 + 1] + (rawPts[i1 * 3 + 1] - rawPts[i0 * 3 + 1]) * f;
      pts[s * 3 + 2] = rawPts[i0 * 3 + 2] + (rawPts[i1 * 3 + 2] - rawPts[i0 * 3 + 2]) * f;
      uVals[s] = (rawU ? rawU[i0] : 1) + ((rawU ? rawU[i1] : 1) - (rawU ? rawU[i0] : 1)) * f;
    }
    const nrm = new Float32Array(STEPS * 3), bnm = new Float32Array(STEPS * 3);
    let nx = 0, ny = 0, nz = 1;
    for (let s = 0; s < STEPS; s++) {
      const sp = Math.max(0, s - 1), sn = Math.min(STEPS - 1, s + 1);
      let tx = pts[sn * 3] - pts[sp * 3], ty = pts[sn * 3 + 1] - pts[sp * 3 + 1], tz = pts[sn * 3 + 2] - pts[sp * 3 + 2];
      const tl = Math.hypot(tx, ty, tz) || 1;
      tx /= tl; ty /= tl; tz /= tl;
      if (s === 0) {
        const uy = Math.abs(tz) > 0.9 ? 1 : 0, uz = Math.abs(tz) > 0.9 ? 0 : 1, d = uy * ty + uz * tz;
        nx = -d * tx; ny = uy - d * ty; nz = uz - d * tz;
      } else {
        const d = nx * tx + ny * ty + nz * tz;
        nx -= d * tx; ny -= d * ty; nz -= d * tz;
      }
      const nl = Math.hypot(nx, ny, nz) || 1;
      nx /= nl; ny /= nl; nz /= nl;
      nrm[s * 3] = nx; nrm[s * 3 + 1] = ny; nrm[s * 3 + 2] = nz;
      bnm[s * 3] = ty * nz - tz * ny; bnm[s * 3 + 1] = tz * nx - tx * nz; bnm[s * 3 + 2] = tx * ny - ty * nx;
    }
    const h = Math.sin((lc + 1) * 12.9898) * 43758.5453;
    lines.push({ pts, u: uVals, nrm, bnm, phase: h - Math.floor(h), waves: 2.5 + (lc % 3) * 0.25 });
    lc++; cursor += n;
  }
  const nL = lines.length, vpl = STEPS * SIDES;
  const ptsBuf = new Float32Array(nL * vpl * 3), cols = new Uint8Array(nL * vpl * 4);
  const polys = new Uint32Array(nL * (STEPS - 1) * SIDES * 2 * 4);
  let pi = 0;
  for (let l = 0; l < nL; l++) {
    const bv = l * vpl;
    for (let s = 0; s < STEPS - 1; s++) {
      const r0 = bv + s * SIDES, r1 = bv + (s + 1) * SIDES;
      for (let k = 0; k < SIDES; k++) {
        const kn = (k + 1) % SIDES;
        polys[pi++] = 3; polys[pi++] = r0 + k; polys[pi++] = r0 + kn; polys[pi++] = r1 + kn;
        polys[pi++] = 3; polys[pi++] = r0 + k; polys[pi++] = r1 + kn; polys[pi++] = r1 + k;
      }
    }
  }
  const ct = new Float32Array(SIDES), stbl = new Float32Array(SIDES);
  for (let k = 0; k < SIDES; k++) { const a = (k / SIDES) * Math.PI * 2; ct[k] = Math.cos(a) * tubeR; stbl[k] = Math.sin(a) * tubeR; }
  let off = 0;
  for (const l of lines) for (let s = 0; s < STEPS; s++) {
    const p3 = s * 3;
    for (let k = 0; k < SIDES; k++) {
      ptsBuf[off++] = l.pts[p3] + l.nrm[p3] * ct[k] + l.bnm[p3] * stbl[k];
      ptsBuf[off++] = l.pts[p3 + 1] + l.nrm[p3 + 1] * ct[k] + l.bnm[p3 + 1] * stbl[k];
      ptsBuf[off++] = l.pts[p3 + 2] + l.nrm[p3 + 2] * ct[k] + l.bnm[p3 + 2] * stbl[k];
    }
  }
  const poly = vtkPolyData.newInstance();
  const vpts = vtkPoints.newInstance(); vpts.setData(ptsBuf, 3); poly.setPoints(vpts);
  const vpol = vtkCellArray.newInstance(); vpol.setData(polys); poly.setPolys(vpol);
  const colArr = vtkDataArray.newInstance({ name: 'StreamRGBA', values: cols, numberOfComponents: 4 });
  poly.getPointData().setScalars(colArr);
  return { lines, poly, cols, colArr };
}

function updateStreamColors(st: AnimStream, tSec: number, uMin: number, uMax: number, pal: PaletteId) {
  const stops = pal === 'rainbow' ? RAINBOW_STOPS : THERMAL_STOPS;
  const span = Math.max(uMax - uMin, 1e-4);
  let off = 0;
  for (const l of st.lines) for (let s = 0; s < STEPS; s++) {
    const tf = s / (STEPS - 1);
    const [br, bg, bb] = sampleStops(stops, (l.u[s] - uMin) / span);
    const rp = tf * l.waves - tSec * 0.55 + l.phase;
    const cyc = rp - Math.floor(rp);
    const pulse = cyc > 0.34 ? (cyc < 0.9 ? Math.pow((cyc - 0.34) / 0.56, 2) : 1 - ((cyc - 0.9) / 0.1) * 0.2) : 0;
    const edge = Math.min(tf * 12, (1 - tf) * 10, 1);
    const r = Math.min(255, (br + (255 - br) * pulse * 0.42) | 0);
    const g = Math.min(255, (bg + (255 - bg) * pulse * 0.42) | 0);
    const b = Math.min(255, (bb + (255 - bb) * pulse * 0.42) | 0);
    const a = Math.min(255, ((68 + pulse * 187) * edge) | 0);
    for (let k = 0; k < SIDES; k++) { st.cols[off++] = r; st.cols[off++] = g; st.cols[off++] = b; st.cols[off++] = a; }
  }
  st.colArr.modified();
}

const vtpCache = new Map<string, ArrayBuffer>();
async function getVtp(url: string) {
  const hit = vtpCache.get(url);
  if (hit) return hit;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`VTP fetch failed (${res.status})`);
  const buf = await res.arrayBuffer();
  vtpCache.set(url, buf);
  return buf;
}

export const Pipe3DViewer: React.FC<Props> = ({
  lang, result, field, palette, showWall, wallOpacity, cutaway, onToggleCutaway, showLong, showCross, showStreams, showEdges, playing, onTogglePlay, loading,
}) => {
  const t = TRANSLATIONS[lang];
  const langRef = useRef(lang); langRef.current = lang;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const clockRef = useRef(0);
  const stRef = useRef({ palette, showStreams, playing }); stRef.current = { palette, showStreams, playing };
  const [meshStatus, setMeshStatus] = useState('');
  const [range, setRange] = useState<[number, number]>([0.1, 2.0]);

  const sceneRef = useRef<{
    grw: ReturnType<typeof vtkGenericRenderWindow.newInstance>;
    wallActor: ReturnType<typeof vtkActor.newInstance>; wallMapper: ReturnType<typeof vtkMapper.newInstance>;
    longActor: ReturnType<typeof vtkActor.newInstance>; longMapper: ReturnType<typeof vtkMapper.newInstance>;
    crossActor: ReturnType<typeof vtkActor.newInstance>; crossMapper: ReturnType<typeof vtkMapper.newInstance>;
    streamActor: ReturnType<typeof vtkActor.newInstance>; streamMapper: ReturnType<typeof vtkMapper.newInstance>;
    sliceLut: ReturnType<typeof vtkColorTransferFunction.newInstance>;
    longPoly: ReturnType<typeof vtkPolyData.newInstance> | null;
    wallFullPoly: ReturnType<typeof vtkPolyData.newInstance> | null;
    wallCutPoly: ReturnType<typeof vtkPolyData.newInstance> | null;
    animStream: AnimStream | null;
    uBounds: [number, number];
    loaded: boolean;
  } | null>(null);

  const setCam = useCallback((mode: 'iso' | 'side' | 'inlet', res: PipeCalcResponse | null) => {
    const s = sceneRef.current;
    if (!s || !res) return;
    const ren = s.grw.getRenderer();
    const cam = ren.getActiveCamera();
    const L = res.metrics.kpis.l_sim_m;
    const D = res.metrics.kpis.diameter_m;
    const isElbow = res.metrics.params.geometry === 'elbow';
    if (isElbow) {
      const rb = 2.0 * D;
      cam.setFocalPoint(rb * 0.3, rb * 0.25, 0);
      if (mode === 'side') cam.setPosition(rb * 0.3, rb * 0.25, L * 1.15);
      else if (mode === 'inlet') cam.setPosition(-L * 0.45, rb * 1.1, L * 0.35);
      else cam.setPosition(-L * 0.25, -L * 0.35, L * 0.65);
    } else {
      cam.setFocalPoint(L * 0.5, 0, 0);
      if (mode === 'side') cam.setPosition(L * 0.5, 0, L * 0.85);
      else if (mode === 'inlet') cam.setPosition(-L * 0.18, -D * 2.2, D * 1.8);
      else cam.setPosition(L * 0.28, -L * 0.52, L * 0.38);
    }
    cam.setViewUp(0, 1, 0);
    ren.resetCameraClippingRange();
    s.grw.getRenderWindow().render();
  }, []);

  const syncVisuals = useCallback(() => {
    const s = sceneRef.current;
    if (!s || !s.loaded || !s.longPoly) return;
    const [lo, hi] = activeRange(s.longPoly, field);
    setRange([lo, hi]);
    const stops = palette === 'rainbow' ? RAINBOW_STOPS : THERMAL_STOPS;
    applyStops(s.sliceLut, stops, lo, hi);
    for (const m of [s.longMapper, s.crossMapper]) {
      m.setColorByArrayName(field);
      m.setScalarRange(lo, hi);
    }
    const wp = cutaway ? s.wallCutPoly : s.wallFullPoly;
    if (wp) {
      const hasField = Boolean(wp.getPointData().getArrayByName(field));
      const wField = hasField ? field : 'p_pa';
      const [wlo, whi] = hasField ? [lo, hi] : activeRange(wp, 'p_pa');
      s.wallMapper.setInputData(wp);
      s.wallMapper.setColorByArrayName(wField);
      s.wallMapper.setScalarRange(wlo, whi);
    }
    s.wallActor.getProperty().setOpacity(wallOpacity);
    s.wallActor.setVisibility(showWall);
    s.longActor.setVisibility(showLong);
    s.crossActor.setVisibility(showCross);
    s.wallActor.getProperty().setEdgeVisibility(showEdges);
    s.longActor.getProperty().setEdgeVisibility(showEdges);
    if (s.animStream) updateStreamColors(s.animStream, clockRef.current, s.uBounds[0], s.uBounds[1], palette);
    s.streamActor.setVisibility(showStreams);
    s.grw.getRenderWindow().render();
  }, [field, palette, showWall, wallOpacity, cutaway, showLong, showCross, showStreams, showEdges]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    let disposed = false;
    const grw = vtkGenericRenderWindow.newInstance({ background: [0.102, 0.08, 0.065] });
    grw.setContainer(el); grw.resize();
    const ren = grw.getRenderer();
    const sliceLut = vtkColorTransferFunction.newInstance();

    const mkActor = (lut: ReturnType<typeof vtkColorTransferFunction.newInstance>, opacity: number, lighting: boolean, arrName?: string) => {
      const m = vtkMapper.newInstance();
      m.setLookupTable(lut); m.setColorMode(ColorMode.MAP_SCALARS);
      m.setScalarMode(ScalarMode.USE_POINT_FIELD_DATA); m.setScalarVisibility(true);
      if (arrName) m.setColorByArrayName(arrName);
      const a = vtkActor.newInstance(); a.setMapper(m); a.setVisibility(false);
      a.getProperty().setOpacity(opacity); a.getProperty().setLighting(lighting);
      a.getProperty().setAmbient(0.36); a.getProperty().setDiffuse(0.68); a.getProperty().setSpecular(0.32); a.getProperty().setSpecularPower(22);
      a.getProperty().setEdgeColor(0.16, 0.11, 0.08);
      ren.addActor(a);
      return [a, m] as const;
    };
    const [wallActor, wallMapper] = mkActor(sliceLut, 0.90, true, 'U_mag');
    const [longActor, longMapper] = mkActor(sliceLut, 0.90, false);
    const [crossActor, crossMapper] = mkActor(sliceLut, 0.96, false);

    const streamMapper = vtkMapper.newInstance();
    streamMapper.setColorMode(ColorMode.DIRECT_SCALARS); streamMapper.setScalarMode(ScalarMode.USE_POINT_DATA); streamMapper.setScalarVisibility(true);
    const streamActor = vtkActor.newInstance(); streamActor.setMapper(streamMapper); streamActor.setVisibility(false); streamActor.getProperty().setLighting(false);
    ren.addActor(streamActor);

    sceneRef.current = { grw, wallActor, wallMapper, longActor, longMapper, crossActor, crossMapper, streamActor, streamMapper, sliceLut, longPoly: null, wallFullPoly: null, wallCutPoly: null, animStream: null, uBounds: [0.1, 2], loaded: false };
    const ro = new ResizeObserver(() => { if (!disposed) grw.resize(); });
    ro.observe(el);

    let rafId = 0, lastTs = performance.now();
    const tick = (ts: number) => {
      if (disposed) return;
      const dt = Math.min((ts - lastTs) / 1000, 0.05); lastTs = ts;
      const s = sceneRef.current, st = stRef.current;
      if (s && s.loaded && st.playing && st.showStreams && s.animStream) {
        clockRef.current += dt;
        updateStreamColors(s.animStream, clockRef.current, s.uBounds[0], s.uBounds[1], st.palette);
        s.grw.getRenderWindow().render();
      }
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => { disposed = true; cancelAnimationFrame(rafId); ro.disconnect(); try { grw.delete(); } catch {} sceneRef.current = null; };
  }, []);

  useEffect(() => {
    if (!result || !sceneRef.current) return;
    let cancelled = false;
    (async () => {
      setMeshStatus(TRANSLATIONS[langRef.current].loadingVtp);
      try {
        const [wb, lb, cb, sb] = await Promise.all([
          getVtp(result.urls.wall), getVtp(result.urls.slice_long), getVtp(result.urls.slice_cross), getVtp(result.urls.streamlines),
        ]);
        if (cancelled || !sceneRef.current) return;
        const s = sceneRef.current;
        const wallFullPoly = parseVtp(wb), longPoly = parseVtp(lb), crossPoly = parseVtp(cb);
        s.wallFullPoly = wallFullPoly;
        s.wallCutPoly = makeCutawayWall(wallFullPoly);
        s.longPoly = longPoly;
        s.longMapper.setInputData(longPoly); s.crossMapper.setInputData(crossPoly);

        const [uLo, uHi] = activeRange(longPoly, 'U_mag');
        s.uBounds = [uLo, uHi];
        const anim = buildAnimStreams(parseVtp(sb), result.metrics.kpis.diameter_m * 0.024);
        s.animStream = anim; s.streamMapper.setInputData(anim.poly);
        s.loaded = true;
        syncVisuals();
        setCam('iso', result);
        setMeshStatus('');
      } catch (e) {
        if (!cancelled) setMeshStatus((e as Error).message);
      }
    })();
    return () => { cancelled = true; };
  }, [result, setCam, syncVisuals]);

  useEffect(() => { if (result && sceneRef.current?.loaded) syncVisuals(); }, [result, field, palette, showWall, wallOpacity, cutaway, showLong, showCross, showStreams, showEdges, syncVisuals]);

  const dec = Math.abs(range[1] - range[0]) < 1 ? 3 : 2;
  return (
    <div className="viewer-shell">
      <div ref={containerRef} className="vtk-canvas" />
      <div className="viewer-toolbar">
        <button type="button" className={playing ? 'active' : ''} onClick={onTogglePlay}>
          {playing ? <Pause size={14} /> : <Play size={14} />} {playing ? t.pause : t.play}
        </button>
        <button type="button" className={cutaway ? 'active' : ''} onClick={onToggleCutaway}>
          <Scissors size={14} /> {cutaway ? t.fullPipeBtn : t.cutawayBtn}
        </button>
        <button type="button" onClick={() => setCam('iso', result)}><Box size={14} /> {t.camIso}</button>
        <button type="button" onClick={() => setCam('side', result)}><Layers size={14} /> {t.camSide}</button>
        <button type="button" onClick={() => setCam('inlet', result)}><Compass size={14} /> {t.camInlet}</button>
      </div>
      {result && (
        <div className="colorbars-stack">
          <div className="colorbar-card">
            <div className="colorbar-header"><span>{t.fields[field]}</span></div>
            <div className="colorbar-strip" style={{ background: palette === 'rainbow' ? RAINBOW_CSS : THERMAL_CSS }} />
            <div className="colorbar-ticks">
              {[0, 0.25, 0.5, 0.75, 1].map((f) => <span key={f}>{(range[0] + (range[1] - range[0]) * f).toFixed(dec)}</span>)}
            </div>
          </div>
        </div>
      )}
      <div className="viewer-hint">{t.hint}</div>
      {(loading || meshStatus || !result) && (
        <div className="viewer-overlay">
          {loading ? (
            <div className="spinner-card"><div className="spinner" /><h3>{t.loadingCloud}</h3><p>{t.loadingDesc}</p></div>
          ) : meshStatus ? (
            <div className="spinner-card"><div className="spinner" /><h3>{meshStatus}</h3></div>
          ) : (
            <div className="spinner-card"><h3>{t.emptyTitle}</h3></div>
          )}
        </div>
      )}
    </div>
  );
};
