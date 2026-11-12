import { describe, expect, it } from "vitest";
import { cardFileName, linesBounds, logCardInfo, mergeRoutes, periodCardInfo, rangeLabel, routeSections } from "./shareCard";
import type { PeriodItem } from "./period";
import type { TravelTrip } from "./travel";

const trip = (o: Partial<TravelTrip>): TravelTrip => ({ id: "t", mode: "train", start: null, end: null, m: 0, maxAltM: null, lines: [], gaps: [], ...o });

describe("まとめ画像", () => {
  it("期間は曜日と日数つき。同じ年なら2つめに年を付けない", () => {
    expect(rangeLabel("2026-11-07", "2026-11-10")).toBe("2026/11/7(土)〜11/10(火)・4日間");
    expect(rangeLabel("2026-12-31", "2027-01-01")).toBe("2026/12/31(木)〜2027/1/1(金)・2日間");
    expect(rangeLabel("2026-11-07", "2026-11-07")).toBe("2026/11/7(土)");
  });

  it("何本ものログで通った路線を足し合わせ、国道は番号の順に並べる", () => {
    const a = [
      { kind: "kokudo" as const, ref: "20", name: "国道20号", m: 5000 },
      { kind: "kokudo" as const, ref: "1", name: "国道1号", m: 1000 },
    ];
    const b = [
      { kind: "kokudo" as const, ref: "20", name: "国道20号", m: 3000 },
      { kind: "expressway" as const, ref: "E20", name: "中央自動車道", m: 9000 },
    ];
    const merged = mergeRoutes([a, b]);
    expect(merged.find((r) => r.ref === "20")!.m).toBe(8000);
    const secs = routeSections(merged);
    expect(secs.map((s) => s.label)).toEqual(["通った国道", "通った高速道路"]);
    expect(secs[0].names).toEqual(["国道1号", "国道20号"]);
    expect(routeSections(null)).toEqual([]);
  });

  it("旅行のまとめ: 合計・運転・評価の平均と、手段ごとの内訳", () => {
    const items: PeriodItem[] = [
      { kind: "log", log: { id: "a", name: "a", size: 1, date: "2026-11-07", m: 120_000, score: 80 }, day: "2026-11-07", start: 0 },
      { kind: "log", log: { id: "b", name: "b", size: 1, date: "2026-11-08", m: 30_000, score: 90 }, day: "2026-11-08", start: 1 },
      { kind: "trip", trip: trip({ m: 50_000 }), day: "2026-11-09", start: 2 },
    ];
    const info = periodCardInfo({ title: "🧳 九州旅行", from: "2026-11-07", to: "2026-11-09", items, routes: [{ kind: "kokudo", ref: "3", name: "国道3号", m: 1 }], overall: 12.345 });
    expect(info.subtitle).toBe("2026/11/7(土)〜11/9(月)・3日間");
    expect(info.tiles.map((t) => `${t.label}=${t.value}`)).toEqual(["合計の距離=200", "運転=150", "運転評価の平均=85", "通った国道=1"]);
    expect(info.rows.map((r) => r.text)).toEqual(["🚗 運転 2本・150 km", "🚆 電車 1回・50 km"]);
    expect(info.footer).toContain("12.35%");
  });

  it("1本のログのまとめ(時刻は日本時間)", () => {
    const start = Date.parse("2026-11-07T09:30:00+09:00");
    const info = logCardInfo(
      { id: "a", name: "20261107-093000.gpx", size: 1, date: "2026-11-07", m: 42_000, score: 76.4, weather: { icon: "☀️", label: "晴れ", tMin: 11.6, tMax: 18.2 } },
      { start, end: start + 90 * 60_000, totalMs: 90 * 60_000, movingMs: 75 * 60_000, m: 42_000, avgKmh: 33.6, maxKmh: 80, speeds: [] },
      null,
    );
    expect(info.title).toBe("🚗 11/7(土)のドライブ");
    expect(info.subtitle).toBe("2026/11/7(土)・9:30〜11:00・20261107-093000.gpx");
    expect(info.tiles.map((t) => t.value)).toEqual(["42", "1時間15分", "34", "76"]);
    expect(info.rows[1].text).toBe("☀️ 晴れ 12〜18℃");
    expect(info.routes).toEqual([]);
  });

  it("線の範囲とファイル名", () => {
    expect(linesBounds([{ coords: [[139, 35], [140, 36]], color: "" }, { coords: [[138, 35.5]], color: "" }])).toEqual([[138, 35], [140, 36]]);
    expect(linesBounds([])).toBeNull();
    expect(cardFileName("🧳 九州 旅行/2026")).toBe("九州_旅行_2026.png");
  });
});
