// iPhone アプリ(走行ロガー)の音声案内に渡すデータを、ナビの道筋(navi.ts の NaviPlan)から作る。
// 曲がる所(交差点で向きが変わる所)・道が変わる所・高速道路の出入りを「案内」にし、道筋の線は間引いて渡す。
// アプリは家の Wi-Fi で受け取って端末に保存し、走行中は MiniPC につながらなくても案内できる。
import { FREE_REF, dist, isExpRef, type NaviPlan } from "./navi";
import type { LonLat } from "./types";

/** 案内の種類 */
export type GuideKind = "turn" | "road" | "enterExp" | "jct" | "exitExp" | "free" | "arrive";

export interface GuideManeuver {
  /** 間引いた道筋(pts)の添字 */
  i: number;
  /** 道筋の最初からの距離(m) */
  at: number;
  kind: GuideKind;
  /** 向き(-180〜180 度。右がプラス) */
  angle: number;
  /** 読み上げる文(「300メートル先、」などはアプリが前に付ける) */
  text: string;
  /** その先の道の名前(なければ空) */
  road: string;
}

export interface NaviGuide {
  v: 1;
  name: string;
  /** 道筋の長さ(m) */
  length: number;
  /** 間引いた道筋 [緯度, 経度, 緯度, 経度, ...](小数5桁) */
  pts: number[];
  man: GuideManeuver[];
  /** 道の名前が変わる所(画面に今の道を出す) */
  roads: { i: number; name: string }[];
  /** 一般道(データにない道。アプリは Apple の経路で案内する)の区間 [始めの添字, 終わりの添字] */
  free: [number, number][];
  /** 高速道路の区間 [始めの添字, 終わりの添字] */
  exp: [number, number][];
}

/** 交差点で「曲がる」とみなす角度 */
export const TURN_ANGLE = 35;
/** 向きを測る長さ(交差点の前後この m の向きを比べる) */
const ARM = 40;
/** これより近い案内はまとめる(m) */
const MERGE = 50;
/** 線を間引くときに許すずれ(m) */
const SIMPLIFY = 3;

const RAD = Math.PI / 180;

/** a から b への方位(度。北が 0、東が 90) */
function bearing(a: LonLat, b: LonLat): number {
  const x = (b[0] - a[0]) * Math.cos(((a[1] + b[1]) / 2) * RAD);
  const y = b[1] - a[1];
  return Math.atan2(x, y) / RAD;
}

const norm = (d: number) => ((((d + 180) % 360) + 360) % 360) - 180;

/** 道筋の最初から m の位置(間を補う) */
function pointAt(path: LonLat[], acc: number[], m: number): LonLat {
  if (m <= 0) return path[0];
  const end = path.length - 1;
  if (m >= acc[end]) return path[end];
  let lo = 0;
  let hi = end;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (acc[mid] <= m) lo = mid;
    else hi = mid;
  }
  const t = (m - acc[lo]) / Math.max(1e-9, acc[hi] - acc[lo]);
  return [path[lo][0] + (path[hi][0] - path[lo][0]) * t, path[lo][1] + (path[hi][1] - path[lo][1]) * t];
}

/** 道筋の m の所で向きが何度変わるか(右がプラス) */
export function turnAngle(path: LonLat[], acc: number[], m: number, arm = ARM): number {
  const p = pointAt(path, acc, m);
  const a = pointAt(path, acc, m - arm);
  const b = pointAt(path, acc, m + arm);
  if (dist(a, p) < 1 || dist(p, b) < 1) return 0;
  return norm(bearing(p, b) - bearing(a, p));
}

/** 曲がり方の言葉 */
export function turnWord(angle: number): string {
  const a = Math.abs(angle);
  const side = angle > 0 ? "右" : "左";
  if (a < 25) return "直進";
  if (a < 55) return `斜め${side}`;
  if (a < 150) return `${side}折`;
  return "Uターン";
}

/** 分かれ道(ランプ・JCT)の言葉。ほとんど曲がらないので左右だけ言う */
const forkWord = (angle: number) => (Math.abs(angle) < 3 ? "" : angle > 0 ? "右方向" : "左方向");

/** m の所の点の添字(acc が m 以上になる最初の点) */
function indexAt(acc: number[], m: number): number {
  let lo = 0;
  let hi = acc.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (acc[mid] < m - 0.5) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** 線を間引く(Douglas–Peucker)。keep の点は必ず残す。残す点の添字を返す */
export function simplify(path: LonLat[], tol: number, keep: Set<number>): number[] {
  const n = path.length;
  if (n <= 2) return path.map((_, i) => i);
  const lat0 = path[0][1] * RAD;
  const xy = path.map(([lon, lat]) => [lon * 111320 * Math.cos(lat0), lat * 110950]);
  const mark = new Uint8Array(n);
  mark[0] = mark[n - 1] = 1;
  for (const k of keep) if (k >= 0 && k < n) mark[k] = 1;
  // 残す点で区切って、それぞれを間引く
  const anchors: number[] = [];
  for (let i = 0; i < n; i++) if (mark[i]) anchors.push(i);
  const stack: [number, number][] = [];
  for (let k = 0; k + 1 < anchors.length; k++) stack.push([anchors[k], anchors[k + 1]]);
  while (stack.length) {
    const [a, b] = stack.pop()!;
    if (b - a < 2) continue;
    const [ax, ay] = xy[a];
    const [bx, by] = xy[b];
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let far = -1;
    let fd = tol;
    for (let i = a + 1; i < b; i++) {
      const [px, py] = xy[i];
      let d: number;
      if (len2 < 1e-6) d = Math.hypot(px - ax, py - ay);
      else {
        const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
        d = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
      }
      if (d > fd) {
        fd = d;
        far = i;
      }
    }
    if (far >= 0) {
      mark[far] = 1;
      stack.push([a, far], [far, b]);
    }
  }
  const out: number[] = [];
  for (let i = 0; i < n; i++) if (mark[i]) out.push(i);
  return out;
}

interface Cand {
  m: number;
  kind: GuideKind;
  angle: number;
  text: string;
  road: string;
  /** まとめるときの強さ(大きい方を残す) */
  rank: number;
}

/** ナビの道筋から、アプリに渡す案内のデータを作る */
export function buildGuide(plan: NaviPlan, name: string, routeName: (ref: string) => string): NaviGuide {
  const { path, acc, spans } = plan;
  const end = path.length - 1;
  const inSpan = (list: { from: number; to: number }[], m: number) => list.some((s) => m > s.from + 1 && m < s.to - 1);
  const cands: Cand[] = [];
  const nameOf = (ref: string | undefined) => (ref && ref !== FREE_REF ? routeName(ref) : "");

  // 1. 高速道路の出入りと JCT(ランプの始まり)
  for (const e of plan.expSpans) {
    // 乗る: 高速道路の区間の始まり。名前はその先の最初の高速道路
    const first = spans.find((s) => isExpRef(s.ref) && s.to > e.from + 1 && s.from < e.to);
    const angle = turnAngle(path, acc, e.from, 60);
    const nm = nameOf(first?.ref);
    cands.push({ m: e.from, kind: "enterExp", angle, text: [forkWord(angle), `${nm || "高速道路"}の入口`].filter(Boolean).join("、"), road: nm, rank: 3 });
    // 区間の中のランプ: 本線から出る所。降りる(区間の終わりまでランプだけ)か JCT
    for (const r of plan.rampSpans) {
      if (r.from <= e.from + 1 || r.from >= e.to - 1) continue;
      const a = turnAngle(path, acc, r.from, 100);
      const next = spans.find((s) => s.from >= r.to - 1 && s.ref !== FREE_REF);
      const exiting = r.to >= e.to - 1 || !spans.some((s) => isExpRef(s.ref) && s.from >= r.to - 1 && s.from < e.to - 1);
      if (exiting) {
        const nm2 = next && !isExpRef(next.ref) ? nameOf(next.ref) : "";
        cands.push({ m: r.from, kind: "exitExp", angle: a, text: [forkWord(a), "出口", nm2 && `${nm2}へ`].filter(Boolean).join("、"), road: nm2, rank: 3 });
      } else {
        const nm2 = nameOf(next?.ref);
        cands.push({ m: r.from, kind: "jct", angle: a, text: [forkWord(a), nm2 || "ジャンクション"].filter(Boolean).join("、"), road: nm2, rank: 3 });
      }
    }
  }

  // 2. 道が変わる所(下の道どうし・一般道の出入り。高速道路の中は 1 で案内する)
  for (let k = 1; k < spans.length; k++) {
    const s = spans[k];
    if (isExpRef(s.ref) || inSpan(plan.expSpans, s.from)) continue;
    if (s.ref === FREE_REF) {
      cands.push({ m: s.from, kind: "free", angle: 0, text: "ここから一般道の区間", road: "", rank: 2 });
      continue;
    }
    const angle = turnAngle(path, acc, s.from);
    const nm = nameOf(s.ref);
    cands.push({ m: s.from, kind: "road", angle, text: `${turnWord(angle)}、${nm}`, road: nm, rank: 2 });
  }

  // 3. 交差点で曲がる所(道は同じ)
  for (const i of plan.junctions) {
    const m = acc[i];
    if (inSpan(plan.expSpans, m) || inSpan(plan.freeSpans, m)) continue;
    const angle = turnAngle(path, acc, m);
    if (Math.abs(angle) < TURN_ANGLE) continue;
    const sp = spans.find((s) => m >= s.from - 1 && m < s.to);
    const nm = nameOf(sp?.ref);
    cands.push({ m, kind: "turn", angle, text: nm ? `${turnWord(angle)}、${nm}` : turnWord(angle), road: nm, rank: 1 + Math.abs(angle) / 1000 });
  }

  // 近い案内をまとめる(強いほうを残す)
  cands.sort((a, b) => a.m - b.m);
  const kept: Cand[] = [];
  for (const c of cands) {
    if (c.m < 1) continue; // 出発の点
    const last = kept[kept.length - 1];
    if (last && c.m - last.m < MERGE) {
      if (c.rank > last.rank) kept[kept.length - 1] = c;
      continue;
    }
    kept.push(c);
  }
  kept.push({ m: acc[end], kind: "arrive", angle: 0, text: "目的地", road: "", rank: 9 });

  // 線を間引く(案内・区間の境目の点は残す)
  const mIdx = kept.map((c) => indexAt(acc, c.m));
  const roadIdx = spans.map((s) => indexAt(acc, s.from));
  const spanIdx = (list: { from: number; to: number }[]) => list.map((s) => [indexAt(acc, s.from), indexAt(acc, s.to)] as [number, number]);
  const freeIdx = spanIdx(plan.freeSpans);
  const expIdx = spanIdx(plan.expSpans);
  const keep = new Set<number>([...mIdx, ...roadIdx, ...freeIdx.flat(), ...expIdx.flat()]);
  const idx = simplify(path, SIMPLIFY, keep);
  const remap = new Map<number, number>();
  idx.forEach((orig, k) => remap.set(orig, k));
  const r = (i: number) => remap.get(i) ?? 0;
  const r5 = (v: number) => Math.round(v * 1e5) / 1e5;

  const roads: { i: number; name: string }[] = [];
  spans.forEach((s, k) => {
    const nm = s.ref === FREE_REF ? "一般道" : routeName(s.ref);
    if (roads[roads.length - 1]?.name !== nm) roads.push({ i: r(roadIdx[k]), name: nm });
  });

  return {
    v: 1,
    name,
    length: Math.round(acc[end]),
    pts: idx.flatMap((i) => [r5(path[i][1]), r5(path[i][0])]),
    man: kept.map((c, k) => ({ i: r(mIdx[k]), at: Math.round(c.m), kind: c.kind, angle: Math.round(c.angle), text: c.text, road: c.road })),
    roads,
    free: freeIdx.map(([a, b]) => [r(a), r(b)]),
    exp: expIdx.map(([a, b]) => [r(a), r(b)]),
  };
}
