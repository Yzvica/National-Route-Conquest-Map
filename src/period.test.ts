import { describe, expect, it } from "vitest";
import { makePeriod, periodItems, periodList, periodSummary } from "./period";
import type { TravelTrip } from "./travel";

const trip = (o: Partial<TravelTrip>): TravelTrip => ({ id: "t", mode: "train", start: null, end: null, m: 0, maxAltM: null, lines: [], gaps: [], ...o });

describe("期間を指定", () => {
  it("逆に入れた日付は入れ替え、片方だけなら1日にする", () => {
    expect(makePeriod("2026-11-09", "2026-11-07")).toEqual({ from: "2026-11-07", to: "2026-11-09" });
    expect(makePeriod("", "2026-11-08")).toEqual({ from: "2026-11-08", to: "2026-11-08" });
    expect(makePeriod("", "")).toBeNull();
  });

  it("期間の車のログと旅の記録を、時刻の順に並べる(日付は日本時間)", () => {
    const logs = [
      { id: "1-a.gz", name: "a", size: 1, date: "2026-11-08", m: 30000 },
      { id: "2-b.gz", name: "b", size: 1, date: "2026-11-09", m: 12000 },
      { id: "3-c.gz", name: "c", size: 1, date: "2026-11-10", m: 5000 },
    ];
    const trips = [
      // 日本時間 11/9 08:00 の飛行機
      trip({ id: "p", mode: "plane", start: "2026-11-08T23:00:00Z", m: 900000 }),
      trip({ id: "q", start: "2026-11-06T01:00:00Z", m: 1000 }),
    ];
    const starts = new Map([["2-b.gz", Date.parse("2026-11-09T12:00:00+09:00")]]);
    const items = periodItems(logs, trips, { from: "2026-11-08", to: "2026-11-09" }, starts);
    expect(items.map((i) => (i.kind === "log" ? i.log.id : i.trip.id))).toEqual(["1-a.gz", "p", "2-b.gz"]);
    expect(periodSummary(items)).toBe("🚗 運転 2本 42 km・✈️ 飛行機 1回 900 km(合計 942 km)");
    const html = periodList(items, new Set(["2-b.gz"]), "2-b.gz");
    expect(html).toContain("2026-11-09(月)");
    expect(html).toContain('data-trip-open="p"');
    expect(html).toContain("12:00");
    expect(periodSummary([])).toBe("この期間の記録はありません");
  });
});

describe("旅行の表示", () => {
  it("期間を短く書く", async () => {
    const { shortPeriod } = await import("./period");
    expect(shortPeriod({ from: "2026-11-07", to: "2026-11-10" }, "2026")).toBe("11/7〜11/10");
    expect(shortPeriod({ from: "2025-12-31", to: "2026-01-02" }, "2026")).toBe("2025/12/31〜1/2");
    expect(shortPeriod({ from: "2026-03-01", to: "2026-03-01" }, "2026")).toBe("3/1");
  });
});

describe("旅行から外す", () => {
  it("外したものは一覧の下にまとめ、合計からも除く", async () => {
    const { includedItems, periodItems, periodList } = await import("./period");
    const logs = [
      { id: "1-a.gz", name: "a", size: 1, date: "2026-11-08", m: 30000 },
      { id: "2-b.gz", name: "b", size: 1, date: "2026-11-09", m: 12000 },
    ];
    const items = periodItems(logs, [], { from: "2026-11-08", to: "2026-11-09" });
    expect(includedItems(items, ["log:2-b.gz"]).map((i) => (i.kind === "log" ? i.log.id : ""))).toEqual(["1-a.gz"]);
    const html = periodList(items, new Set(), undefined, new Set(["log:2-b.gz"]));
    expect(html).toContain('data-exclude="log:1-a.gz"');
    expect(html).toContain('data-include="log:2-b.gz"');
    expect(html).toContain("この旅行から外したもの(1)");
    expect(html).not.toContain("2026-11-09(月)");
    expect(periodList(items, new Set())).not.toContain("data-exclude");
  });
});
