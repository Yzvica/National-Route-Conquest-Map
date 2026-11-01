import { segmentWeight, type Progress } from "./stats";
import type { Category, Coverage, RouteData } from "./types";

export interface BreakdownItem {
  /** 国道ごとなら国道番号、重複区間なら重なっている国道番号を "," でつないだもの */
  key: string;
  refs: string[];
  progress: Progress;
  segIds: string[];
}

const byRef = (a: string, b: string) => Number(a) - Number(b) || a.localeCompare(b);

function collect(items: Map<string, BreakdownItem>, key: string, refs: string[], id: string, len: number, r: number) {
  let item = items.get(key);
  if (!item) items.set(key, (item = { key, refs, progress: { total: 0, done: 0 }, segIds: [] }));
  item.progress.total += len;
  item.progress.done += len * r;
  item.segIds.push(id);
}

/**
 * 種別(点線国道・バイパスなど)の内訳。国道ごとにまとめる。
 * 重複区間だけは「どの国道どうしが重なっているか」の組み合わせごとにまとめる。
 */
export function categoryBreakdown(data: RouteData, coverage: Coverage, cat: Category): BreakdownItem[] {
  const items = new Map<string, BreakdownItem>();
  for (const s of data.segments) {
    if (!s.cats.includes(cat)) continue;
    const r = coverage.get(s.id) ?? 0;
    if (cat === "overlap") {
      const refs = [...s.routes].sort(byRef);
      collect(items, refs.join(","), refs, s.id, s.len * segmentWeight(s), r);
    } else {
      for (const ref of s.routes) collect(items, ref, [ref], s.id, s.len * segmentWeight(s), r);
    }
  }
  return [...items.values()].sort((a, b) => byRef(a.refs[0], b.refs[0]) || byRef(a.key, b.key));
}

/** ある国道と重なっているほかの国道ごとの、重なっている区間 */
export function overlapsOf(data: RouteData, coverage: Coverage, ref: string): BreakdownItem[] {
  const items = new Map<string, BreakdownItem>();
  for (const s of data.segments) {
    if (s.routes.length < 2 || !s.routes.includes(ref)) continue;
    const r = coverage.get(s.id) ?? 0;
    for (const other of s.routes) if (other !== ref) collect(items, other, [other], s.id, s.len * segmentWeight(s), r);
  }
  return [...items.values()].sort((a, b) => byRef(a.key, b.key));
}

/** ある路線の区間の通称(「三宿通り」など)ごとの区間。区間に名前のあるデータ(都道府県道)だけ。長い順 */
export function nicknamesOf(data: RouteData, coverage: Coverage, ref: string): BreakdownItem[] {
  const items = new Map<string, BreakdownItem>();
  for (const s of data.segments) {
    if (!s.name || !s.routes.includes(ref)) continue;
    collect(items, s.name, [ref], s.id, s.len * segmentWeight(s), coverage.get(s.id) ?? 0);
  }
  return [...items.values()].sort((a, b) => b.progress.total - a.progress.total);
}
