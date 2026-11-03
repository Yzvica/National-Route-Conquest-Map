import { describe, expect, it } from "vitest";
import { classifyTrack } from "./layers";
import { DEFAULT_OPTIONS, matchTrack } from "./matcher";
import type { Category, LonLat, RouteData, TrackPoint } from "./types";

/**
 * 架空のデータ: 国道(東西、北緯35度)の真上(約10m北)を、東経139.02度から東は高速道路が並んで走る。
 * 高速道路は北西から斜めに来て、東経139.02度で国道の上に重なる
 */
const Y = 35.0;
const EY = 35.00009;
const STEP = 0.002; // 約180m

function line(prefix: string, from: LonLat, to: LonLat, cat: Category, route: string) {
  const n = Math.max(1, Math.round(Math.hypot(to[0] - from[0], to[1] - from[1]) / STEP));
  return Array.from({ length: n }, (_, i) => {
    const a: LonLat = [from[0] + ((to[0] - from[0]) * i) / n, from[1] + ((to[1] - from[1]) * i) / n];
    const b: LonLat = [from[0] + ((to[0] - from[0]) * (i + 1)) / n, from[1] + ((to[1] - from[1]) * (i + 1)) / n];
    return { id: `${prefix}-${i}`, routes: [route], cats: [cat], len: 180, coords: [a, b] };
  });
}

const RAMP: LonLat[] = [[139.03, Y], [139.031, Y + 0.0004], [139.0325, Y + 0.0004], [139.034, EY]];

function kokudo(): RouteData {
  return { version: 1, generatedAt: "", routes: { "1": { name: "1" } }, segments: line("w1", [139.0, Y], [139.06, Y], "main", "1"), tunnels: [] };
}

function expressway(withRamps: boolean): RouteData {
  const segments = [
    ...line("w100", [139.0, 35.02], [139.02, EY], "expressway", "東名"),
    ...line("w101", [139.02, EY], [139.06, EY], "expressway", "東名"),
  ];
  return {
    version: 1,
    kind: "expressway",
    generatedAt: "",
    routes: { 東名: { name: "東名" } },
    segments,
    tunnels: [],
    ...(withRamps
      ? {
          // 東経139.03度あたりに、国道から北へ離れて(約45m)本線へ上がる東向きのランプ
          ramps: [{ k: "in" as const, c: RAMP }],
          access: [[139.034, EY] as LonLat],
        }
      : {}),
  };
}

/** 点列 path を速度 kmh で1秒ごとに走ったログ。stopEvery m ごとに stopSec 秒止まる */
function drive(path: LonLat[], kmh: number, stopEvery = Infinity, stopSec = 40): TrackPoint[] {
  const out: TrackPoint[] = [];
  const mps = kmh / 3.6;
  let t = 0;
  let sinceStop = 0;
  for (let j = 1; j < path.length; j++) {
    const [a, b] = [path[j - 1], path[j]];
    const dx = (b[0] - a[0]) * 111_320 * Math.cos((Y * Math.PI) / 180);
    const dy = (b[1] - a[1]) * 110_950;
    const d = Math.hypot(dx, dy);
    const n = Math.ceil(d / mps);
    for (let i = 0; i < n; i++) {
      const f = i / n;
      out.push({ lon: a[0] + (b[0] - a[0]) * f, lat: a[1] + (b[1] - a[1]) * f, time: t * 1000 });
      t++;
      sinceStop += mps;
      if (sinceStop >= stopEvery) {
        for (let s = 0; s < stopSec; s++) out.push({ ...out[out.length - 1], time: t++ * 1000 });
        sinceStop = 0;
      }
    }
  }
  return out;
}

/** ログを判定して、国道・高速道路それぞれ東経 lon より東で塗った区間の数 */
function judge(track: TrackPoint[], withRamps: boolean, fromLon = 139.025) {
  const k = kokudo();
  const e = expressway(withRamps);
  const layers = classifyTrack(track, e, [k]);
  const east = (d: RouteData, c: Map<string, number>) =>
    d.segments.filter((s) => s.coords[0][0] >= fromLon && (c.get(s.id) ?? 0) > 0.5).length;
  const ck = matchTrack(k, track, DEFAULT_OPTIONS, layers);
  const ce = matchTrack(e, track, DEFAULT_OPTIONS, layers);
  const total = k.segments.filter((s) => s.coords[0][0] >= fromLon).length;
  return { kokudo: east(k, ck), expressway: east(e, ce), total, ck, ce };
}

describe("classifyTrack(高架の高速道路と下の国道)", () => {
  for (const withRamps of [true, false]) {
    const label = withRamps ? "" : "(ランプのデータがない古いデータでも)";
    it(`高速道路から高架に入ったら、下の国道は塗らない${label}`, () => {
      const track = drive([[139.0, 35.02], [139.02, EY], [139.06, EY]], 80);
      // 層を使わない今までの判定では、下の国道も塗られてしまう
      expect(matchTrack(kokudo(), track).size).toBeGreaterThan(10);
      const r = judge(track, withRamps);
      expect(r.expressway).toBe(r.total);
      expect(r.kokudo).toBe(0);
    });

    it(`下の国道を信号で止まりながら走ったら、上の高速道路は塗らない${label}`, () => {
      const track = drive([[139.0, Y], [139.06, Y]], 40, 800);
      const r = judge(track, withRamps);
      expect(r.kokudo).toBe(r.total);
      expect(r.expressway).toBe(0);
    });
  }

  it("高速道路で渋滞して何度か止まっても、高速道路のまま", () => {
    // 東経139.05度あたりで、北へ出口のランプを降りる
    const exit: LonLat[] = [[139.05, EY], [139.0515, Y + 0.0004], [139.053, Y + 0.002]];
    const e = { ...expressway(true), ramps: [{ k: "out" as const, c: exit }], access: [[139.034, EY], [139.05, EY]] as LonLat[] };
    const k = kokudo();
    const track = drive([[139.0, 35.02], [139.02, EY], ...exit], 30, 1000);
    const layers = classifyTrack(track, e, [k]);
    const ce = matchTrack(e, track, DEFAULT_OPTIONS, layers);
    const ck = matchTrack(k, track, DEFAULT_OPTIONS, layers);
    const between = (d: RouteData, c: Map<string, number>) =>
      d.segments.filter((s) => s.coords[0][0] >= 139.025 && s.coords[1][0] <= 139.05 && (c.get(s.id) ?? 0) > 0.5).length;
    const r = { expressway: between(e, ce), kokudo: between(k, ck), total: k.segments.filter((s) => s.coords[0][0] >= 139.025 && s.coords[1][0] <= 139.05).length };
    expect(r.expressway).toBe(r.total);
    expect(r.kokudo).toBe(0);
  });

  it("下の国道からランプで高架に上がったら、そこから先は高速道路だけを塗る", () => {
    const track = drive([[139.0, Y], ...RAMP, [139.06, EY]], 60);
    const r = judge(track, true, 139.036);
    expect(r.expressway).toBe(r.total);
    expect(r.kokudo).toBe(0);
    // ランプより手前の国道は走ったことにする
    expect(r.ck.get("w1-0")).toBe(1);
  });

  it("下の国道を走っていて、ランプの入口の前を通っただけなら高速道路にしない", () => {
    const track = drive([[139.0, Y], [139.06, Y]], 40, 800);
    const r = judge(track, true);
    expect(r.expressway).toBe(0);
    expect(r.kokudo).toBe(r.total);
  });

  it("道の真ん中から上がるランプ(下の道と重なっている)は、そのあと信号で止まったかで決める", () => {
    const median: LonLat[] = [[139.03, Y], [139.032, Y + 0.00004], [139.034, EY]];
    const judgeMedian = (track: TrackPoint[]) => {
      const k = kokudo();
      const e = { ...expressway(true), ramps: [{ k: "in" as const, c: median }] };
      const layers = classifyTrack(track, e, [k]);
      const ce = matchTrack(e, track, DEFAULT_OPTIONS, layers);
      const ck = matchTrack(k, track, DEFAULT_OPTIONS, layers);
      const east = (d: RouteData, c: Map<string, number>) =>
        d.segments.filter((s) => s.coords[0][0] >= 139.036 && (c.get(s.id) ?? 0) > 0.5).length;
      return { e: east(e, ce), k: east(k, ck) };
    };
    // 下の国道を信号で止まりながら走った
    expect(judgeMedian(drive([[139.0, Y], [139.06, Y]], 40, 800)).e).toBe(0);
    // ランプで上がって止まらずに走った
    const up = judgeMedian(drive([[139.0, Y], ...median, [139.06, EY]], 60));
    expect(up.k).toBe(0);
    expect(up.e).toBeGreaterThan(10);
  });

  it("国道と高速道路のデータにある同じ道(同じ way)は、どちらも塗る", () => {
    const k = kokudo();
    k.segments.push(...line("w100", [139.0, 35.02], [139.02, EY], "main", "1"));
    const e = expressway(true);
    const track = drive([[139.0, 35.02], [139.02, EY]], 80);
    const layers = classifyTrack(track, e, [k]);
    const ck = matchTrack(k, track, DEFAULT_OPTIONS, layers);
    const ce = matchTrack(e, track, DEFAULT_OPTIONS, layers);
    for (const s of e.segments.filter((x) => x.id.startsWith("w100-"))) {
      expect(ce.get(s.id)).toBe(1);
      expect(ck.get(s.id)).toBe(1);
    }
  });
});
