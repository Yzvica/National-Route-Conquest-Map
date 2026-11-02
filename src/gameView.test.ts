import { describe, expect, it } from "vitest";
import { sortLogs } from "./gameView";

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
});
