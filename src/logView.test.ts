import { describe, expect, it } from "vitest";
import { logDetailPanel, logListPanel, passedRoutes, shownLogs, speedChart, tripStats } from "./logView";
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
    expect(logListPanel(logs, "all", true, logs[1].id)).toMatch(/<li class="selected"[^>]*><a href="#" data-log-open="2-b\.csv\.gz"/);
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
});
