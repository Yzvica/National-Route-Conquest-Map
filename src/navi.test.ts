import { describe, expect, it } from "vitest";
import { FREE_REF, RoadGraph, compareRef, dist, googleMapsUrl, linksText, planNavi, segmentsIn, type NaviPlan } from "./navi";
import type { LonLat, Segment } from "./types";

// 緯度38度付近で、経度 0.001 度 ≒ 88m、緯度 0.001 度 ≒ 111m
const seg = (id: string, routes: string[], coords: LonLat[], extra: Partial<Segment> = {}): Segment => ({
  id,
  routes,
  cats: ["main"],
  len: coords.slice(1).reduce((s, c, i) => s + dist(coords[i], c), 0),
  coords,
  ...extra,
});
/** a から b までのまっすぐな道を、長さ約 1km の区間に分けて作る */
function straight(prefix: string, routes: string[], a: LonLat, b: LonLat, extra: Partial<Segment> = {}): Segment[] {
  const n = Math.max(1, Math.round(dist(a, b) / 1000));
  const out: Segment[] = [];
  for (let k = 0; k < n; k++) {
    const p = (t: number): LonLat => [a[0] + ((b[0] - a[0]) * t) / n, a[1] + ((b[1] - a[1]) * t) / n];
    out.push(seg(`${prefix}-${k}`, routes, [p(k), p(k + 1)], extra));
  }
  return out;
}
const ok = (r: ReturnType<typeof planNavi>): NaviPlan => {
  if ("error" in r) throw new Error(r.error);
  return r;
};

describe("planNavi", () => {
  // 国道1号(東へ 10km)と、立体交差で点を共有しない国道2号(北へ 10km、交点の 50m 横を通る)
  const r1 = straight("a", ["1"], [140.0, 38.0], [140.114, 38.0]);
  const r2 = straight("b", ["2"], [140.0574, 38.0005], [140.0574, 38.09]);

  it("点を共有しない国道どうしも近ければつないで、乗り換えの少し先に経由地を置く", () => {
    const plan = ok(planNavi(new RoadGraph([...r1, ...r2]), [{ lon: 140.0, lat: 38.0 }, { lon: 140.0574, lat: 38.09 }]));
    expect(plan.routes).toEqual(["1", "2"]);
    // 1号を約5km東へ → 2号を約10km北へ
    expect(plan.length / 1000).toBeGreaterThan(14.5);
    expect(plan.length / 1000).toBeLessThan(16);
    // 2号に入ってから 400m〜1.2km の間に経由地がある
    const turn = plan.waypoints.find((w) => w.routes.includes("2"))!;
    expect(turn.lat - 38.0005).toBeGreaterThan(0.0035);
    expect(turn.lat - 38.0005).toBeLessThan(0.0115);
    // 最後は到着地
    expect(plan.waypoints[plan.waypoints.length - 1]).toMatchObject({ lon: 140.0574, lat: 38.09 });
  });

  it("まっすぐな道では経由地を間隔の上限ごと、曲がりくねった道では細かく置く", () => {
    const flat = ok(planNavi(new RoadGraph(straight("s", ["4"], [140.0, 38.0], [140.4, 38.0])), [{ lon: 140.0, lat: 38.0 }, { lon: 140.4, lat: 38.0 }]));
    // 約35km を 7km ごと
    expect(flat.waypoints.length).toBeGreaterThanOrEqual(5);
    expect(flat.waypoints.length).toBeLessThanOrEqual(7);

    // ジグザグの道(南北に 2km ずつ振れながら東へ 20km)
    const zig: Segment[] = [];
    let prev: LonLat = [140.0, 38.0];
    for (let k = 1; k <= 20; k++) {
      const next: LonLat = [140.0 + k * 0.0114, k % 2 ? 38.018 : 38.0];
      zig.push(seg(`z-${k}`, ["457"], [prev, next]));
      prev = next;
    }
    const curvy = ok(planNavi(new RoadGraph(zig), [{ lon: 140.0, lat: 38.0 }, { lon: prev[0], lat: prev[1] }]));
    expect(curvy.waypoints.length).toBeGreaterThan(15);
  });

  it("上下線が別の道は、進む向きの車線を通る", () => {
    // 北向き(x=140.0)と南向き(x=140.0003)の車線。南向きの車線の上の点を選んでも、北へ行くなら北向きを使う
    const up = straight("u", ["6"], [140.0, 38.0], [140.0, 38.05], { pair: "d-0" });
    const down = straight("d", ["6"], [140.0003, 38.05], [140.0003, 38.0], { pair: "u-0" });
    const plan = ok(planNavi(new RoadGraph([...up, ...down]), [{ lon: 140.0003, lat: 38.0 }, { lon: 140.0003, lat: 38.05 }]));
    for (const w of plan.waypoints.slice(0, -1)) expect(w.lon).toBe(140.0);
  });

  it("経由地の数でリンクを分け、URL は現在地から始まるナビにする", () => {
    const g = new RoadGraph(straight("s", ["4"], [140.0, 38.0], [141.0, 38.0]));
    const plan = ok(planNavi(g, [{ lon: 140.0, lat: 38.0 }, { lon: 141.0, lat: 38.0 }], { perLink: 3 }));
    expect(plan.links.length).toBe(Math.ceil(plan.waypoints.length / 4));
    for (const l of plan.links) expect(l.waypoints.length).toBeLessThanOrEqual(3);
    // つながっている(次のリンクは前のリンクの目的地から)
    for (let i = 1; i < plan.links.length; i++) expect(plan.links[i].from).toBe(plan.links[i - 1].to);
    const url = new URL(plan.links[0].url);
    expect(url.searchParams.get("origin")).toBeNull();
    expect(url.searchParams.get("travelmode")).toBe("driving");
    expect(url.searchParams.get("waypoints")!.split("|").length).toBe(plan.links[0].waypoints.length);
    expect(linksText(plan, (r) => `国道${r}号`)).toContain("1. 国道4号");
  });

  it("近くに国道がない点や、つながらない点はエラーにする", () => {
    const g = new RoadGraph([...r1, ...straight("far", ["9"], [141.0, 39.0], [141.05, 39.0])]);
    expect(planNavi(g, [{ lon: 140.0, lat: 38.0 }])).toHaveProperty("error");
    expect(planNavi(g, [{ lon: 140.0, lat: 38.0 }, { lon: 140.5, lat: 38.5 }])).toMatchObject({ leg: 1 });
    expect(planNavi(g, [{ lon: 140.0, lat: 38.0 }, { lon: 141.05, lat: 39.0 }])).toMatchObject({ leg: 1 });
  });
});

describe("都道府県道と一般道", () => {
  // 国道1号: 東へ 10km。県道 4-22(主要地方道): 1号の途中から北東へ斜めに近道になる道
  const r1 = straight("a", ["1"], [140.0, 38.0], [140.114, 38.0]);
  const up = straight("u", ["1"], [140.114, 38.0], [140.114, 38.05]);
  const pref = (cats: Segment["cats"]) => straight("p", ["4-22"], [140.0, 38.0], [140.114, 38.05], { cats });

  it("都道府県道は少し遠回りとみなし、ずっと近いときだけ使う", () => {
    const to = { lon: 140.114, lat: 38.05 };
    const from = { lon: 140.0, lat: 38.0 };
    // 国道 約15.6km、県道 約11.3km(1.38 倍)。主要地方道(1.25)なら県道、一般県道(1.5)なら国道
    expect(ok(planNavi(new RoadGraph([...r1, ...up, ...pref(["major"])]), [from, to])).routes).toEqual(["4-22"]);
    expect(ok(planNavi(new RoadGraph([...r1, ...up, ...pref(["general"])]), [from, to])).routes).toEqual(["1"]);
  });

  it("一般道も使うと、データの道の切れ目どうしをつなぎ、一般道の区間は経由地を置かずに Google に任せる", () => {
    // 1号(東へ 5km)の終わりから 1.5km 離れて、県道が東へ 5km 続く
    const a = straight("a", ["1"], [140.0, 38.0], [140.057, 38.0]);
    const b = straight("b", ["4-30"], [140.074, 38.0], [140.131, 38.0], { cats: ["general"] });
    const pts = [{ lon: 140.0, lat: 38.0 }, { lon: 140.131, lat: 38.0 }];
    expect(planNavi(new RoadGraph([...a, ...b]), pts)).toHaveProperty("error");
    const plan = ok(planNavi(new RoadGraph([...a, ...b], { free: true }), pts, { free: true }));
    expect(plan.routes).toEqual(["1", FREE_REF, "4-30"]);
    expect(plan.freeSpans.length).toBe(1);
    const f = plan.freeSpans[0];
    expect(f.to - f.from).toBeGreaterThan(1400);
    // 一般道の区間の中に経由地はない。手前 300m 以内と、出て 400m〜1.2km 先には経由地がある
    expect(plan.waypoints.some((w) => w.at > f.from + 1 && w.at < f.to - 1)).toBe(false);
    expect(plan.waypoints.some((w) => w.at <= f.from && w.at >= f.from - 300)).toBe(true);
    expect(plan.waypoints.some((w) => w.at >= f.to + 400 && w.at <= f.to + 1200)).toBe(true);
  });

  it("道から離れた点はその場所に経由地を置き、一般道でつなぐ。データの道でつながらなければ区間ごと Google に任せる", () => {
    const g = new RoadGraph(r1, { free: true });
    const off = { lon: 140.05, lat: 38.01 }; // 1号から約 1.1km 北
    const plan = ok(planNavi(g, [{ lon: 140.0, lat: 38.0 }, off, { lon: 140.114, lat: 38.0 }], { free: true }));
    expect(plan.waypoints.some((w) => w.lon === off.lon && w.lat === off.lat)).toBe(true);
    expect(plan.freeSpans.length).toBe(1);
    // 一時的に足した点は消えている
    const size = g.size;
    planNavi(g, [{ lon: 140.0, lat: 38.0 }, { lon: 140.5, lat: 38.3 }], { free: true });
    expect(g.size).toBe(size);
    const far = ok(planNavi(g, [{ lon: 140.0, lat: 38.0 }, { lon: 140.5, lat: 38.3 }], { free: true }));
    expect(far.routes[far.routes.length - 1]).toBe(FREE_REF);
  });

  it("extra の点のそばに経由地を足す", () => {
    const g = new RoadGraph(straight("s", ["4"], [140.0, 38.0], [140.2, 38.0]));
    const pts = [{ lon: 140.0, lat: 38.0 }, { lon: 140.2, lat: 38.0 }];
    const base = ok(planNavi(g, pts));
    const plan = ok(planNavi(g, pts, { extra: [{ lon: 140.0333, lat: 38.0005 }] }));
    expect(plan.waypoints.length).toBe(base.waypoints.length + 1);
    expect(plan.waypoints.some((w) => Math.abs(w.lon - 140.0333) < 0.002)).toBe(true);
  });

  it("compareRef は国道 → 都道府県道 → 一般道の順", () => {
    expect([FREE_REF, "13-3", "4-22", "45", "4"].sort(compareRef)).toEqual(["4", "45", "4-22", "13-3", FREE_REF]);
  });
});

describe("helpers", () => {
  it("googleMapsUrl", () => {
    expect(googleMapsUrl([{ lat: 38.1, lon: 140.1 }, { lat: 38.2, lon: 140.2 }], { lat: 38.3, lon: 140.3 })).toBe(
      "https://www.google.com/maps/dir/?api=1&destination=38.3,140.3&waypoints=38.1,140.1%7C38.2,140.2&travelmode=driving&dir_action=navigate",
    );
  });
  it("segmentsIn は範囲にかかる区間だけを返す", () => {
    const s = [seg("in", ["1"], [[140.0, 38.0], [140.1, 38.0]]), seg("out", ["1"], [[141.0, 39.0], [141.1, 39.0]])];
    expect(segmentsIn(s, [139.9, 37.9, 140.05, 38.1]).map((x) => x.id)).toEqual(["in"]);
  });
});
