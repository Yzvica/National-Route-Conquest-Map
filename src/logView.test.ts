import { describe, expect, it } from "vitest";
import { altChart, logDetailPanel, logListPanel, maxKmhOf, passedRoutes, shownLogs, speedChart, tripDetailPanel, tripStats, weatherPoints, weatherView, type LogKind } from "./logView";
import type { TravelTrip } from "./travel";
import type { RouteData, TrackPoint } from "./types";

// 北へ 1 秒に約 11.1m(時速 40km)で進むログ。途中 60 秒止まる
function track(): TrackPoint[] {
  const pts: TrackPoint[] = [];
  let lat = 35;
  let t = Date.UTC(2026, 10, 8, 0, 0, 0);
  for (let i = 0; i < 120; i++) {
    pts.push({ lat, lon: 139, time: t });
    if (i < 60 || i >= 90) lat += 11.11 / 111_195;
    t += 1000;
  }
  return pts;
}

describe("tripStats", () => {
  it("止まっていた間を除いて平均速度を出す", () => {
    const s = tripStats(track());
    expect(s.totalMs).toBe(119_000);
    expect(s.movingMs! / 1000).toBeGreaterThan(85);
    expect(s.movingMs! / 1000).toBeLessThan(100);
    expect(s.maxKmh!).toBeGreaterThan(39);
    expect(s.maxKmh!).toBeLessThan(41);
    expect(s.avgKmh!).toBeGreaterThan(34);
    expect(s.avgKmh!).toBeLessThan(41);
  });

  it("飛行機は時速 200km を超えても捨てず、GPS の速さを使う", () => {
    // 1 分ごとに東へ約 13km(時速約 800km)。GPS の速さは 220 m/s
    const t0 = Date.UTC(2026, 10, 9, 11, 0, 0);
    const pts: TrackPoint[] = Array.from({ length: 61 }, (_, i) => ({ lat: 35, lon: 135 + i * 0.143, time: t0 + i * 60_000, speed: 220, alt: 10000 + i }));
    const car = tripStats(pts);
    expect(car.maxKmh).toBeUndefined();
    const s = tripStats(pts, maxKmhOf("plane"));
    expect(s.m / 1000).toBeGreaterThan(750);
    expect(s.maxKmh!).toBeCloseTo(792, 0);
    expect(s.avgKmh!).toBeGreaterThan(700);
    expect(s.maxAltM).toBe(10060);
    expect(s.minAltM).toBe(10000);
  });

  it("時刻のないログは距離だけ", () => {
    const s = tripStats(track().map(({ lat, lon }) => ({ lat, lon })));
    expect(s.m).toBeGreaterThan(900);
    expect(s.speeds).toEqual([]);
    expect(s.avgKmh).toBeUndefined();
  });
});

describe("passedRoutes", () => {
  it("路線ごとに通った距離を足し、短すぎるものは外す", () => {
    const d = {
      routes: { "1": { name: "国道1号" }, "2": { name: "国道2号" } },
      segments: [
        { id: "a", routes: ["1"], cats: ["main"], len: 200, coords: [] },
        { id: "b", routes: ["1", "2"], cats: ["main"], len: 200, coords: [] },
        { id: "c", routes: ["2"], cats: ["main"], len: 200, coords: [] },
      ],
    } as unknown as RouteData;
    const list = passedRoutes(new Map([["a", 1], ["b", 0.4]]), [["kokudo", d]], (_k, ref, x) => x.routes[ref].name);
    expect(list).toEqual([{ kind: "kokudo", ref: "1", name: "国道1号", m: 280 }]);
  });
});

describe("ログタブの画面", () => {
  const logs = [
    { id: "1-a.gpx.gz", name: "a.gpx", size: 1, date: "2026-11-08", m: 14200, score: 59 },
    { id: "2-b.csv.gz", name: "b.csv", size: 1, date: "2025-05-01", m: 3000 },
  ];

  it("年で絞り込み、点数の平均を出す", () => {
    const html = logListPanel(logs, "2026", true);
    expect(html).toContain("a.gpx");
    expect(html).not.toContain("b.csv");
    expect(html).toContain("運転の平均 59 点");
  });

  it("選んだログの時間・速度・通った道路を出す", () => {
    const html = logDetailPanel({
      log: logs[0],
      stats: tripStats(track()),
      routes: [{ kind: "kokudo", ref: "1", name: "国道1号", m: 1200 }],
    });
    expect(html).toContain("平均速度");
    expect(html).toContain("最高速度");
    expect(html).toContain('data-route="1"');
    expect(html).toContain("<svg");
  });

  it("一覧で選んだログに印を付け、詳細に前後のログへのボタンを出す", () => {
    expect(logListPanel(logs, "all", true, logs[1].id)).toMatch(/<li class="selected"[^>]*><input [^>]*data-show="log:2-b\.csv\.gz"[^>]*\/><a href="#" data-log-open="2-b\.csv\.gz"/);
    // チェックしたものだけにチェックが付き、旅の記録も日付順に混ざる
    const trip = { id: "t1", mode: "train" as const, start: "2026-11-08T23:00:00Z", end: null, m: 5000, maxAltM: null, lines: [], gaps: [] };
    const mixed = logListPanel(logs, "all", true, undefined, undefined, [], { shown: new Set(["trip:t1"]), trips: [trip] });
    expect(mixed).toMatch(/data-show="trip:t1" checked/);
    expect(mixed).not.toMatch(/data-show="log:[^"]*" checked/);
    expect(mixed).toContain("1 本を表示中");
    expect(shownLogs(logs, "all").map((l) => l.id)).toEqual([logs[0].id, logs[1].id]);
    const html = logDetailPanel({ log: logs[0] }, { next: logs[1].id, index: 1, count: 2, folded: false });
    expect(html).toMatch(/id="log-prev"[^>]*disabled/);
    expect(html).toContain(`id="log-next" class="nav" aria-label="古いログへ" data-log-open="${logs[1].id}"`);
    expect(html).toContain("1 / 2");
  });

  it("乗り物のタブで、選んだ種類だけを一覧と集計に出す", () => {
    const trip = { id: "t1", mode: "train" as const, start: "2026-11-08T23:00:00Z", end: null, m: 5000, maxAltM: null, lines: [], gaps: [] };
    const panel = (kind: LogKind) => logListPanel(logs, "all", true, undefined, undefined, [], { shown: new Set(), trips: [trip], kind });
    const all = panel("all");
    expect(all).toContain('data-log-kind="all" aria-selected="true"');
    expect(all).toContain('data-log-kind="train"');
    expect(all).not.toContain('data-log-kind="plane"');
    expect(all).toContain("🚗 運転 2本 17 km・🚆 電車 1回 5 km(合計 22 km)・運転の平均 59 点");
    const train = panel("train");
    expect(train).toContain("1 回・5 km");
    expect(train).toContain('data-trip-open="t1"');
    expect(train).not.toContain("data-log-open");
    const car = panel("car");
    expect(car).toContain("2 本・17 km・運転の平均 59 点");
    expect(car).not.toContain('data-trip-open="t1"');
  });

  it("速度のグラフに出来事の印を付ける", () => {
    const s = tripStats(track());
    expect(speedChart(s.speeds, [{ t: s.start! + 30_000, label: "急ブレーキ" }])).toContain("急ブレーキ");
  });

  it("天気を一覧と詳細に出し、MiniPC に送る点は1分おきにする", () => {
    const sample = { t: 1762675200, lat: 35, lon: 139, code: 61, label: "小雨", icon: "🌧️", temp: 12.3, feels: 10, humidity: 80, precip: 0.8, snow: 0, cloud: 100, pressure: 1010, wind: 4, windDir: 0, gust: 9, isDay: true };
    const weather = {
      source: "Open-Meteo",
      api: "forecast" as const,
      fetchedAt: "",
      summary: { code: 61, label: "小雨", icon: "🌧️", tMin: 11.6, tMax: 13.2, precipMax: 0.8, windMax: 4, gustMax: 9, rain: true, night: false, sunrise: 1762636000, sunset: 1762675000 },
      samples: [sample],
    };
    const list = logListPanel([{ ...logs[0], weather: { icon: "🌧️", label: "小雨", tMin: 11.6, tMax: 13.2 } }], "all", true);
    expect(list).toContain("🌧️ 12〜13℃");
    const html = logDetailPanel({ log: logs[0], stats: tripStats(track()), weather });
    expect(html).toContain("<h3>天気</h3>");
    expect(html).toContain("小雨・12〜13℃・雨 最大 0.8 mm/時・風 最大 4 m/s(瞬間 9)");
    expect(html).toContain("北の風 4 m/s");
    expect(logDetailPanel({ log: logs[0], stats: tripStats(track()) })).toContain("天気を調べています");
    const pts = weatherPoints(track());
    expect(pts.length).toBeGreaterThan(1);
    for (let i = 1; i < pts.length - 1; i++) expect(pts[i][0] - pts[i - 1][0]).toBeGreaterThanOrEqual(60);
  });
});

describe("旅の記録の詳細(同乗)", () => {
  const trip: TravelTrip = { id: "20261110-080000", mode: "ride", start: "2026-11-09T23:00:00Z", end: "2026-11-10T00:00:00Z", m: 30000, maxAltM: null, lines: [], gaps: [], score: 66, mount: "hand" };
  const track: TrackPoint[] = Array.from({ length: 61 }, (_, i) => ({ lat: 35 + i * 0.0003, lon: 139, time: 1_700_000_000_000 + i * 1000 }));
  const ev = { score: 66, items: [{ key: "sick", name: "酔いやすさ", value: 0.5, score: 40, weight: 0.3, good: 0.2, bad: 0.8 }], moving_s: 60, stops: 0, events: [{ kind: "急ブレーキ", type: "brake", value: 0.31, unit: "G", t_unix: 1_700_000_030, lat: 35.009, lon: 139, kmh: 40 }], mount: "hand", usable_ratio: 0.42 };

  it("運転と同じように速度・評価・通った道路を出し、手持ちは参考値と書く", () => {
    const html = tripDetailPanel(trip, false, { stats: tripStats(track), ev, weather: null, routes: [] });
    expect(html).toContain("運転評価");
    expect(html).toContain("酔いやすさ");
    expect(html).toContain("手持ちで記録(参考値)・採点に使えた時間 42%");
    expect(html).toContain("最高速度");
    expect(html).toContain("通った道路");
    expect(html).toContain('data-log-id="trip:20261110-080000"');
  });

  it("評価のない電車は評価・道路を出さない", () => {
    const html = tripDetailPanel({ ...trip, mode: "train", score: undefined }, false, { stats: tripStats(track), ev: null, weather: null });
    expect(html).not.toContain("運転評価");
    expect(html).not.toContain("通った道路");
    expect(html).toContain("速度");
  });

  it("電車も高度があれば高度の欄とグラフを出す", () => {
    const withAlt = track.map((p, i) => ({ ...p, alt: 40 + i }));
    const html = tripDetailPanel({ ...trip, mode: "train", score: undefined }, false, { stats: tripStats(withAlt), ev: null, weather: null });
    expect(html).toContain("<dt>高度</dt><dd>40〜100 m</dd>");
    expect(html).toContain("高度の変化");
    expect(altChart([{ t: 0, m: 5 }, { t: 1000, m: 5 }])).toContain("<svg");
  });

  it("高度のグラフは最大の値まで入る(下端を目盛りに合わせて下げても上が切れない)", () => {
    const ticks = (svg: string) => [...svg.matchAll(/text-anchor="end">([-\d,]+)</g)].map((m) => Number(m[1].replace(/,/g, "")));
    for (const [lo, hi] of [[-17, 12389], [-5, 92], [62, 81], [0, 3000]]) {
      const t = ticks(altChart([{ t: 0, m: lo }, { t: 1000, m: hi }]));
      expect(Math.min(...t)).toBeLessThanOrEqual(lo);
      expect(Math.max(...t)).toBeGreaterThanOrEqual(hi);
    }
  });

  it("天気が取れない理由があれば出す", () => {
    expect(weatherView(null, "Open-Meteo につながりませんでした(ENOTFOUND)")).toContain("ENOTFOUND");
  });

  it("一覧の行に同乗の点数を付ける(手持ちは *)", () => {
    const html = logListPanel([{ id: "x", name: "a.gpx", size: 1, date: "2026-11-01" }], "all", true, undefined, undefined, [], { shown: new Set(), trips: [trip] });
    expect(html).toContain("66 点*");
  });
});
