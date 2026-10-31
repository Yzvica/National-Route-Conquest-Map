import { describe, expect, it } from "vitest";
import { computeStats, effectiveCoverage } from "./stats";
import type { RouteData, Segment } from "./types";

const seg = (id: string, pair?: string, len = 200): Segment => ({
  id, routes: ["東名高速道路"], cats: ["expressway"], len, pair, coords: [[0, 0], [0, 0.001]],
});
const data: RouteData = {
  version: 1,
  generatedAt: "",
  kind: "expressway",
  routes: {},
  tunnels: [],
  // 上り a/下り b が組、c は上下一体の区間
  segments: [seg("a", "b"), seg("b", "a"), seg("c", undefined, 100)],
};

describe("上下線", () => {
  it("片方を走れば両方を走ったことにする", () => {
    const cov = effectiveCoverage(data, new Map([["b", 1]]));
    expect(cov.get("a")).toBe(1);
    expect(cov.get("b")).toBe(1);
    expect(cov.has("c")).toBe(false);
  });

  it("組の区間は半分ずつ数え、道路の長さは1本分になる", () => {
    const stats = computeStats(data, effectiveCoverage(data, new Map([["a", 1]])));
    expect(stats.overall).toEqual({ total: 300, done: 200 });
    expect(stats.byRoute.get("東名高速道路")!.overall).toEqual({ total: 300, done: 200 });
  });

  it("組のないデータは記録をそのまま使う", () => {
    const plain: RouteData = { ...data, segments: [seg("x")] };
    const cov = new Map([["x", 0.5]]);
    expect(effectiveCoverage(plain, cov)).toBe(cov);
  });
});
