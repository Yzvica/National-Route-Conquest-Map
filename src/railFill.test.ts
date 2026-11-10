import { describe, expect, it } from "vitest";
import { distance } from "./geo";
import { RAIL_FILL_OPTIONS, railsFromData, type RailData } from "./railFill";
import { fillTunnels } from "./tunnelFill";
import type { LonLat } from "./types";

const HEAD = "unix_s,lat,lon,alt_m,h_acc_m,v_acc_m,speed_ms,speed_acc_ms,course_deg,course_acc_deg,floor";
const row = (t: number, p: LonLat, o: { acc?: number; speed?: number | null; course?: number; courseAcc?: number } = {}) =>
  [t.toFixed(3), p[1].toFixed(7), p[0].toFixed(7), "10.00", o.acc ?? 20, 3,
    o.speed === null ? "" : (o.speed ?? 15).toFixed(2), "", o.course ?? 90, o.courseAcc ?? "", ""].join(",");

/** 北緯35度で、東へ x m・北へ y m の点 */
const at = (x: number, y = 0): LonLat => [139 + x / 91_290, 35 + y / 110_950];
const parse = (csv: string) => {
  const [head, ...rows] = csv.trim().split("\n").map((l) => l.split(","));
  return rows.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i]])));
};

/**
 * 東西に走る A線(0〜6km)と、x=3050m を南北に走る B線。2本の線路は交わるが、同じ点を持たないのでつながっていない。
 * A線と B線の交わるところに乗換駅がある
 */
const DATA: RailData = {
  version: 1,
  lines: ["A線", "B線"],
  segments: [
    { c: [at(0), at(1500), at(3000), at(4500), at(6000)], l: 0 },
    { c: [at(3050, -3000), at(3050, -100), at(3050, 3000)], l: 1, t: 1 },
  ],
  stations: [[...at(3020, 30), "乗換駅"] as [number, number, string]],
};

describe("railsFromData", () => {
  it("駅の近くで別の路線に乗り換えて補う", () => {
    const lines = [HEAD];
    for (let t = 0; t <= 20; t++) lines.push(row(t, at(t * 15), { course: 90 }));
    // 20秒〜400秒は基地局の点だけ(速度なし・精度が悪い)
    lines.push(row(100, at(1500, 400), { acc: 1414, speed: null }));
    for (let t = 400; t <= 420; t++) lines.push(row(t, at(3050, 2500 + (t - 400) * 15), { course: 0 }));
    const r = fillTunnels(lines.join("\n"), railsFromData(DATA), RAIL_FILL_OPTIONS);
    expect(r.skipped).toEqual([]);
    expect(r.sections).toHaveLength(1);
    const s = r.sections[0];
    expect(s.roads).toEqual(["A線", "B線"]);
    expect(s.replaced).toBe(1);
    // A線を 300m→3000m あたり、乗り換え、B線を 0→2500m
    expect(Math.abs(s.roadM - (2750 + 2500))).toBeLessThan(150);
    expect(s.tunnelM).toBeGreaterThan(2000);
    const filled = parse(r.csv).filter((x) => x.src === "road");
    expect(filled).toHaveLength(379);
    // 補った点はすべてどちらかの線路の上
    for (const x of filled) {
      const p: LonLat = [Number(x.lon), Number(x.lat)];
      const onA = Math.abs(p[1] - 35) * 110_950;
      const onB = Math.abs(p[0] - at(3050)[0]) * 91_290;
      expect(Math.min(onA, onB)).toBeLessThan(80);
    }
  });

  it("駅がなければ別の路線にはつながらない", () => {
    const lines = [HEAD, row(0, at(300), { course: 90 }), row(400, at(3050, 2500), { course: 0 })];
    const r = fillTunnels(lines.join("\n"), railsFromData({ ...DATA, stations: [] }), RAIL_FILL_OPTIONS);
    expect(r.sections).toEqual([]);
    expect(r.skipped).toEqual([expect.objectContaining({ reason: "no_road" })]);
  });

  it("同じ路線の上なら乗り換えずに線路の形どおり補う(車内の精度の悪い GPS も端の点にする)", () => {
    const lines = [HEAD, row(0, at(200), { acc: 90 }), row(200, at(4200), { acc: 90 })];
    const r = fillTunnels(lines.join("\n"), railsFromData(DATA), RAIL_FILL_OPTIONS);
    expect(r.sections).toHaveLength(1);
    expect(r.sections[0].roads).toEqual(["A線"]);
    expect(Math.abs(r.sections[0].roadM - 4000)).toBeLessThan(20);
    const mid = parse(r.csv).find((x) => x.unix_s === "100.000")!;
    expect(distance([Number(mid.lon), Number(mid.lat)], at(2200))).toBeLessThan(30);
  });

  it("止まりかけの点(駅で停車中など)のでたらめな向きでは線路を絞り込まない", () => {
    // 東西の線路の上で、終わりの点は止まりかけで向きが北西(実際の記録: 速さ 0.3m/s・向きの精度 95度)
    const stop = { speed: 0.3, course: 317, courseAcc: 95 };
    const lines = [HEAD, row(0, at(200)), row(200, at(4200), stop)];
    const r = fillTunnels(lines.join("\n"), railsFromData(DATA), RAIL_FILL_OPTIONS);
    expect(r.skipped).toEqual([]);
    expect(r.sections).toHaveLength(1);
    // 速く走っていても、向きの精度が悪ければ同じ
    const bad = [HEAD, row(0, at(200)), row(200, at(4200), { speed: 10, course: 317, courseAcc: 95 })];
    expect(fillTunnels(bad.join("\n"), railsFromData(DATA), RAIL_FILL_OPTIONS).sections).toHaveLength(1);
  });
});
