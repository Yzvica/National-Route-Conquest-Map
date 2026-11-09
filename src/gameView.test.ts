import { describe, expect, it } from "vitest";
import { driveEvalView, sortLogs } from "./gameView";

describe("sortLogs", () => {
  it("日付の新しい順に並べ、日付のないログは保存した順に最後へ", () => {
    const logs = [
      { id: "100-a.gpx", name: "a.gpx", size: 1, date: "2022-02-26", m: 1 },
      { id: "200-b.gpx", name: "b.gpx", size: 1 },
      { id: "300-c.gpx", name: "c.gpx", size: 1, date: "2023-02-01", m: 1 },
      { id: "400-d.gpx", name: "d.gpx", size: 1 },
      { id: "500-e.gpx", name: "e.gpx", size: 1, date: "2022-02-26", m: 1 },
    ];
    expect(sortLogs(logs).map((l) => l.name)).toEqual(["c.gpx", "e.gpx", "a.gpx", "d.gpx", "b.gpx"]);
  });

  it("同じ日は走り始めた時刻の新しい順(保存した順ではない)", () => {
    const logs = [
      { id: "100-morning.gpx", name: "morning.gpx", size: 1, date: "2026-11-09", m: 1, start: Date.parse("2026-11-09T08:00:00+09:00") },
      { id: "300-noon.gpx", name: "noon.gpx", size: 1, date: "2026-11-09", m: 1, start: Date.parse("2026-11-09T12:00:00+09:00") },
      { id: "200-night.gpx", name: "night.gpx", size: 1, date: "2026-11-09", m: 1, start: Date.parse("2026-11-09T21:00:00+09:00") },
      { id: "400-unknown.gpx", name: "unknown.gpx", size: 1, date: "2026-11-09", m: 1 },
    ];
    expect(sortLogs(logs).map((l) => l.name)).toEqual(["night.gpx", "noon.gpx", "morning.gpx", "unknown.gpx"]);
  });
});

describe("driveEvalView", () => {
  it("総合点・項目・出来事を出す", () => {
    const html = driveEvalView({
      id: "1-20261108-002228.gpx.gz",
      ev: {
        score: 59,
        moving_s: 1260,
        stops: 14,
        items: [{ key: "sick", name: "酔いやすさ", value: 0.487, score: 25.2, weight: 0.3, good: 0.15, bad: 0.6 }],
        events: [{ kind: "急ハンドル", type: "steer", value: 0.337, unit: "G", t_unix: 1762529000, lat: 35, lon: 139, kmh: 32 }],
      },
    });
    expect(html).toContain("59</span> 点");
    expect(html).toContain("酔いやすさ");
    expect(html).toContain("急ハンドル 0.34G");
    expect(html).toContain("停止 14 回");
  });
});
