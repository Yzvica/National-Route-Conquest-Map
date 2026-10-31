import { CATEGORY_LABELS, type Category, type Coverage, type RouteData, type Segment } from "./types";

export interface Progress {
  total: number;
  done: number;
}

export interface Stats {
  /** 全種別をまとめた総合。重複区間は1回だけ数える */
  overall: Progress;
  byCategory: Record<Category, Progress>;
  byRoute: Map<string, { overall: Progress; byCategory: Partial<Record<Category, Progress>> }>;
}

const empty = (): Progress => ({ total: 0, done: 0 });

/** 上下線が別の区間は半分ずつ数える(2つ合わせて道路1本分) */
export const segmentWeight = (s: Segment) => (s.pair ? 0.5 : 1);

/**
 * 上下線のどちらかを走れば、両方を走ったことにした記録。
 * 上下線の組がないデータ(国道)では、渡した記録をそのまま返す
 */
export function effectiveCoverage(data: RouteData, coverage: Coverage): Coverage {
  if (!data.segments.some((s) => s.pair)) return coverage;
  const out = new Map(coverage);
  for (const s of data.segments) {
    if (!s.pair) continue;
    const r = Math.max(coverage.get(s.id) ?? 0, coverage.get(s.pair) ?? 0);
    if (r > 0) out.set(s.id, r);
  }
  return out;
}

function add(p: Progress, len: number, ratio: number) {
  p.total += len;
  p.done += len * ratio;
}

export function computeStats(data: RouteData, coverage: Coverage): Stats {
  const stats: Stats = {
    overall: empty(),
    byCategory: Object.fromEntries((Object.keys(CATEGORY_LABELS) as Category[]).map((c) => [c, empty()])) as Record<
      Category,
      Progress
    >,
    byRoute: new Map(),
  };
  for (const seg of data.segments) {
    const r = coverage.get(seg.id) ?? 0;
    const len = seg.len * segmentWeight(seg);
    add(stats.overall, len, r);
    for (const c of seg.cats) add(stats.byCategory[c], len, r);
    // 重複区間は、それぞれの国道の制覇率には丸ごと数える
    for (const ref of seg.routes) {
      let route = stats.byRoute.get(ref);
      if (!route) stats.byRoute.set(ref, (route = { overall: empty(), byCategory: {} }));
      add(route.overall, len, r);
      for (const c of seg.cats) add((route.byCategory[c] ??= empty()), len, r);
    }
  }
  return stats;
}

export const percent = (p: Progress) => (p.total === 0 ? 0 : (p.done / p.total) * 100);
