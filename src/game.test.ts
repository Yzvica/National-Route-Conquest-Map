import { describe, expect, it } from "vitest";
import {
  almostConquered,
  computeLevel,
  cumulative,
  evaluateAchievements,
  monthly,
  nearbyUntouched,
  regionProgress,
  regionTitle,
  summarize,
  timeline,
  xpForLevel,
  yearly,
} from "./game";
import { applyDeclared, computeStats } from "./stats";
import type { PassDates } from "./store";
import type { RouteData, Segment } from "./types";

const seg = (id: string, routes: string[], x: number, extra: Partial<Segment> = {}): Segment => ({
  id,
  routes,
  cats: routes.length > 1 ? ["main", "overlap"] : ["main"],
  len: 1000,
  coords: [
    [x, 35],
    [x + 0.01, 35],
  ],
  ...extra,
});

// 国道1号は 4km、2号は 1km(うち 1km は1号と重複)、3号は遠くに 1km
const data: RouteData = {
  version: 1,
  generatedAt: "",
  routes: { "1": { name: "国道1号" }, "2": { name: "国道2号" }, "3": { name: "国道3号" } },
  tunnels: [{ id: "t1", a: [0, 0], b: [0, 0], len: 1000 }],
  segments: [
    seg("a", ["1"], 139.0),
    seg("b", ["1"], 139.01, { tunnel: "t1" }),
    seg("c", ["1"], 139.02),
    seg("d", ["1", "2"], 139.03),
    seg("e", ["3"], 141.0),
  ],
};

const dates = new Map<string, PassDates>([
  ["a", ["2026-01-05", "2026-03-01"]],
  ["b", ["2026-01-05", "2026-01-05"]],
  ["c", ["2026-02-10", "2026-02-10"]],
  ["d", ["2026-02-11", "2026-02-11"]],
]);

describe("summarize", () => {
  it("路線を初めて走った日と、制覇した日を出す", () => {
    const cov = new Map([["a", 1], ["b", 1], ["c", 1], ["d", 1]]);
    const s = summarize(data, cov, dates);
    expect(s.routes.get("1")).toMatchObject({ firstDate: "2026-01-05", conqueredDate: "2026-02-11" });
    expect(s.routes.get("2")).toMatchObject({ firstDate: "2026-02-11", conqueredDate: "2026-02-11" });
    expect(s.routes.get("3")!.firstDate).toBeUndefined();
    expect(s.tunnels).toEqual({ passed: 1, total: 1 });
    expect(s.maxOverlap).toBe(2);
    // 重複区間は1回だけ数える
    expect(s.daily.get("2026-01-05")).toBe(2000);
    expect(s.daily.get("2026-02-11")).toBe(1000);
  });

  it("走行率が足りなければ制覇にしない", () => {
    const s = summarize(data, new Map([["a", 1], ["b", 1], ["c", 1], ["d", 0.5]]), dates);
    expect(s.routes.get("1")!.conqueredDate).toBeUndefined();
  });

  it("日付のない区間は日付不明として数える", () => {
    const s = summarize(data, new Map([["e", 1]]), dates);
    expect(s.routes.get("3")).toMatchObject({ firstDate: "", conqueredDate: "" });
    expect(cumulative(s)).toEqual({ start: 1000, points: [] });
    expect(timeline(s)).toEqual([]);
  });
});

describe("振り返り", () => {
  const s = summarize(data, new Map([["a", 1], ["b", 1], ["c", 1], ["d", 1]]), dates);

  it("月ごとの開拓距離は走らなかった月も埋める", () => {
    expect(monthly(s, "2026-04-02")).toEqual([
      ["2026-01", 2000],
      ["2026-02", 2000],
      ["2026-03", 0],
      ["2026-04", 0],
    ]);
  });

  it("年ごとのまとめ", () => {
    expect(yearly(s)).toEqual([{ year: "2026", newKm: 4000, firstRoutes: 2, conquered: 2 }]);
  });

  it("推移は日付順の累計", () => {
    expect(cumulative(s).points).toEqual([
      ["2026-01-05", 2000],
      ["2026-02-10", 3000],
      ["2026-02-11", 4000],
    ]);
  });

  it("タイムラインは新しい順で、同じ日は制覇が先", () => {
    expect(timeline(s).slice(0, 3)).toEqual([
      { date: "2026-02-11", ref: "1", type: "conquer" },
      { date: "2026-02-11", ref: "2", type: "conquer" },
      { date: "2026-02-11", ref: "2", type: "first" },
    ]);
  });
});

describe("実績・レベル", () => {
  it("走っていなくても判定でき、走れば解除される", () => {
    const none = evaluateAchievements({ kokudo: summarize(data, new Map(), dates) });
    expect(none.find((x) => x.a.id === "first-step")!.unlocked).toBe(false);
    // 高速道路のデータがなければ高速の実績は出さない
    expect(none.some((x) => x.a.id === "exp-first")).toBe(false);
    // 都道府県のデータがなければ都道府県の実績も出さない
    expect(none.some((x) => x.a.group === "都道府県")).toBe(false);

    const s = summarize(data, new Map([["a", 1], ["b", 1], ["c", 1], ["d", 1]]), dates);
    const got = evaluateAchievements({ kokudo: s });
    const ok = (id: string) => got.find((x) => x.a.id === id)!.unlocked;
    expect(ok("first-step")).toBe(true);
    expect(ok("conquer-1")).toBe(true);
    expect(ok("route-1")).toBe(true);
    expect(ok("conquer-5")).toBe(false);
    // 一桁国道は、データにある 1〜3号のうち 3号が未制覇
    expect(got.find((x) => x.a.id === "single-digit")).toMatchObject({ cur: 2, target: 3, unlocked: false });
  });

  it("経験値からレベルを決める", () => {
    expect(xpForLevel(1)).toBe(0);
    expect(xpForLevel(2)).toBe(100);
    const s = summarize(data, new Map([["a", 1], ["b", 1], ["c", 1], ["d", 1]]), dates);
    // 4km + 制覇2本×30 + 実績1つ×50 = 114 → レベル2
    const lv = computeLevel({ kokudo: s }, 1);
    expect(lv.xp).toBe(114);
    expect(lv.level).toBe(2);
    expect(lv.title).toBe("見習いドライバー");
  });
});

describe("おすすめ", () => {
  const cov = new Map([["a", 1], ["b", 1], ["c", 1]]);
  const s = summarize(data, cov, dates);

  it("あと少しの路線と、近くの未踏路線", () => {
    expect(almostConquered(s).map((x) => x.ref)).toEqual(["1"]);
    const near = nearbyUntouched(data, s, cov);
    expect(near.map((x) => x.ref)).toEqual(["2", "3"]);
    expect(near[0].distance!).toBeLessThan(near[1].distance!);
  });
});

describe("都道府県", () => {
  // a〜d は神奈川(14)、e は北海道(1)
  const withPref: RouteData = {
    ...data,
    segments: data.segments.map((s) => ({ ...s, pref: s.id === "e" ? 1 : 14 })),
  };

  it("都道府県・地方ごとに集計し、地方の称号を出す", () => {
    const s = summarize(withPref, new Map([["a", 1]]), dates);
    expect(s.byPref!.get(14)).toEqual({ total: 4000, done: 1000 });
    expect(s.byPref!.get(1)).toEqual({ total: 1000, done: 0 });
    const regions = regionProgress(s.byPref!);
    expect(regions.map((r) => r.name)).toEqual(["北海道", "関東"]);
    expect(regionTitle({ prefs: { byPref: s.byPref! } })).toBe("関東の常連");
    const all = summarize(withPref, new Map([["a", 1], ["b", 1], ["c", 1]]), dates);
    expect(regionTitle({ prefs: { byPref: all.byPref! } })).toBe("関東の覇者");
  });

  it("都道府県のないデータでは集計しない", () => {
    expect(summarize(data, new Map(), dates).byPref).toBeUndefined();
    expect(regionTitle({})).toBeUndefined();
  });
});

describe("点線国道", () => {
  // a〜d は国道1号の車道、x は国道1号と2号の点線国道
  const withDotted: RouteData = {
    ...data,
    segments: [...data.segments, { ...seg("x", ["1", "2"], 139.05), cats: ["dotted", "overlap"] }],
  };

  it("ログで通っていても、申告がなければ通っていないことにする", () => {
    const cov = applyDeclared(withDotted, new Map([["a", 1], ["x", 1]]), new Set());
    expect(cov.has("x")).toBe(false);
    expect(cov.get("a")).toBe(1);
    expect(applyDeclared(withDotted, new Map(), new Set(["2"])).get("x")).toBe(1);
  });

  it("総合・路線の制覇率には入れず、種別では参考として数える", () => {
    const cov = applyDeclared(withDotted, new Map([["a", 1], ["b", 1], ["c", 1], ["d", 1]]), new Set(["1"]));
    const stats = computeStats(withDotted, cov);
    expect(stats.overall.total).toBe(5000);
    expect(stats.byRoute.get("1")!.overall).toEqual({ total: 4000, done: 4000 });
    expect(stats.byCategory.dotted).toEqual({ total: 1000, done: 1000 });
    const s = summarize(withDotted, cov, dates);
    expect(s.routes.get("1")!.conqueredDate).toBe("2026-02-11");
    expect(s.passedSegments).toBe(4);
    const got = evaluateAchievements({ kokudo: s });
    expect(got.find((x) => x.a.id === "dotted-0.2")!.unlocked).toBe(true);
  });
});
