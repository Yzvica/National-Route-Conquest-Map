import type { Category, Coverage, RouteData } from "./types";

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

function add(p: Progress, len: number, ratio: number) {
  p.total += len;
  p.done += len * ratio;
}

export function computeStats(data: RouteData, coverage: Coverage): Stats {
  const stats: Stats = {
    overall: empty(),
    byCategory: { main: empty(), bypass: empty(), dotted: empty(), ferry: empty(), overlap: empty() },
    byRoute: new Map(),
  };
  for (const seg of data.segments) {
    const r = coverage.get(seg.id) ?? 0;
    add(stats.overall, seg.len, r);
    for (const c of seg.cats) add(stats.byCategory[c], seg.len, r);
    // 重複区間は、それぞれの国道の制覇率には丸ごと数える
    for (const ref of seg.routes) {
      let route = stats.byRoute.get(ref);
      if (!route) stats.byRoute.set(ref, (route = { overall: empty(), byCategory: {} }));
      add(route.overall, seg.len, r);
      for (const c of seg.cats) add((route.byCategory[c] ??= empty()), seg.len, r);
    }
  }
  return stats;
}

export const percent = (p: Progress) => (p.total === 0 ? 0 : (p.done / p.total) * 100);
