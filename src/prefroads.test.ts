import { describe, expect, it } from "vitest";
import { comparePrefRefs, mergePrefData, prefsOfTrack } from "./prefroads";
import type { PrefRoadIndex, RouteData, Segment } from "./types";

const seg = (id: string, routes: string[], cats: Segment["cats"] = ["general"]): Segment => ({
  id,
  routes,
  cats,
  len: 100,
  coords: [
    [139.5, 35.6],
    [139.501, 35.6],
  ],
});
const file = (routes: string[], segments: Segment[]): RouteData => ({
  version: 1,
  kind: "prefroad",
  generatedAt: "2026-11-01",
  routes: Object.fromEntries(routes.map((r) => [r, { name: r }])),
  segments,
  tunnels: [],
});

describe("mergePrefData", () => {
  it("都道府県ごとのファイルをまとめ、両方にある区間は重複にする", () => {
    const tokyo = file(["13-1"], [seg("p1-0", ["13-1"]), seg("p2-0", ["13-1"], ["major"])]);
    const kanagawa = file(["14-5"], [seg("p2-0", ["14-5"]), seg("p3-0", ["14-5"])]);
    const d = mergePrefData([tokyo, kanagawa]);
    expect(d.kind).toBe("prefroad");
    expect(Object.keys(d.routes)).toEqual(["13-1", "14-5"]);
    expect(d.segments.map((s) => s.id)).toEqual(["p1-0", "p2-0", "p3-0"]);
    const border = d.segments.find((s) => s.id === "p2-0")!;
    expect(border.routes).toEqual(["13-1", "14-5"]);
    expect(border.cats).toEqual(["major", "overlap"]);
    // 元のファイルの区間は書き換えない(ほかの組み合わせでも使い回すため)
    expect(tokyo.segments[1].routes).toEqual(["13-1"]);
  });
});

describe("prefsOfTrack", () => {
  const index: PrefRoadIndex = {
    version: 1,
    generatedAt: "",
    cell: 0.1,
    prefs: {
      "13": { name: "東京都", routes: 1, km: 1, bytes: 1, cells: [1395356] },
      "14": { name: "神奈川県", routes: 1, km: 1, bytes: 1, cells: [1395354] },
    },
  };
  it("ログの点がある格子に道がある都道府県を返す", () => {
    expect(prefsOfTrack(index, [{ lat: 35.65, lon: 139.55 }])).toEqual([13]);
    expect(prefsOfTrack(index, [{ lat: 35.45, lon: 139.55 }, { lat: 35.65, lon: 139.55 }])).toEqual([13, 14]);
    expect(prefsOfTrack(index, [{ lat: 43, lon: 141 }])).toEqual([]);
  });
});

it("comparePrefRefs は都道府県コード順、その中は番号順", () => {
  expect(["14-2", "13-413", "13-8", "1-100"].sort(comparePrefRefs)).toEqual(["1-100", "13-8", "13-413", "14-2"]);
});
