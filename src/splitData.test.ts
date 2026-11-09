import { describe, expect, it } from "vitest";
// @ts-expect-error 型のない .mjs(Node のスクリプト)
import { splitRouteData } from "../scripts/split_data.mjs";
import fixture from "./__fixtures__/routes.json";
import { judgeLog } from "./judge";
import { openSplit, splitLoaderOf, type SplitIndex } from "./splitData";
import type { RouteData, TrackPoint } from "./types";

const base = fixture as unknown as RouteData;

/** 曲がった区間・反対車線・トンネル・旧道の名前などを足した、分けて読むためのデータ */
function sample(): RouteData {
  const segs = structuredClone(base.segments);
  segs.push(
    {
      id: "w90-0",
      routes: ["2"],
      cats: ["main"],
      len: 250,
      coords: [
        [139.4999, 35.0],
        [139.5003, 35.0004],
        [139.5008, 35.0001],
      ],
      pair: "w91-0",
      name: "旧国道2号",
      pref: 22,
      tunnel: "t5",
      prefs: [
        [22, 0.6],
        [23, 0.4],
      ],
    },
    { id: "w91-0", routes: ["2"], cats: ["main"], len: 250, coords: [[139.5008, 35.0002], [139.4999, 35.0001]], pair: "w90-0", pref: 22 },
    { id: "x-odd", routes: ["1", "2"], cats: ["bypass", "overlap"], len: 10, coords: [[140.1, 36.1], [140.1001, 36.1], [140.1002, 36.1001]], hw: "track" },
    { id: "w92-0", routes: ["2"], cats: ["main"], len: 5, coords: [[140.2, 36.2], [140.20001, 36.2]], pair: "w999-0" },
  );
  return { ...base, segments: segs };
}

function open(d: RouteData) {
  const { index, cells } = splitRouteData(d) as { index: SplitIndex; cells: Map<string, unknown> };
  const fetched: string[] = [];
  const json = JSON.parse(JSON.stringify(index)) as SplitIndex;
  const data = openSplit(json, "cells/", async (url) => {
    fetched.push(url);
    const key = url.replace(/^cells\/|\.json$/g, "");
    if (!cells.has(key)) throw new Error("ない");
    return JSON.parse(JSON.stringify(cells.get(key)));
  });
  return { data, loader: splitLoaderOf(data)!, fetched, cells };
}

describe("分けて読む道路データ", () => {
  it("一覧だけで、区間の番号・種別・長さ・両端などがもとと同じになる", () => {
    const d = sample();
    const { data } = open(d);
    expect(data.routes).toEqual(d.routes);
    expect(data.tunnels).toEqual(d.tunnels);
    expect(data.segments).toHaveLength(d.segments.length);
    data.segments.forEach((s, i) => {
      const { coords, ...rest } = d.segments[i];
      expect(s).toMatchObject(rest);
      expect(Object.keys(s).sort()).toEqual(Object.keys(d.segments[i]).sort());
      expect(s.coords[0]).toEqual(coords[0]);
      expect(s.coords[s.coords.length - 1]).toEqual(coords[coords.length - 1]);
    });
    // 曲がった区間は、マスを読むまでは両端だけ
    expect(data.segments.find((s) => s.id === "w90-0")!.coords).toHaveLength(2);
  });

  it("マスを読むと区間の形が本当のものになり、読んだ区間を知らせる", async () => {
    const d = sample();
    const { data, loader } = open(d);
    const changed: number[] = [];
    loader.onLoad((segs) => changed.push(...segs));
    await loader.load(loader.cellsIn(139.4, 34.9, 139.6, 35.1));
    const i = data.segments.findIndex((s) => s.id === "w90-0");
    expect(data.segments[i].coords).toEqual(d.segments[i].coords);
    expect(changed).toContain(i);
    expect(loader.hasShape(i)).toBe(true);
    // 遠くの区間はまだ読んでいない
    const far = data.segments.findIndex((s) => s.id === "x-odd");
    expect(loader.hasShape(far)).toBe(false);
    await loader.load(loader.cellsIn(122, 20, 154, 46));
    data.segments.forEach((s, n) => expect(s.coords).toEqual(d.segments[n].coords));
  });

  it("同じマスは一度だけ読む", async () => {
    const { loader, fetched } = open(sample());
    const keys = loader.cellsIn(139.4, 34.9, 139.6, 35.1);
    await Promise.all([loader.load(keys), loader.load(keys)]);
    await loader.load(keys);
    expect(fetched).toHaveLength(keys.length);
  });

  it("ログの判定の前に、ログの通った場所のマスを読み、全部読んだデータと同じ結果になる", async () => {
    const d = sample();
    const { data, fetched } = open(d);
    const track: TrackPoint[] = Array.from({ length: 41 }, (_, k) => ({
      lon: 139.0 + (0.01 * k) / 40,
      lat: 35.0,
      time: k * 3000,
    }));
    const loadPref = async () => undefined;
    const csv = "time,lat,lon\n" + track.map((p) => `${new Date(p.time!).toISOString()},${p.lat},${p.lon}`).join("\n");
    const a = await judgeLog(csv, "a.csv", 0, { kokudo: d, loadPref });
    const b = await judgeLog(csv, "a.csv", 0, { kokudo: data, loadPref });
    expect(a.coverage.size).toBeGreaterThan(0);
    expect([...b.coverage].sort()).toEqual([...a.coverage].sort());
    expect(fetched.length).toBeGreaterThan(0);
  });
});
