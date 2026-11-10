// 長いトンネルなどで GPS が途切れた区間を、道路の形に沿って補う(iPhone の走行ロガーの location.csv 用)。
// トンネルの中では iOS が位置を推測で進めるが、1km ほどで止まり、その後は基地局の測位(±1km)になる。
// そこで、入口の手前で最後に取れた GPS の点と出口の後で最初に取れた点を、道路データの上でいちばん近い道でつなぎ、
// 2点の時刻と速度に合うように1秒ごとの点を置く。元の location.csv は変えず、補った版を別のファイルに書く。
import { distance } from "./geo";
import type { LonLat, RouteData } from "./types";

/** 補間に使う道路の線 */
export interface FillRoad {
  coords: LonLat[];
  /** 一方通行(上下線が別の道、ランプなど)。逆向きに通るのは遠回りとして扱う */
  oneway: boolean;
  tunnel: boolean;
  /** 路線名(まとめに出す) */
  name?: string;
  /** 通るときに道のりへ足す分(m)。電車の乗り換えのつなぎで、むやみに乗り換えないようにする */
  penaltyM?: number;
}

/** 範囲 [西, 南, 東, 北] にかかる道路を返す */
export type RoadSource = (bbox: [number, number, number, number]) => FillRoad[];

export interface FillOptions {
  /** GPS の点(速度あり・精度がこれ以内)の間がこの秒数以上あいていたら補う */
  minGapSec: number;
  /** 2点の直線距離がこれ未満なら補わない(止まっていただけなど)(m) */
  minGapM: number;
  /** 「GPS の点」とみなす精度(m) */
  anchorAccuracy: number;
  /** 端の点から道路までの距離の上限(m) */
  maxSnapM: number;
  /** 道のりが 直線距離 × detourRatio + detourExtraM を超える道は採らない(違う道を通ったとみなす) */
  detourRatio: number;
  detourExtraM: number;
  /** 平均の速さがこれを超えるなら採らない(m/s) */
  maxSpeedMS: number;
  /** 一方通行の道を逆に通るときの道のりの倍率 */
  wrongWayCost: number;
  /** 端の点の向きで道を絞り込むのは、この速さ(m/s)以上で、向きの精度がこれ(度)以内のときだけ */
  minCourseSpeedMS: number;
  maxCourseAccDeg: number;
}

export const DEFAULT_FILL_OPTIONS: FillOptions = {
  minGapSec: 15,
  minGapM: 300,
  anchorAccuracy: 50,
  maxSnapM: 60,
  detourRatio: 1.5,
  detourExtraM: 500,
  maxSpeedMS: 200 / 3.6,
  wrongWayCost: 4,
  minCourseSpeedMS: 2,
  maxCourseAccDeg: 45,
};

/** 補った区間のまとめ(tunnel_fill.json) */
export interface FilledSection {
  /** 入口の手前の最後の GPS の点・出口の後の最初の GPS の点の時刻(UNIX 秒) */
  fromS: number;
  toS: number;
  straightM: number;
  roadM: number;
  /** 道のりのうちトンネルの長さ */
  tunnelM: number;
  avgKmh: number;
  roads: string[];
  /** 足した点の数 */
  points: number;
  /** 置き換えた(捨てた)iOS の推測・基地局の点の数 */
  replaced: number;
}

export interface SkippedSection {
  fromS: number;
  toS: number;
  straightM: number;
  reason: "no_road" | "detour" | "too_fast";
}

export interface FillResult {
  csv: string;
  sections: FilledSection[];
  skipped: SkippedSection[];
}

// --- CSV ---

interface Table {
  head: string[];
  rows: string[][];
}

function parseCsv(text: string): Table {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/).filter((l) => l.length > 0);
  const head = (lines.shift() ?? "").split(",").map((s) => s.trim());
  return { head, rows: lines.map((l) => l.split(",")) };
}

const num = (s: string | undefined): number | undefined => {
  if (s === undefined || s.trim() === "") return undefined;
  const v = Number(s);
  return Number.isFinite(v) ? v : undefined;
};

// --- 平面の近似(短い距離だけで使う) ---

const M_PER_DEG = 111_320;
const toRad = (d: number) => (d * Math.PI) / 180;

/** 北を0とした時計回りの向き(度、0〜360) */
function bearingDeg(a: LonLat, b: LonLat): number {
  const k = Math.cos(toRad((a[1] + b[1]) / 2));
  const deg = (Math.atan2((b[0] - a[0]) * k, b[1] - a[1]) * 180) / Math.PI;
  return (deg + 360) % 360;
}

/** 点 p を線分 ab に下ろした位置(0〜1)と距離(m) */
function project(p: LonLat, a: LonLat, b: LonLat): { f: number; d: number; q: LonLat } {
  const k = Math.cos(toRad(p[1]));
  const ax = (a[0] - p[0]) * k, ay = a[1] - p[1];
  const bx = (b[0] - p[0]) * k, by = b[1] - p[1];
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let f = len2 > 0 ? -(ax * dx + ay * dy) / len2 : 0;
  f = Math.max(0, Math.min(1, f));
  const q: LonLat = [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
  return { f, d: distance(p, q), q };
}

// --- 道路のグラフ ---

interface Edge {
  a: number;
  b: number;
  len: number;
  road: FillRoad;
}

class Graph {
  coords: LonLat[] = [];
  /** to, cost, len, edge の番号 */
  adj: { to: number; cost: number; len: number; edge: number }[][] = [];
  edges: Edge[] = [];
  private ids = new Map<string, number>();

  node(p: LonLat, merge = true): number {
    // 道路データの座標は小数5桁(約1m)。同じ座標は同じ交点とみなす
    const k = `${Math.round(p[0] * 1e5)},${Math.round(p[1] * 1e5)}`;
    if (merge) {
      const id = this.ids.get(k);
      if (id !== undefined) return id;
    }
    const id = this.coords.length;
    this.coords.push(p);
    this.adj.push([]);
    if (merge) this.ids.set(k, id);
    return id;
  }

  link(from: number, to: number, len: number, cost: number, edge: number) {
    this.adj[from].push({ to, cost, len, edge });
  }

  addRoad(road: FillRoad, wrongWay: number) {
    for (let i = 1; i < road.coords.length; i++) {
      const a = this.node(road.coords[i - 1]);
      const b = this.node(road.coords[i]);
      if (a === b) continue;
      const len = distance(road.coords[i - 1], road.coords[i]);
      const e = this.edges.length;
      const pen = road.penaltyM ?? 0;
      this.edges.push({ a, b, len, road });
      this.link(a, b, len, len + pen, e);
      this.link(b, a, len, (road.oneway ? len * wrongWay : len) + pen, e);
    }
  }
}

/** 小さい順に取り出せる二分ヒープ */
class Heap {
  private items: [number, number][] = [];
  get size() {
    return this.items.length;
  }
  push(cost: number, v: number) {
    const a = this.items;
    a.push([cost, v]);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p][0] <= a[i][0]) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  pop(): [number, number] {
    const a = this.items;
    const top = a[0];
    const last = a.pop()!;
    if (a.length > 0) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1, r = l + 1;
        let m = i;
        if (l < a.length && a[l][0] < a[m][0]) m = l;
        if (r < a.length && a[r][0] < a[m][0]) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top;
  }
}

interface Snap {
  edge: number;
  f: number;
  d: number;
  q: LonLat;
}

/** 点のそばの道路(進んでいた向きに合うもの)を近い順に返す */
function snaps(g: Graph, p: LonLat, course: number | undefined, maxD: number): Snap[] {
  const out: Snap[] = [];
  for (let e = 0; e < g.edges.length; e++) {
    const ed = g.edges[e];
    // 乗り換えのつなぎ(線路ではない)には下ろさない
    if (ed.road.penaltyM) continue;
    const pr = project(p, g.coords[ed.a], g.coords[ed.b]);
    if (pr.d > maxD) continue;
    if (course !== undefined) {
      let diff = Math.abs(bearingDeg(g.coords[ed.a], g.coords[ed.b]) - course) % 360;
      if (diff > 180) diff = 360 - diff;
      // 一方通行は向きまで、そうでなければ線の向きだけ合っていればよい
      if (!ed.road.oneway) diff = Math.min(diff, 180 - diff);
      if (diff > 60) continue;
    }
    out.push({ edge: e, f: pr.f, d: pr.d, q: pr.q });
  }
  return out.sort((a, b) => a.d - b.d).slice(0, 8);
}

interface RoutePath {
  coords: LonLat[];
  len: number;
  tunnelM: number;
  roads: string[];
}

/** a から b まで、道路の上でいちばん近い道(一方通行の逆走と、道路から離れているぶんは遠回りとして数える) */
function route(g: Graph, a: LonLat, courseA: number | undefined, b: LonLat, courseB: number | undefined, opt: FillOptions): RoutePath | null {
  const sa = snaps(g, a, courseA, opt.maxSnapM);
  const sb = snaps(g, b, courseB, opt.maxSnapM);
  if (sa.length === 0 || sb.length === 0) return null;
  const base = g.coords.length;
  const S = g.node([NaN, NaN], false);
  const T = g.node([NaN, NaN], false);
  // 端の点を道路に下ろした位置を、仮の交点として足す(使い終わったら消す)
  const startNodes = sa.map((s) => {
    const ed = g.edges[s.edge];
    const n = g.node(s.q, false);
    g.link(S, n, 0, s.d * 2, -1);
    g.link(n, ed.b, ed.len * (1 - s.f), ed.len * (1 - s.f), s.edge);
    g.link(n, ed.a, ed.len * s.f, ed.len * s.f * (ed.road.oneway ? opt.wrongWayCost : 1), s.edge);
    return n;
  });
  sb.forEach((s) => {
    const ed = g.edges[s.edge];
    const n = g.node(s.q, false);
    g.link(n, T, 0, s.d * 2, -1);
    g.link(ed.a, n, ed.len * s.f, ed.len * s.f, s.edge);
    g.link(ed.b, n, ed.len * (1 - s.f), ed.len * (1 - s.f) * (ed.road.oneway ? opt.wrongWayCost : 1), s.edge);
    // 両端が同じ線の上にあるとき(長い直線のトンネルなど)は、その線の上を直接つなぐ
    sa.forEach((s0, i) => {
      if (s0.edge !== s.edge) return;
      const l = ed.len * Math.abs(s.f - s0.f);
      const back = s.f < s0.f && ed.road.oneway;
      g.link(startNodes[i], n, l, back ? l * opt.wrongWayCost : l, s.edge);
    });
  });

  const dist = new Float64Array(g.coords.length).fill(Infinity);
  const prev = new Int32Array(g.coords.length).fill(-1);
  const prevEdge = new Int32Array(g.coords.length).fill(-1);
  const heap = new Heap();
  dist[S] = 0;
  heap.push(0, S);
  while (heap.size > 0) {
    const [c, v] = heap.pop();
    if (c > dist[v]) continue;
    if (v === T) break;
    for (const l of g.adj[v]) {
      const nc = c + l.cost;
      if (nc < dist[l.to]) {
        dist[l.to] = nc;
        prev[l.to] = v;
        prevEdge[l.to] = l.edge;
        heap.push(nc, l.to);
      }
    }
  }

  let result: RoutePath | null = null;
  if (dist[T] < Infinity) {
    const nodes: number[] = [];
    const edges: number[] = [];
    for (let v = prev[T]; v !== S && v >= 0; v = prev[v]) {
      nodes.push(v);
      edges.push(prevEdge[v]);
    }
    nodes.reverse();
    edges.reverse();
    const coords = nodes.map((n) => g.coords[n]);
    let len = 0;
    let tunnelM = 0;
    const roads: string[] = [];
    for (let i = 1; i < coords.length; i++) {
      const d = distance(coords[i - 1], coords[i]);
      len += d;
      const road = edges[i] >= 0 ? g.edges[edges[i]].road : undefined;
      if (road?.tunnel) tunnelM += d;
      if (road?.name && !roads.includes(road.name)) roads.push(road.name);
    }
    result = { coords, len, tunnelM, roads };
  }

  // 仮の交点と、それにつないだ線を消す
  for (const ed of [...sa, ...sb].map((s) => g.edges[s.edge])) {
    g.adj[ed.a] = g.adj[ed.a].filter((l) => l.to < base);
    g.adj[ed.b] = g.adj[ed.b].filter((l) => l.to < base);
  }
  g.coords.length = base;
  g.adj.length = base;
  return result;
}

/** 線の上で、始点から d m の位置と、その場所の向き */
function along(coords: LonLat[], cum: number[], d: number): { p: LonLat; course: number } {
  let i = 1;
  while (i < coords.length - 1 && cum[i] < d) i++;
  const a = coords[i - 1], b = coords[i];
  const seg = cum[i] - cum[i - 1];
  const f = seg > 0 ? Math.max(0, Math.min(1, (d - cum[i - 1]) / seg)) : 0;
  return { p: [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f], course: bearingDeg(a, b) };
}

/**
 * 時間 T の間に道のり L を、始めの速さ vA・終わりの速さ vB で走ったとして、時刻 τ までに進んだ距離と、その時の速さ。
 * 速さは vA→vB の直線に山(谷)を1つ足した形 v(s) = vA + (vB−vA)s + 6c·s(1−s)(s = τ/T)で、合計がちょうど L になるよう c を決める。
 * 途中で速さが負になるときは、一定の速さにする
 */
export function speedProfile(L: number, T: number, vA: number, vB: number): (tau: number) => { d: number; v: number } {
  const c = L / T - (vA + vB) / 2;
  // v(s) の最小は両端か頂点(c > 0 なら山なので両端)
  const vAt = (s: number) => vA + (vB - vA) * s + 6 * c * s * (1 - s);
  const sTop = c !== 0 ? Math.max(0, Math.min(1, 0.5 + (vB - vA) / (12 * c))) : 0;
  if (Math.min(vAt(0), vAt(1), vAt(sTop)) < 0) {
    const v = L / T;
    return (tau) => ({ d: v * tau, v });
  }
  return (tau) => {
    const s = tau / T;
    return { d: T * (vA * s + ((vB - vA) * s * s) / 2 + c * (3 * s * s - 2 * s * s * s)), v: vAt(s) };
  };
}

/**
 * location.csv の GPS が途切れた区間を道路に沿って補う。
 * 返す CSV は元の列 + speed_est_ms(なければ足す)+ src。src は gps(GPS の点)/ inferred(iOS の推測・基地局の点)/ road(補った点)。
 * 補った区間の中にあった inferred の点は捨てる
 */
export function fillTunnels(text: string, roads: RoadSource, opt: FillOptions = DEFAULT_FILL_OPTIONS): FillResult {
  const { head, rows } = parseCsv(text);
  const col = (name: string) => head.indexOf(name);
  const cT = col("unix_s"), cLat = col("lat"), cLon = col("lon"), cAlt = col("alt_m"), cAcc = col("h_acc_m");
  const cSpeed = col("speed_ms"), cCourse = col("course_deg"), cCourseAcc = col("course_acc_deg");
  if (cT < 0 || cLat < 0 || cLon < 0) throw new Error("location.csv に unix_s・lat・lon の列がありません");
  const outHead = [...head];
  if (!outHead.includes("speed_est_ms")) outHead.push("speed_est_ms");
  outHead.push("src");
  const cEst = outHead.indexOf("speed_est_ms");
  const cSrc = outHead.length - 1;

  const t = (r: string[]) => num(r[cT]) ?? NaN;
  const pos = (r: string[]): LonLat => [num(r[cLon]) ?? NaN, num(r[cLat]) ?? NaN];
  const isAnchor = (r: string[]) => {
    const acc = num(r[cAcc]);
    return acc !== undefined && acc >= 0 && acc <= opt.anchorAccuracy && num(r[cSpeed]) !== undefined && Number.isFinite(t(r));
  };
  /**
   * 進んでいた向き。止まりかけ(駅で停車中など)や向きの精度が悪い点の向きはでたらめなので、
   * 道路・線路を向きで絞り込まない(undefined)
   */
  const courseOf = (r: string[]): number | undefined => {
    const c = num(r[cCourse]);
    if (c === undefined || c < 0) return undefined;
    if ((num(r[cSpeed]) ?? 0) < opt.minCourseSpeedMS) return undefined;
    const acc = cCourseAcc >= 0 ? num(r[cCourseAcc]) : undefined;
    if (acc !== undefined && (acc < 0 || acc > opt.maxCourseAccDeg)) return undefined;
    return c;
  };
  rows.sort((a, b) => t(a) - t(b));
  const pad = (r: string[], src: string) => {
    const o = outHead.map((_, i) => (i < head.length ? (r[i] ?? "") : ""));
    o[cSrc] = src;
    return o;
  };

  const out: string[][] = [];
  const sections: FilledSection[] = [];
  const skipped: SkippedSection[] = [];
  let lastAnchor = -1;
  let pending: string[][] = []; // 前の GPS の点の後に来た、GPS でない点

  const flushPending = () => {
    for (const r of pending) out.push(pad(r, "inferred"));
    pending = [];
  };

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (!isAnchor(r)) {
      if (lastAnchor >= 0) pending.push(r);
      else out.push(pad(r, "inferred"));
      continue;
    }
    if (lastAnchor >= 0) {
      const ra = rows[lastAnchor];
      const T = t(r) - t(ra);
      const a = pos(ra), b = pos(r);
      const straight = distance(a, b);
      if (T >= opt.minGapSec && straight >= opt.minGapM) {
        const filled = fillOne(ra, r, T, a, b, straight);
        if (filled) {
          for (const f of filled) out.push(f);
          sections[sections.length - 1].replaced = pending.length;
          pending = [];
        }
      }
    }
    flushPending();
    out.push(pad(r, "gps"));
    lastAnchor = i;
  }
  flushPending();

  function fillOne(ra: string[], rb: string[], T: number, a: LonLat, b: LonLat, straight: number): string[][] | null {
    const base = { fromS: t(ra), toS: t(rb), straightM: Math.round(straight) };
    // 飛行機など、直線でも速すぎる移動は道路を探さない
    if (straight / T > opt.maxSpeedMS) {
      skipped.push({ ...base, reason: "too_fast" });
      return null;
    }
    const margin = Math.max(1000, straight * 0.3) / M_PER_DEG;
    const k = Math.cos(toRad(a[1]));
    const bbox: [number, number, number, number] = [
      Math.min(a[0], b[0]) - margin / k, Math.min(a[1], b[1]) - margin,
      Math.max(a[0], b[0]) + margin / k, Math.max(a[1], b[1]) + margin,
    ];
    const g = new Graph();
    for (const road of roads(bbox)) g.addRoad(road, opt.wrongWayCost);
    const path = route(g, a, courseOf(ra), b, courseOf(rb), opt);
    if (!path || path.coords.length < 2) {
      skipped.push({ ...base, reason: "no_road" });
      return null;
    }
    if (path.len > straight * opt.detourRatio + opt.detourExtraM) {
      skipped.push({ ...base, reason: "detour" });
      return null;
    }
    if (path.len / T > opt.maxSpeedMS) {
      skipped.push({ ...base, reason: "too_fast" });
      return null;
    }
    // 端の点そのものから始めて、端の点で終わるようにする(道路に下ろした位置との差は数十m以内)
    const coords = [a, ...path.coords, b];
    const cum = [0];
    for (let i = 1; i < coords.length; i++) cum.push(cum[i - 1] + distance(coords[i - 1], coords[i]));
    const L = cum[cum.length - 1];
    const vA = Math.max(0, num(ra[cSpeed]) ?? 0);
    const vB = Math.max(0, num(rb[cSpeed]) ?? 0);
    const prof = speedProfile(L, T, vA, vB);
    const altA = num(ra[cAlt]), altB = num(rb[cAlt]);
    const res: string[][] = [];
    for (let tau = 1; tau < T - 0.5; tau += 1) {
      const { d, v } = prof(tau);
      const { p, course } = along(coords, cum, d);
      const row = outHead.map(() => "");
      row[cT] = (t(ra) + tau).toFixed(3);
      row[cLat] = p[1].toFixed(7);
      row[cLon] = p[0].toFixed(7);
      if (cAlt >= 0 && altA !== undefined && altB !== undefined) row[cAlt] = (altA + ((altB - altA) * tau) / T).toFixed(2);
      if (cCourse >= 0) row[cCourse] = course.toFixed(1);
      row[cEst] = v.toFixed(2);
      row[cSrc] = "road";
      res.push(row);
    }
    sections.push({
      ...base,
      roadM: Math.round(L),
      tunnelM: Math.round(path.tunnelM),
      avgKmh: Math.round((L / T) * 3.6 * 10) / 10,
      roads: path.roads,
      points: res.length,
      replaced: 0,
    });
    return res;
  }

  return { csv: [outHead, ...out].map((r) => r.join(",")).join("\n") + "\n", sections, skipped };
}

/** 判定用の道路データ(国道・高速道路・都道府県道)から、範囲にかかる線を取り出す */
export function roadsFromData(list: (RouteData | undefined)[]): RoadSource {
  return (bbox) => {
    const [w, s, e, n] = bbox;
    const hit = (c: LonLat[]) => {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const p of c) {
        if (p[0] < minX) minX = p[0];
        if (p[0] > maxX) maxX = p[0];
        if (p[1] < minY) minY = p[1];
        if (p[1] > maxY) maxY = p[1];
      }
      return maxX >= w && minX <= e && maxY >= s && minY <= n;
    };
    const out: FillRoad[] = [];
    for (const d of list) {
      if (!d) continue;
      for (const seg of d.segments) {
        if (!hit(seg.coords)) continue;
        const name = seg.routes.map((r) => d.routes[r]?.name ?? r).join("・");
        out.push({ coords: seg.coords, oneway: !!seg.pair, tunnel: !!seg.tunnel, name });
      }
      // 高速道路のデータだけにある線(ランプ・JCT・路線に数えない本線)も道としてつなぐ
      for (const r of d.ramps ?? []) if (hit(r.c)) out.push({ coords: r.c, oneway: true, tunnel: false });
      for (const c of d.jct ?? []) if (hit(c)) out.push({ coords: c, oneway: true, tunnel: false });
      for (const c of d.uncounted ?? []) if (hit(c)) out.push({ coords: c, oneway: false, tunnel: false });
    }
    return out;
  };
}
