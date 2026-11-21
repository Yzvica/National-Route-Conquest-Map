import { describe, expect, it } from "vitest";
import { RoadGraph, dist, planNavi, type NaviPlan } from "./navi";
import { compareRoute, decodePolyline, fixPoint, originOf } from "./naviCheck";
import type { LonLat, Segment } from "./types";

const seg = (id: string, routes: string[], a: LonLat, b: LonLat): Segment => ({ id, routes, cats: ["main"], len: dist(a, b), coords: [a, b] });
const road = (prefix: string, routes: string[], a: LonLat, b: LonLat) => {
  const n = Math.max(1, Math.round(dist(a, b) / 1000));
  const p = (t: number): LonLat => [a[0] + ((b[0] - a[0]) * t) / n, a[1] + ((b[1] - a[1]) * t) / n];
  return Array.from({ length: n }, (_, k) => seg(`${prefix}-${k}`, routes, p(k), p(k + 1)));
};
const ok = (r: ReturnType<typeof planNavi>): NaviPlan => {
  if ("error" in r) throw new Error(r.error);
  return r;
};
/** 線を細かい点の列にする */
const dense = (pts: LonLat[], step = 0.0005): LonLat[] => {
  const out: LonLat[] = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const [a, b] = [pts[i - 1], pts[i]];
    const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / step));
    for (let k = 1; k <= n; k++) out.push([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n]);
  }
  return out;
};

describe("decodePolyline", () => {
  it("Google の例を読める", () => {
    // https://developers.google.com/maps/documentation/utilities/polylinealgorithm の例
    expect(decodePolyline("_p~iF~ps|U_ulLnnqC_mqNvxq`@")).toEqual([
      [-120.2, 38.5],
      [-120.95, 40.7],
      [-126.453, 43.252],
    ]);
  });
});

describe("compareRoute", () => {
  // 東へ 10km の国道
  const plan = ok(planNavi(new RoadGraph(road("a", ["1"], [140.0, 38.0], [140.114, 38.0])), [{ lon: 140.0, lat: 38.0 }, { lon: 140.114, lat: 38.0 }]));
  const link = plan.links[0];

  it("道筋どおりなら外れた所はない", () => {
    const c = compareRoute(plan, link, dense([[140.0, 38.0], [140.114, 38.0]]), 10000);
    expect(c.offs).toEqual([]);
  });

  it("途中で北へ 600m 外れた所を見つけ、その真ん中に経由地を置ける", () => {
    const line = dense([[140.0, 38.0], [140.04, 38.0], [140.045, 38.0055], [140.06, 38.0055], [140.065, 38.0], [140.114, 38.0]]);
    const c = compareRoute(plan, link, line, 11000);
    expect(c.offs.length).toBe(1);
    const o = c.offs[0];
    expect(o.off).toBeGreaterThan(500);
    const fix = fixPoint(plan, o);
    expect(fix.lat).toBe(38.0);
    expect(fix.lon).toBeGreaterThan(140.045);
    expect(fix.lon).toBeLessThan(140.06);
  });

  it("点の間が長い線でも、途中で外れているのを見つける", () => {
    const line = [[140.0, 38.0], [140.04, 38.0], [140.05, 38.006], [140.06, 38.0], [140.114, 38.0]] as LonLat[];
    expect(compareRoute(plan, link, line, 11000).offs.length).toBe(1);
  });

  it("一般道の区間で外れるのは数えない", () => {
    const withFree: NaviPlan = { ...plan, freeSpans: [{ from: 3000, to: 6000 }] };
    const line = dense([[140.0, 38.0], [140.04, 38.0], [140.045, 38.0055], [140.06, 38.0055], [140.065, 38.0], [140.114, 38.0]]);
    expect(compareRoute(withFree, link, line, 11000).offs).toEqual([]);
  });

  it("1本目の出発は道筋の最初、2本目からは前のリンクの目的地", () => {
    expect(originOf(plan, 0)).toEqual({ lon: 140.0, lat: 38.0 });
    const multi = ok(
      planNavi(new RoadGraph(road("b", ["4"], [140.0, 38.0], [141.0, 38.0])), [{ lon: 140.0, lat: 38.0 }, { lon: 141.0, lat: 38.0 }], { perLink: 3 }),
    );
    expect(originOf(multi, 1)).toEqual(multi.links[0].dest);
  });
});
