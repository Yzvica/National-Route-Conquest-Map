import { describe, expect, it } from "vitest";
import { distance } from "./geo";
import { fillTunnels, speedProfile, type FillRoad } from "./tunnelFill";
import type { LonLat } from "./types";

const HEAD = "unix_s,lat,lon,alt_m,h_acc_m,v_acc_m,speed_ms,speed_acc_ms,course_deg,course_acc_deg,floor";
const row = (t: number, p: LonLat, o: { acc?: number; speed?: number | null; course?: number; alt?: number } = {}) =>
  [t.toFixed(3), p[1].toFixed(7), p[0].toFixed(7), (o.alt ?? 10).toFixed(2), o.acc ?? 5, 3,
    o.speed === null ? "" : (o.speed ?? 20).toFixed(2), "", o.course ?? 90, "", ""].join(",");

/** 東へ 1 度あたり約 90.8km(北緯35度) */
const east = (m: number): LonLat => [139 + m / 90_800, 35];
const parse = (csv: string) => {
  const [head, ...rows] = csv.trim().split("\n").map((l) => l.split(","));
  return rows.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i]])));
};

/** 東西にまっすぐ 0〜5km の道。2〜4km はトンネル。北に大きく回る別の道もある */
const ROADS: FillRoad[] = [
  { coords: [east(-500), east(2000)], oneway: false, tunnel: false, name: "国道1号" },
  { coords: [east(2000), east(4000)], oneway: false, tunnel: true, name: "国道1号" },
  { coords: [east(4000), east(6000)], oneway: false, tunnel: false, name: "国道1号" },
];

describe("fillTunnels", () => {
  it("GPS が途切れた区間を道路に沿って1秒ごとに補い、推測の点は捨てる", () => {
    const lines = [HEAD];
    for (let t = 0; t <= 100; t++) lines.push(row(t, east(t * 20)));
    // 100〜200秒は iOS の推測(速度なし)と基地局の点
    lines.push(row(110, [139.03, 35.01], { speed: null, acc: 20 }));
    lines.push(row(150, [139.05, 35.02], { speed: null, acc: 1213 }));
    for (let t = 200; t <= 220; t++) lines.push(row(t, east(t * 20)));
    const r = fillTunnels(lines.join("\n"), () => ROADS);
    expect(r.skipped).toEqual([]);
    expect(r.sections).toHaveLength(1);
    const s = r.sections[0];
    expect(s).toMatchObject({ fromS: 100, toS: 200, points: 99, replaced: 2, roads: ["国道1号"] });
    expect(Math.abs(s.roadM - 2000)).toBeLessThan(20);
    expect(s.tunnelM).toBeGreaterThan(1900);
    const rows = parse(r.csv);
    expect(rows.filter((x) => x.src === "inferred")).toHaveLength(0);
    const filled = rows.filter((x) => x.src === "road");
    expect(filled).toHaveLength(99);
    // 速さは一定(20m/s)なので、150秒の点は 3000m の位置
    const mid = filled.find((x) => x.unix_s === "150.000")!;
    expect(distance([Number(mid.lon), Number(mid.lat)], east(3000))).toBeLessThan(2);
    expect(Math.abs(Number(mid.speed_est_ms) - 20)).toBeLessThan(0.3);
    expect(mid.speed_ms).toBe("");
    // 時刻順に並んでいる
    const ts = rows.map((x) => Number(x.unix_s));
    expect([...ts].sort((a, b) => a - b)).toEqual(ts);
  });

  it("道路がない・遠回りすぎる・速すぎる区間は補わず、元の点を残す", () => {
    const lines = [HEAD, row(0, east(0)), row(10, east(100), { speed: null, acc: 30 }), row(100, east(2000))];
    const none = fillTunnels(lines.join("\n"), () => []);
    expect(none.skipped).toEqual([expect.objectContaining({ reason: "no_road" })]);
    expect(parse(none.csv).map((x) => x.src)).toEqual(["gps", "inferred", "gps"]);
    // 北へ 2km 離れた道で回るしかない
    const far: FillRoad[] = [
      { coords: [east(-100), east(0), [139, 35.02], [139 + 2000 / 90_800, 35.02], east(2000), east(2100)], oneway: false, tunnel: false },
    ];
    expect(fillTunnels(lines.join("\n"), () => far).skipped[0].reason).toBe("detour");
    const fast = [HEAD, row(0, east(0)), row(20, east(5000))].join("\n");
    expect(fillTunnels(fast, () => ROADS).skipped[0].reason).toBe("too_fast");
  });

  it("短い途切れや止まっていたときは補わない", () => {
    const lines = [HEAD, row(0, east(0)), row(10, east(200)), row(100, east(250))];
    const r = fillTunnels(lines.join("\n"), () => ROADS);
    expect(r.sections).toEqual([]);
    expect(r.skipped).toEqual([]);
  });

  it("一方通行の道は進んでいた向きのほうを使う", () => {
    // 上下線: 北側が東向き、南側が西向き(約20m 離れている)
    const up: FillRoad = { coords: [[139, 35.0001], [139.03, 35.0001]], oneway: true, tunnel: true, name: "上り" };
    const down: FillRoad = { coords: [[139.03, 34.9999], [139, 34.9999]], oneway: true, tunnel: true, name: "下り" };
    const lines = [HEAD, row(0, [139.001, 35], { course: 90 }), row(100, [139.025, 35], { course: 90 })];
    expect(fillTunnels(lines.join("\n"), () => [down, up]).sections[0].roads).toEqual(["上り"]);
    const back = [HEAD, row(0, [139.025, 35], { course: 270 }), row(100, [139.001, 35], { course: 270 })];
    expect(fillTunnels(back.join("\n"), () => [down, up]).sections[0].roads).toEqual(["下り"]);
  });
});

describe("speedProfile", () => {
  it("両端の速さから始まって終わり、合計がちょうど道のりになる", () => {
    const p = speedProfile(3000, 120, 20, 30);
    expect(p(0).v).toBeCloseTo(20);
    expect(p(120).v).toBeCloseTo(30);
    expect(p(120).d).toBeCloseTo(3000);
    expect(p(0).d).toBeCloseTo(0);
  });

  it("途中で速さが負になるなら一定の速さにする", () => {
    const p = speedProfile(100, 100, 25, 25);
    expect(p(50).v).toBeCloseTo(1);
    expect(p(100).d).toBeCloseTo(100);
  });
});
