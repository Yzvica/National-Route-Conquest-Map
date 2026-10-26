import { describe, expect, it } from "vitest";
import { parseTime, parseTrackCsv } from "./csv";

describe("parseTrackCsv", () => {
  it("英語・日本語どちらのヘッダーでも緯度経度と時刻を読む", () => {
    const en = parseTrackCsv("time,latitude,longitude\n2026-10-26T10:00:00Z,35.1,139.2\n");
    expect(en).toEqual([{ lat: 35.1, lon: 139.2, time: Date.parse("2026-10-26T10:00:00Z") }]);
    const ja = parseTrackCsv('﻿"日時","緯度","経度"\r\n"2026/10/26 10:00:00",35.1,139.2\r\n');
    expect(ja[0].lat).toBe(35.1);
    expect(ja[0].time).toBe(Date.parse("2026-10-26T10:00:00"));
  });

  it("緯度経度が0や空の行は飛ばす", () => {
    expect(parseTrackCsv("lat,lon\n0,0\n,\n35,139\n")).toEqual([{ lat: 35, lon: 139, time: undefined }]);
  });

  it("緯度経度の列がなければエラーにする", () => {
    expect(() => parseTrackCsv("a,b\n1,2\n")).toThrow(/緯度・経度/);
  });
});

describe("parseTime", () => {
  it("UNIX 秒とミリ秒を区別する", () => {
    expect(parseTime("1761475200")).toBe(1761475200000);
    expect(parseTime("1761475200000")).toBe(1761475200000);
  });
});
