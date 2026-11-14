import { describe, expect, it } from "vitest";
import { bearing, frameAt, gbowlReplay, gpsReplay, hasMotion, indexAt, interp, movingAverage, nearestTime, niceMax, parseReplayCsv } from "./replay";

/** GBowl の CSV を作る。f(秒) → [横G(左+), 前後G(後ろ+), km/h] */
function gbowlCsv(seconds: number, f: (t: number) => [number, number, number]) {
  const lines = [
    "#GBOWLCSV,2026-09-19 20:05:37 (13m) DriverA",
    "Create Version,13.6.5",
    "Time(sec), X(G), Y(G), Raw X(G), Raw Y(G), Speed(km/h), Latitude(deg), Longitude(deg), Course(deg), Score Memo",
  ];
  let lat = 35.1;
  for (let i = 0; i <= seconds * 10; i++) {
    const t = i / 10;
    const [gx, gy, v] = f(t);
    lat += v / 3.6 / 10 / 111_000;
    lines.push(`${t.toFixed(1)}, 0,0,${gx.toFixed(4)},${gy.toFixed(4)},${v.toFixed(2)},${lat.toFixed(10)},139.2000000000,0,`);
  }
  return lines.join("\n");
}

describe("replay.csv(アプリが作るもの)", () => {
  it("列を見出しで読み、空欄の G は 0 にする", () => {
    const d = parseReplayCsv("unix_s,lat,lon,kmh,lon_g,lat_g,jerk\n100.0,35,139,10,0.1,-0.2,0.5\n100.5,35.0001,139,12,,0.1,\n101.0,35.0002,139,14,0.2,0,1\n")!;
    expect(d.t).toEqual([100000, 100500, 101000]);
    expect(d.kmh).toEqual([10, 12, 14]);
    expect(d.lonG).toEqual([0.1, 0, 0.2]);
    expect(d.jerk).toEqual([0.5, 0, 1]);
    expect(hasMotion(d)).toBe(true);
    expect(d.source).toBe("app");
  });

  it("G の列がなければ速度だけ、位置の列がなければ null", () => {
    const d = parseReplayCsv("unix_s,lat,lon,kmh\n1,35,139,0\n2,35,139,1\n")!;
    expect(hasMotion(d)).toBe(false);
    expect(parseReplayCsv("a,b\n1,2\n3,4\n")).toBeNull();
  });
});

describe("GBowl の CSV から作る", () => {
  const start = Date.parse("2026-09-19T20:05:37+09:00");

  it("加速度の列から前後G・横G・躍度を出す(前後は後ろ+ → 加速+、横は左+のまま)", () => {
    // 10〜20 秒は 0.2G で加速(Raw Y = -0.2)しながら、左に 0.1G
    const d = gbowlReplay(gbowlCsv(40, (t) => (t >= 10 && t < 20 ? [0.1, -0.2, (t - 10) * 7] : [0, 0, t < 10 ? 0 : 70])))!;
    expect(d.source).toBe("gbowl");
    expect(d.t[0]).toBe(start);
    expect(d.t[1] - d.t[0]).toBeCloseTo(100);
    const at = (s: number) => indexAt(d.t, start + s * 1000);
    expect(d.lonG![at(15)]).toBeCloseTo(0.2, 1);
    expect(d.latG![at(15)]).toBeCloseTo(0.1, 2);
    expect(Math.abs(d.lonG![at(30)])).toBeLessThan(0.05);
    // 加速を始めたところで躍度が立つ
    expect(Math.max(...d.jerk!.slice(at(9), at(11)))).toBeGreaterThan(1);
    expect(d.jerk![at(30)]).toBeLessThan(0.1);
  });

  it("坂で止まっていて前後 G が残っていても、坂の分を引く", () => {
    const d = gbowlReplay(gbowlCsv(60, () => [0, 0.1, 0]))!;
    expect(Math.abs(d.lonG![300])).toBeLessThan(0.02);
  });

  it("加速度の列がない CSV は null", () => {
    expect(gbowlReplay("#GBOWLCSV,2026-09-19 20:05:37 (13m) DriverA\nTime(sec),Latitude(deg),Longitude(deg)\n0,35,139\n")).toBeNull();
    expect(gbowlReplay("lat,lon\n35,139\n")).toBeNull();
  });
});

describe("位置と速度だけ", () => {
  it("時刻のある点だけで作り、速度は近い時刻の値を補う", () => {
    const d = gpsReplay(
      [
        { lat: 35, lon: 139, time: 0 },
        { lat: 35.001, lon: 139 },
        { lat: 35.002, lon: 139, time: 10_000 },
      ],
      [
        { t: 0, kmh: 0 },
        { t: 10_000, kmh: 40 },
      ],
    )!;
    expect(d.t).toEqual([0, 10_000]);
    expect(d.kmh).toEqual([0, 40]);
    expect(hasMotion(d)).toBe(false);
    expect(gpsReplay([{ lat: 35, lon: 139 }], [])).toBeNull();
  });
});

describe("時刻の値", () => {
  it("線形に補い、範囲の外は端の値", () => {
    expect(interp([0, 10], [0, 100], 5)).toBe(50);
    expect(interp([0, 10], [0, 100], -1)).toBe(0);
    expect(interp([0, 10], [0, 100], 11)).toBe(100);
    expect(indexAt([0, 10, 20], 15)).toBe(1);
    expect(indexAt([0, 10, 20], 20)).toBe(2);
  });

  it("進む向きは北が 0・東が 90、止まっていれば undefined", () => {
    expect(bearing([139, 35], [139, 35.01])).toBeCloseTo(0);
    expect(bearing([139, 35], [139.01, 35])).toBeCloseTo(90, 0);
    const d = parseReplayCsv("unix_s,lat,lon,kmh\n0,35,139,0\n10,35,139.001,30\n20,35,139.002,30\n")!;
    expect(frameAt(d, 10_000).bearing).toBeCloseTo(90, 0);
    const still = parseReplayCsv("unix_s,lat,lon,kmh\n0,35,139,0\n10,35,139,0\n")!;
    expect(frameAt(still, 5000).bearing).toBeUndefined();
  });

  it("地図で押した点に近い時刻(遠ければ undefined)", () => {
    const d = parseReplayCsv("unix_s,lat,lon,kmh\n0,0,0,0\n1,0,10,0\n2,0,20,0\n")!;
    const project = (lon: number, lat: number) => ({ x: lon, y: lat });
    expect(nearestTime(d, project, { x: 11, y: 1 })).toBe(1000);
    expect(nearestTime(d, project, { x: 11, y: 100 })).toBeUndefined();
  });

  it("ならしと縦軸の上限", () => {
    expect(movingAverage([0, 0, 3, 0, 0], 1)).toEqual([0, 1, 1, 1, 0]);
    expect(niceMax([0.1, 0.2, -0.3], 0.4, 0.1, 1.2)).toBe(0.4);
    expect(niceMax([0.7], 0.4, 0.1, 1.2)).toBeCloseTo(0.8);
    expect(niceMax([95], 20, 20, 400)).toBe(120);
  });
});
