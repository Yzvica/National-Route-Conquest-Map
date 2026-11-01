import { CATEGORY_LABELS, type Category, type Coverage, type RouteData, type Segment } from "./types";

export interface Progress {
  total: number;
  done: number;
}

/**
 * 参考として別に出し、総合・路線ごとの制覇率には入れない種別。
 * 点線国道は車で走るログでは判定しにくく(関門トンネルの人道を通ったことになるなど)、自己申告で記録する
 */
export const REFERENCE_CATS: Category[] = ["dotted"];
export const isReference = (s: Segment) => s.cats.some((c) => REFERENCE_CATS.includes(c));

/**
 * 別枠で数え、総合・路線ごとの制覇率・実績(専用のもの以外)には入れない種別。
 * 旧道(バイパスができて国道でなくなった旧ルートなど)は今の国道ではないので別に数える。判定はログで行う
 */
export const SEPARATE_CATS: Category[] = [...REFERENCE_CATS, "old"];
export const isSeparate = (s: Segment) => s.cats.some((c) => SEPARATE_CATS.includes(c));

export interface Stats {
  /** 全種別をまとめた総合(点線国道・旧道は除く)。重複区間は1回だけ数える */
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

/** 最後に集計した記録と結果(データごと)。画面を描き直すたびに36万区間を数え直さないため */
const statsCache = new WeakMap<RouteData, { coverage: Coverage; stats: Stats }>();

/** 集計する。同じデータ・同じ記録(同じ Map)なら前の結果を返すので、結果は書き換えないこと */
export function computeStats(data: RouteData, coverage: Coverage): Stats {
  const hit = statsCache.get(data);
  if (hit?.coverage === coverage) return hit.stats;
  const stats = countStats(data, coverage);
  statsCache.set(data, { coverage, stats });
  return stats;
}

function countStats(data: RouteData, coverage: Coverage): Stats {
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
    const counted = !isSeparate(seg);
    if (counted) add(stats.overall, len, r);
    for (const c of seg.cats) add(stats.byCategory[c], len, r);
    // 重複区間は、それぞれの国道の制覇率には丸ごと数える
    for (const ref of seg.routes) {
      let route = stats.byRoute.get(ref);
      if (!route) stats.byRoute.set(ref, (route = { overall: empty(), byCategory: {} }));
      if (counted) add(route.overall, len, r);
      for (const c of seg.cats) add((route.byCategory[c] ??= empty()), len, r);
    }
  }
  return stats;
}

export const percent = (p: Progress) => (p.total === 0 ? 0 : (p.done / p.total) * 100);

/**
 * 点線国道はログの判定を使わず、自己申告(国道番号ごと)で走ったことにする。
 * 申告した国道のどれかに入っている点線国道の区間を 1、それ以外の点線国道の区間を 0 にした記録を返す
 */
export function applyDeclared(data: RouteData, coverage: Coverage, declared: Set<string>): Coverage {
  if (!data.segments.some(isReference)) return coverage;
  const out = new Map(coverage);
  for (const s of data.segments) {
    if (!isReference(s)) continue;
    if (s.routes.some((r) => declared.has(r))) out.set(s.id, 1);
    else out.delete(s.id);
  }
  return out;
}
