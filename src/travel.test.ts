import { describe, expect, it } from "vitest";
import { describeTrip, toGeoJSON, type TravelTrip } from "./travel";

const trip = (o: Partial<TravelTrip>): TravelTrip => ({
  id: "x", mode: "train", start: null, end: null, m: 0, maxAltM: null, lines: [], gaps: [], ...o,
});

describe("旅の記録", () => {
  it("実線と点線を、移動の番号と手段つきの線にする", () => {
    const fc = toGeoJSON([trip({ lines: [[[139, 35], [139.1, 35]]], gaps: [[[139.1, 35], [139.5, 35]]] }), trip({ mode: "plane", lines: [[[130, 33], [139, 35]]] })]);
    expect(fc.features.map((f: { properties: unknown }) => f.properties)).toEqual([
      { i: 0, mode: "train", gap: 0 },
      { i: 0, mode: "train", gap: 1 },
      { i: 1, mode: "plane", gap: 0 },
    ]);
  });

  it("説明は日本時間で、飛行機は最高高度も出す", () => {
    expect(describeTrip(trip({ mode: "plane", start: "2026-11-09T00:10:00Z", end: "2026-11-09T01:40:00Z", m: 922_300, maxAltM: 12388 }))).toEqual([
      "✈️ 飛行機",
      "2026-11-09 09:10〜10:40",
      "922km / 1時間30分 / 最高 12,388m",
    ]);
    expect(describeTrip(trip({ start: "2026-11-09T14:50:00Z", end: "2026-11-09T15:20:00Z", m: 12_345 }))).toEqual([
      "🚆 電車",
      "2026-11-09 23:50〜2026-11-10 00:20",
      "12.3km / 30分",
    ]);
  });
});
