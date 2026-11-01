import { describe, expect, it } from "vitest";
import fixture from "./__fixtures__/routes.json";
import { matchTrack } from "./matcher";
import { computeStats, percent } from "./stats";
import type { RouteData, TrackPoint } from "./types";

// 小さな架空データ: 国道1号(普通の区間 → トンネル → 国道2号との重複区間)
const data = fixture as unknown as RouteData;

/** a→b を一定間隔の点で走ったログを作る */
function drive(a: [number, number], b: [number, number], n: number, t0 = 0, sec = 3): TrackPoint[] {
  return Array.from({ length: n + 1 }, (_, i) => ({
    lon: a[0] + ((b[0] - a[0]) * i) / n,
    lat: a[1] + ((b[1] - a[1]) * i) / n,
    time: t0 + i * sec * 1000,
  }));
}

const ids = (prefix: string) => data.segments.filter((s) => s.id.startsWith(prefix)).map((s) => s.id);

describe("matchTrack", () => {
  it("道路の上を走った区間を100%にする", () => {
    const c = matchTrack(data, drive([139.0, 35.0], [139.01, 35.0], 30));
    for (const id of ids("w10-")) expect(c.get(id)).toBe(1);
    expect(ids("w12-").some((id) => c.has(id))).toBe(false);
  });

  it("GPSが少しずれていても判定する", () => {
    // 約15m北にずれたログ
    const c = matchTrack(data, drive([139.0, 35.000135], [139.01, 35.000135], 30));
    for (const id of ids("w10-")) expect(c.get(id)).toBe(1);
  });

  it("トンネル内でログが大きく飛んでも、両方の坑口を通っていれば制覇にする", () => {
    const before = drive([139.0, 35.0], [139.01, 35.0], 30, 0);
    // トンネル内は道路から300m以上離れた点が1つだけ記録されたとする
    const lost: TrackPoint = { lon: 139.015, lat: 35.006, time: before.at(-1)!.time! + 30_000 };
    const after = drive([139.02, 35.003], [139.025, 35.003], 10, lost.time! + 30_000);
    const c = matchTrack(data, [...before, lost, ...after]);
    for (const id of ids("w11-")) expect(c.get(id)).toBe(1);
  });

  it("片方の坑口にしか行っていなければトンネルは塗らない", () => {
    const c = matchTrack(data, drive([139.0, 35.0], [139.01, 35.0], 30));
    expect(ids("w11-").every((id) => !c.has(id))).toBe(true);
  });

  it("途中で引き返した区間は割合で記録する", () => {
    const c = matchTrack(data, drive([139.0, 35.0], [139.0011, 35.0], 5));
    const r = c.get("w10-0")!;
    expect(r).toBeGreaterThan(0.3);
    expect(r).toBeLessThan(0.8);
  });
});

/** 東西に走る道(国道)と、その上を南北に横切る道(高速道路)だけのデータ */
function crossing(): RouteData {
  const line = (id: string, a: [number, number], b: [number, number]) => ({
    id,
    routes: [id],
    cats: ["main" as const],
    len: 200,
    coords: [a, b],
  });
  const segs = [];
  // 1区間 約180m(0.002度)
  for (let i = 0; i < 5; i++) segs.push(line(`ew-${i}`, [139.0 + i * 0.002, 35.0], [139.002 + i * 0.002, 35.0]));
  for (let i = 0; i < 5; i++) segs.push(line(`ns-${i}`, [139.005, 34.9955 + i * 0.0018], [139.005, 34.9973 + i * 0.0018]));
  return { version: 1, generatedAt: "", routes: {}, segments: segs, tunnels: [] };
}

describe("matchTrack(交差)", () => {
  it("立体交差で横切っただけの道路は走ったことにしない", () => {
    const d = crossing();
    const c = matchTrack(d, drive([139.0, 35.0], [139.01, 35.0], 100, 0, 1));
    for (let i = 0; i < 5; i++) expect(c.get(`ew-${i}`)).toBe(1);
    for (let i = 0; i < 5; i++) expect(c.has(`ns-${i}`)).toBe(false);
  });

  it("横切った側の道路を走れば、そちらだけを走ったことにする", () => {
    const d = crossing();
    const c = matchTrack(d, drive([139.005, 34.9955], [139.005, 35.0045], 100, 0, 1));
    for (let i = 0; i < 5; i++) expect(c.get(`ns-${i}`)).toBe(1);
    for (let i = 0; i < 5; i++) expect(c.has(`ew-${i}`)).toBe(false);
  });

  it("交差点で止まっていても、横の道路を走ったことにしない", () => {
    const d = crossing();
    const go = drive([139.0, 35.0], [139.005, 35.0], 50, 0, 1);
    // 交差点で2分止まり、GPS が数mふらつく
    const stop = Array.from({ length: 120 }, (_, i) => ({
      lon: 139.005 + Math.sin(i) * 0.00005,
      lat: 35.0 + Math.cos(i * 1.3) * 0.00004,
      time: 50_000 + i * 1000,
    }));
    const on = drive([139.005, 35.0], [139.01, 35.0], 50, 171_000, 1);
    const c = matchTrack(d, [...go, ...stop, ...on]);
    for (let i = 0; i < 5; i++) expect(c.has(`ns-${i}`)).toBe(false);
  });

  it("曲がりくねった道でも、道に沿って走れば走ったことにする", () => {
    // 半径約50mで90度曲がる道
    const pts: [number, number][] = [];
    for (let k = 0; k <= 18; k++) {
      const t = (k / 18) * (Math.PI / 2);
      pts.push([139.0 + Math.sin(t) * 0.00055, 35.0 + (1 - Math.cos(t)) * 0.00045]);
    }
    const d: RouteData = {
      version: 1,
      generatedAt: "",
      routes: {},
      segments: [{ id: "curve", routes: ["1"], cats: ["main"], len: 78, coords: pts }],
      tunnels: [],
    };
    // 道の内側を約10mずれて走る
    const track = pts.map(([lon, lat], i) => ({ lon: lon - 0.00005, lat: lat + 0.00005, time: i * 1000 }));
    expect(matchTrack(d, track).get("curve")).toBe(1);
  });
});

describe("computeStats", () => {
  it("重複区間は国道ごとには丸ごと、総合では1回だけ数える", () => {
    const c = new Map(ids("w12-").map((id) => [id, 1]));
    const s = computeStats(data, c);
    expect(percent(s.byRoute.get("2")!.byCategory.overlap!)).toBeCloseTo(100);
    expect(s.byCategory.overlap.done).toBeCloseTo(s.byCategory.overlap.total);
    // この重複区間は点線国道なので、総合・路線の制覇率には入れない(参考として種別にだけ数える)
    const total = data.segments.filter((x) => !x.cats.includes("dotted")).reduce((a, x) => a + x.len, 0);
    expect(s.overall.total).toBeCloseTo(total);
    expect(s.byRoute.get("2")!.overall.total).toBe(0);
  });
});
