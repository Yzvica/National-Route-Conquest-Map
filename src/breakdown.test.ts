import { describe, expect, it } from "vitest";
import { categoryBreakdown, overlapsOf } from "./breakdown";
import type { RouteData, Segment } from "./types";

const seg = (id: string, routes: string[], cats: Segment["cats"], len = 100): Segment => ({
  id, routes, cats, len, coords: [[0, 0], [0, 0.001]],
});
const data: RouteData = {
  version: 1,
  generatedAt: "",
  routes: {},
  tunnels: [],
  segments: [
    seg("a", ["4"], ["main"]),
    seg("b", ["4"], ["bypass"]),
    seg("c", ["4", "6"], ["main", "overlap"]),
    seg("d", ["6", "4"], ["bypass", "overlap"], 50),
    seg("e", ["6", "14"], ["main", "overlap"]),
    seg("f", ["10"], ["dotted"]),
  ],
};
const coverage = new Map([["b", 1], ["c", 0.5]]);

describe("categoryBreakdown", () => {
  it("バイパスを国道ごとにまとめる(重複していれば両方に数える)", () => {
    const items = categoryBreakdown(data, coverage, "bypass");
    expect(items.map((i) => [i.key, i.progress.total, i.progress.done])).toEqual([
      ["4", 150, 100],
      ["6", 50, 0],
    ]);
  });

  it("重複区間は重なっている国道の組み合わせごとにまとめる", () => {
    const items = categoryBreakdown(data, coverage, "overlap");
    expect(items.map((i) => [i.key, i.segIds])).toEqual([
      ["4,6", ["c", "d"]],
      ["6,14", ["e"]],
    ]);
  });
});

describe("overlapsOf", () => {
  it("国道6号と重なっている国道と、その区間", () => {
    const items = overlapsOf(data, coverage, "6");
    expect(items.map((i) => [i.key, i.progress.total, i.segIds])).toEqual([
      ["4", 150, ["c", "d"]],
      ["14", 100, ["e"]],
    ]);
  });
});
