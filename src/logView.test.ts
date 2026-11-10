import { describe, expect, it } from "vitest";
import { logDetailPanel, logListPanel, passedRoutes, shownLogs, speedChart, tripStats, weatherPoints } from "./logView";
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
