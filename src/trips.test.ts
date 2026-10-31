import { describe, expect, it } from "vitest";
import { trackLength, tripKey } from "./trips";

// 緯度 0.001 度 ≒ 111m
const p = (lat: number, time?: number) => ({ lat, lon: 139, time });

describe("trackLength", () => {
  it("点の間の距離を足す", () => {
    expect(trackLength([p(35, 0), p(35.001, 10_000), p(35.002, 20_000)])).toBeCloseTo(222, -1);
  });

  it("GPS が途切れても、速さが普通なら足し、ありえない飛びは足さない", () => {
    // 5.5km を 5分(時速66km)
    expect(trackLength([p(35, 0), p(35.05, 300_000)])).toBeGreaterThan(5000);
    // 5.5km を 10秒
    expect(trackLength([p(35, 0), p(35.05, 10_000)])).toBe(0);
    // 時刻がなければ 2km より離れた点の間は足さない
    expect(trackLength([p(35), p(35.05)])).toBe(0);
  });

  it("同じログは同じ名前になる", () => {
    expect(tripKey([p(35, 123)], "2026-01-01")).toBe("t123");
    expect(tripKey([p(35), p(36)], "2026-01-01")).toBe("d2026-01-01-2");
  });
});
