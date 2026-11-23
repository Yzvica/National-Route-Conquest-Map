// 国道(と都道府県道)を通るルートを Google マップのナビに送るためのリンクを作る。
// Google マップは「速い道」を選ぶので、ほかの道の近道を選ばせないよう、道筋の上に経由地を細かく置く。
//   1. 地図で選んだ点(出発・通りたい道の上・到着)を、国道(と都道府県道)のデータでつないだ道筋にする。
//      都道府県道は少し遠回りとみなして国道を優先する。「一般道も使う」ときは、データの道の切れ目どうしや、
//      道から離れた点を「一般道」(手持ちのデータにない道。そこは Google マップに道を任せる)でつなぐ
//   2. 道筋の上に経由地を置く。曲がりくねって近道ができやすいところほど細かく、
//      国道を乗り換えたところ(分岐点)の少し先には必ず置く(手前で県道へ逃げにくくする)
//      「高速も使う」ときは、高速道路(IC のランプでだけ乗り降りできる)も速い道としてつなぐ。
//      高速道路の上には経由地を置かず Google マップに任せ、降りた少し先に経由地を置いて降りる IC を決める
//   3. Google マップの URL は経由地が最大9個(スマホのブラウザは3個)なので、区間ごとに複数のリンクに分ける
// 出発地は入れない(=現在地から)。前のリンクの目的地に着いたら次のリンクを開く使い方。
import type { LonLat, Ramp, Segment } from "./types";

/** 地図で選んだ点 */
export interface NaviPoint {
  lon: number;
  lat: number;
}

/** 道筋の上に置いた経由地 */
export interface Waypoint {
  lon: number;
  lat: number;
  /** 道筋の最初からの距離(m) */
  at: number;
  /** その場所の国道番号(都道府県道は "4-22"、一般道は "*") */
  routes: string[];
}

export interface NaviLink {
  url: string;
  /** このリンクの区間(道筋の最初からの距離 m) */
  from: number;
  to: number;
  /** 通る国道(順番) */
  routes: string[];
  waypoints: Waypoint[];
  dest: Waypoint;
}

export interface NaviPlan {
  /** 国道だけでつないだ道筋 */
  path: LonLat[];
  /** 道筋の長さ(m) */
  length: number;
  /** 経由地(最後は到着地) */
  waypoints: Waypoint[];
  /** 通る国道(順番) */
  routes: string[];
  links: NaviLink[];
  /** 道筋の各点の、最初からの距離(m) */
  acc: number[];
  /** 一般道(Google に任せる)の区間(道筋の最初からの距離 m)。長さは直線で数えている */
  freeSpans: { from: number; to: number }[];
  /** 高速道路(ランプを含む。Google に任せる)の区間(道筋の最初からの距離 m) */
  expSpans: { from: number; to: number }[];
  /** 通る道とその区間(道筋の最初からの距離 m。アプリの音声案内で道の変わり目に使う) */
  spans: { ref: string; from: number; to: number }[];
  /** 道筋の点のうち、ほかの道と分かれる・合わさる点(交差点)の添字 */
  junctions: number[];
  /** ランプ・JCT(高速道路の出入りと乗り換え)の区間(道筋の最初からの距離 m) */
  rampSpans: { from: number; to: number }[];
}

export interface NaviOptions {
  /** 1本のリンクに入れる経由地の数(目的地は別)。Google マップのアプリは9、スマホのブラウザは3 */
  perLink?: number;
  /** 経由地の間の「国道の距離 / 直線距離」の上限。小さいほど細かく置く */
  ratio?: number;
  /** 経由地の間の最大距離(m) */
  maxGap?: number;
  /** データの道の切れ目や、道から離れた点を一般道でつなぐ */
  free?: boolean;
  /** 必ず経由地を置く場所(道筋の上か、そのそば 300m 以内)。Google が道筋を通らなかったときに足す */
  extra?: NaviPoint[];
}

/** 一般道の印(路線のかわり) */
export const FREE_REF = "*";
/** 高速道路の路線の印(高速道路のデータの路線名の前に付ける。例 "E:東名高速道路") */
export const EXP_PREFIX = "E:";
export const isExpRef = (r: string) => r.startsWith(EXP_PREFIX);
/** 高速道路のデータの区間か(路線に EXP_PREFIX が付いている) */
export const isExpSegment = (s: Segment) => s.routes.some(isExpRef);

/** 高速道路の重み。速いので、この倍の長さの国道と同じとみなす(高速 約90km/h・国道 約40km/h) */
export const EXP_WEIGHT = 0.45;
/** 高速道路に乗るときの上乗せ(m)。近い所へ行くのにわざわざ乗らないように(料金や乗り降りの手間) */
export const EXP_ENTER_COST = 5000;

/** 都道府県道を通るときの重み(この倍の長さの国道と同じとみなす)。国道を優先させる */
export const PREF_WEIGHT = { major: 1.25, general: 1.5 };
/** 区間の重み: 国道 1、主要地方道・一般都道府県道は PREF_WEIGHT */
export function roadWeight(s: Segment): number {
  if (isExpSegment(s)) return EXP_WEIGHT;
  if (s.cats.includes("general")) return PREF_WEIGHT.general;
  if (s.cats.includes("major")) return PREF_WEIGHT.major;
  return 1;
}

/** 路線の並び: 国道(番号順) → 都道府県道 → 高速道路 → 一般道 */
export function compareRef(a: string, b: string): number {
  const rank = (r: string) => (r === FREE_REF ? 3 : isExpRef(r) ? 2 : r.includes("-") ? 1 : 0);
  const ra = rank(a);
  const rb = rank(b);
  if (ra !== rb) return ra - rb;
  if (ra === 2) return a.localeCompare(b, "ja");
  if (ra === 1) {
    const [ca, na] = a.split("-").map(Number);
    const [cb, nb] = b.split("-").map(Number);
    return ca - cb || na - nb;
  }
  return Number(a) - Number(b);
}

export type NaviResult = NaviPlan | { error: string; leg?: number };

const RAD = Math.PI / 180;
/** 2点の距離(m)。狭い範囲なので平面で近似する */
export function dist(a: LonLat, b: LonLat): number {
  const k = Math.cos(((a[1] + b[1]) / 2) * RAD);
  return Math.hypot((a[0] - b[0]) * k * 111320, (a[1] - b[1]) * 110950);
}

/** 長い辺は細かく切る(経由地や選んだ点を、辺の途中にも置けるように) */
const STEP = 100;
/** 立体交差では国道どうしが点を共有しないので、近く(この距離 m 以内)の別の国道とつなぐ */
const LINK_DIST = 120;
/** そのつなぎを使うときの上乗せ(m)。つながっている道があればそちらを選ぶように */
const LINK_COST = 300;
/** 一般道でつなぐ距離の上限(m、直線) */
const FREE_RADIUS = 2500;
/** 一般道の重み: 直線距離のこの倍 + FREE_COST。実際の道は直線の1.3倍くらいなので、都道府県道よりさらに避ける */
const FREE_FACTOR = 2.5;
const FREE_COST = 500;
/** 選んだ点がデータの道からこれより離れていたら、一般道の上の点とみなす(一般道も使うとき) */
const OFF_ROAD = 80;
/** 辺の区間の番号: 近くの別の道とのつなぎ / 一般道 */
const SEG_LINK = -1;
const SEG_FREE = -2;
/** 高速道路のランプ・JCT・路線に数えない本線(路線なし。高速道路の一部として扱う) */
const SEG_RAMP = -3;
/** ランプの端を高速道路の本線につなぐ距離の上限(m) */
const RAMP_SNAP_EXP = 60;
/** ランプの端・高速道路の端を、下の道(データの道)につなぐ距離の上限(m) */
const RAMP_SNAP_LOCAL = 150;
/** 橋・高架・トンネルの上は経由地にしない(下の道や近くの道に付いてしまうため)。この長さ未満の区間は橋などとみなす */
const SAFE_LEN = 250;

interface Edge {
  to: number;
  w: number;
  /** 区間(つなぎの辺は -1、一般道は -2) */
  seg: number;
}

/** 高速道路のデータの、本線の区間以外のもの(RouteData の同じ名前の項目) */
export interface ExpresswayExtras {
  ramps?: Ramp[];
  jct?: LonLat[][];
  uncounted?: LonLat[][];
  access?: LonLat[];
}

export interface RoadGraphOptions {
  /** 区間の重み(長さに掛ける)。既定は roadWeight */
  weight?: (s: Segment) => number;
  /** データの道の切れ目どうしを一般道でつなぐ */
  free?: boolean;
  /**
   * 高速道路のランプなど。高速道路の区間(isExpSegment)は segments に入れる。
   * 高速道路はランプ(と本線の端)でだけ下の道とつなぐ。近くの道との「つなぎ」や一般道では、高速道路につながない
   */
  expressway?: ExpresswayExtras;
}

/** 国道のデータから作った道のつながり */
export class RoadGraph {
  readonly lon: number[] = [];
  readonly lat: number[] = [];
  readonly adj: Edge[][] = [];
  private readonly ids = new Map<string, number>();
  private readonly nodeRoutes: Set<string>[] = [];
  /** 高速道路(本線・ランプ)だけの点。下の道と点を共有していれば false */
  private readonly expNode: boolean[] = [];
  /** 区間(データの道)の上の点 */
  private readonly segNode: boolean[] = [];
  /** 一時的に足した点・辺(planNavi の間だけ。終わったら戻す) */
  private tempEdges: number[] = [];
  private baseSize = 0;

  constructor(
    readonly segments: Segment[],
    opts: RoadGraphOptions = {},
  ) {
    const weight = opts.weight ?? roadWeight;
    segments.forEach((s, si) => {
      const wk = weight(s);
      const c = s.coords;
      // 上下線が別の道は一方通行(点の並びの向きに進む)
      const oneway = !!s.pair;
      const exp = isExpSegment(s);
      this.addLine(c, s.routes, exp, (a, b, d) => {
        this.adj[a].push({ to: b, w: d * wk, seg: si });
        if (!oneway) this.adj[b].push({ to: a, w: d * wk, seg: si });
      });
    });
    if (opts.expressway) this.addExpressway(opts.expressway);
    this.linkNearby();
    if (opts.free) this.linkEnds();
    this.baseSize = this.size;
  }

  /** 点の列を STEP ごとに細かく切って点を作り、隣どうしを edge(a, b, 長さ) でつなぐ */
  private addLine(c: LonLat[], routes: string[], exp: boolean, edge: (a: number, b: number, d: number) => void, seg = true): number[] {
    const out: number[] = [];
    if (!c.length) return out;
    let prev = this.node(c[0], routes, exp, seg);
    out.push(prev);
    for (let i = 0; i + 1 < c.length; i++) {
      const d = dist(c[i], c[i + 1]);
      const n = Math.max(1, Math.ceil(d / STEP));
      for (let k = 1; k <= n; k++) {
        const p: LonLat = k === n ? c[i + 1] : [c[i][0] + ((c[i + 1][0] - c[i][0]) * k) / n, c[i][1] + ((c[i + 1][1] - c[i][1]) * k) / n];
        const cur = this.node(p, routes, exp, seg);
        if (cur !== prev) edge(prev, cur, d / n);
        prev = cur;
        out.push(cur);
      }
    }
    return out;
  }

  /** 点の近くの点(radius m 以内)を近い順に。pred で絞る */
  private around(p: LonLat, radius: number, pred: (j: number) => boolean): [number, number][] {
    const cell = 0.002;
    const g = this.fine ?? (this.fine = this.grid(cell));
    const rx = Math.ceil(radius / (111320 * Math.cos(p[1] * RAD) * cell));
    const ry = Math.ceil(radius / (110950 * cell));
    const gx = Math.floor(p[0] / cell);
    const gy = Math.floor(p[1] / cell);
    const out: [number, number][] = [];
    for (let dx = -rx; dx <= rx; dx++)
      for (let dy = -ry; dy <= ry; dy++)
        for (const j of g.get(`${gx + dx},${gy + dy}`) ?? []) {
          if (!pred(j)) continue;
          const d = dist(p, this.pos(j));
          if (d <= radius) out.push([j, d]);
        }
    return out.sort((a, b) => a[1] - b[1]);
  }
  private fine?: Map<string, number[]>;

  /** 下の道(高速道路ではないデータの道)の、近くの点を道ごとに1つずつ(近い順に max 個) */
  private nearLocal(p: LonLat, radius: number, max: number): [number, number][] {
    const seen = new Set<string>();
    const out: [number, number][] = [];
    for (const [j, d] of this.around(p, radius, (j) => this.segNode[j] && !this.expNode[j])) {
      const key = [...this.nodeRoutes[j]].sort().join(",");
      if (seen.has(key)) continue;
      seen.add(key);
      out.push([j, d]);
      if (out.length >= max) break;
    }
    return out;
  }

  /**
   * 高速道路のランプ・JCT などをつなぐ。
   * ランプは進む向きの線(in は下の道から本線へ、out は本線から下の道へ)。両端が道の点と同じでなければ、
   * 本線側の端は近くの高速道路の点へ、下の道側の端は近くの下の道の点(なければ一般道)へつなぐ
   */
  private addExpressway(x: ExpresswayExtras) {
    const rampEdge = (a: number, b: number, d: number) => this.adj[a].push({ to: b, w: d * EXP_WEIGHT, seg: SEG_RAMP });
    const both = (a: number, b: number, d: number) => {
      rampEdge(a, b, d);
      rampEdge(b, a, d);
    };
    // ランプの端の点: そこで始まる・終わるランプの種類
    const starts = new Map<number, Set<Ramp["k"]>>();
    const ends = new Map<number, Set<Ramp["k"]>>();
    const mark = (m: Map<number, Set<Ramp["k"]>>, i: number, k: Ramp["k"]) => (m.get(i) ?? m.set(i, new Set()).get(i)!).add(k);
    for (const r of x.ramps ?? []) {
      const ns = this.addLine(r.c, [], true, rampEdge, false);
      if (ns.length < 2) continue;
      mark(starts, ns[0], r.k);
      mark(ends, ns[ns.length - 1], r.k);
    }
    // JCT のランプと路線に数えない本線は向きがわからないので両向き
    const loose: number[] = [];
    for (const c of [...(x.jct ?? []), ...(x.uncounted ?? [])]) {
      const ns = this.addLine(c, [], true, both, false);
      if (ns.length < 2) continue;
      loose.push(ns[0], ns[ns.length - 1]);
    }
    const isExpMain = (j: number) => this.segNode[j] && this.expNode[j];
    const nearestExp = (i: number) => this.around(this.pos(i), RAMP_SNAP_EXP, (j) => j !== i && isExpMain(j))[0];
    /** 下の道から i へ(高速道路に乗る) */
    const enter = (i: number) => {
      const near = this.nearLocal(this.pos(i), RAMP_SNAP_LOCAL, 2);
      for (const [j, d] of near) this.adj[j].push({ to: i, w: d + EXP_ENTER_COST, seg: SEG_LINK });
      if (!near.length) this.pendingFree.push([i, 1]);
    };
    /** i から下の道へ(高速道路を降りる) */
    const leave = (i: number) => {
      const near = this.nearLocal(this.pos(i), RAMP_SNAP_LOCAL, 2);
      for (const [j, d] of near) this.adj[i].push({ to: j, w: d, seg: SEG_LINK });
      if (!near.length) this.pendingFree.push([i, 0]);
    };
    const nodes = new Set([...starts.keys(), ...ends.keys()]);
    for (const i of nodes) {
      if (this.segNode[i]) continue; // 道の点と同じ点(すでにつながっている)
      const st = starts.get(i) ?? new Set();
      const en = ends.get(i) ?? new Set();
      if (st.size && !en.size) {
        // ランプの始まり: in なら下の道から、out なら本線から
        if (st.has("in")) enter(i);
        if (st.has("out")) {
          const e = nearestExp(i);
          if (e) this.adj[e[0]].push({ to: i, w: e[1], seg: SEG_RAMP });
        }
      } else if (en.size && !st.size) {
        // ランプの終わり: in なら本線へ、out なら下の道へ
        if (en.has("in")) {
          const e = nearestExp(i);
          if (e) this.adj[i].push({ to: e[0], w: e[1], seg: SEG_RAMP });
        }
        if (en.has("out")) leave(i);
      } else if (!en.has("in") && !st.has("out")) {
        // 出口のランプが終わり、入口のランプが始まる点(データにない下の道の交差点)
        leave(i);
        enter(i);
      }
    }
    for (const i of loose) {
      if (this.segNode[i]) continue;
      const e = nearestExp(i);
      if (e) both(i, e[0], e[1]);
    }
    // 高速道路の本線の端(出入りできる場所のそば)は、下の道とつなぐ
    const und = new Map<number, Set<number>>();
    const touch = (a: number, b: number) => {
      if (!this.expNode[a]) return;
      (und.get(a) ?? und.set(a, new Set()).get(a)!).add(b);
    };
    this.adj.forEach((es, a) => {
      for (const e of es) {
        touch(a, e.to);
        touch(e.to, a);
      }
    });
    const tips = new Set<number>();
    for (const p of x.access ?? []) for (const [i] of this.around(p, 30, (j) => isExpMain(j) && (und.get(j)?.size ?? 0) <= 1)) tips.add(i);
    for (const i of tips) {
      leave(i);
      enter(i);
    }
  }
  /** 一般道でつなぐ、高速道路の端(1: 下の道から乗る、0: 降りる)。linkEnds のときに一方通行の一般道でつなぐ */
  private pendingFree: [number, 0 | 1][] = [];

  /** 道筋を作るときに足した点・辺を消す */
  resetTemp() {
    while (this.tempEdges.length) this.adj[this.tempEdges.pop()!].pop();
    this.lon.length = this.lat.length = this.adj.length = this.nodeRoutes.length = this.expNode.length = this.segNode.length = this.baseSize;
  }

  private addFree(a: number, b: number, temp: boolean) {
    const w = dist(this.pos(a), this.pos(b)) * FREE_FACTOR + FREE_COST;
    this.adj[a].push({ to: b, w, seg: SEG_FREE });
    this.adj[b].push({ to: a, w, seg: SEG_FREE });
    if (temp) this.tempEdges.push(a, b);
  }

  /** 点のまわり radius m 以内の点を、道(路線の組み合わせ)とつながりのかたまりごとに、近い順に max 個 */
  private nearbyGroups(p: LonLat, radius: number, max: number, skip: (j: number) => boolean, comp?: Int32Array): number[] {
    const best = new Map<string, [number, number]>();
    const cell = 0.01;
    const g = this.coarse ?? (this.coarse = this.grid(cell));
    const rx = Math.ceil(radius / (111320 * Math.cos(p[1] * RAD) * cell));
    const ry = Math.ceil(radius / (110950 * cell));
    const gx = Math.floor(p[0] / cell);
    const gy = Math.floor(p[1] / cell);
    for (let dx = -rx; dx <= rx; dx++)
      for (let dy = -ry; dy <= ry; dy++)
        for (const j of g.get(`${gx + dx},${gy + dy}`) ?? []) {
          if (skip(j)) continue;
          const d = dist(p, this.pos(j));
          if (d > radius) continue;
          const key = `${comp ? comp[j] : 0}|${[...this.nodeRoutes[j]].sort().join(",")}`;
          const cur = best.get(key);
          if (!cur || d < cur[1]) best.set(key, [j, d]);
        }
    return [...best.values()]
      .sort((a, b) => a[1] - b[1])
      .slice(0, max)
      .map(([j]) => j);
  }
  private coarse?: Map<string, number[]>;

  /** つながりのかたまり(向きは見ない)の番号 */
  private components(): Int32Array {
    const comp = new Int32Array(this.size).fill(-1);
    const und: number[][] = this.adj.map(() => []);
    this.adj.forEach((es, i) => {
      for (const e of es) {
        und[i].push(e.to);
        und[e.to].push(i);
      }
    });
    let c = 0;
    for (let s = 0; s < this.size; s++) {
      if (comp[s] >= 0) continue;
      const stack = [s];
      comp[s] = c;
      while (stack.length) {
        const u = stack.pop()!;
        for (const v of und[u])
          if (comp[v] < 0) {
            comp[v] = c;
            stack.push(v);
          }
      }
      c++;
    }
    return comp;
  }

  /**
   * データの道の切れ目(行き止まりの点)から、近くの別の道へ一般道でつなぐ。
   * 都道府県道のデータは市町村道との交差点などで切れていることが多く、その先は Google に任せる
   */
  private linkEnds() {
    const comp = this.components();
    const nb: Set<number>[] = this.adj.map(() => new Set());
    this.adj.forEach((es, i) => {
      for (const e of es)
        if (e.seg >= 0) {
          nb[i].add(e.to);
          nb[e.to].add(i);
        }
    });
    const ends: number[] = [];
    for (let i = 0; i < this.size; i++) if (nb[i].size <= 1 && !this.expNode[i]) ends.push(i);
    for (const i of ends) {
      const p = this.pos(i);
      // 同じかたまりの同じ道(戻るだけ)はつながない。高速道路にはつながない
      const near = this.nearbyGroups(p, FREE_RADIUS, 6, (j) => j === i || this.expNode[j] || (comp[j] === comp[i] && shares(this.nodeRoutes[i], this.nodeRoutes[j])), comp);
      for (const j of near) this.addFree(i, j, false);
    }
    // 下の道のデータにない道へ出入りする IC は、一方通行の一般道で近くの道につなぐ
    for (const [i, dir] of this.pendingFree) {
      for (const j of this.nearbyGroups(this.pos(i), FREE_RADIUS, 3, (j) => this.expNode[j] || !this.segNode[j])) {
        const w = dist(this.pos(i), this.pos(j)) * FREE_FACTOR + FREE_COST;
        if (dir) this.adj[j].push({ to: i, w: w + EXP_ENTER_COST, seg: SEG_FREE });
        else this.adj[i].push({ to: j, w, seg: SEG_FREE });
      }
    }
  }

  /** 道から離れた点を、一般道で近くの道につないだ点として足す(道筋を作る間だけ) */
  addOffRoad(p: NaviPoint): number {
    const q: LonLat = [p.lon, p.lat];
    const i = this.lon.length;
    this.lon.push(p.lon);
    this.lat.push(p.lat);
    this.adj.push([]);
    this.nodeRoutes.push(new Set());
    this.expNode.push(false);
    this.segNode.push(false);
    let near = this.nearbyGroups(q, FREE_RADIUS, 8, (j) => j >= this.baseSize || this.expNode[j] || !this.segNode[j]);
    if (!near.length) near = this.nearest(p, 0, Infinity).slice(0, 1);
    for (const j of near) this.addFree(i, j, true);
    return i;
  }

  /** 2つの点を一般道でじかにつなぐ(道筋を作る間だけ。データの道でつながらないときの最後の手段) */
  addFreeLink(a: number, b: number) {
    this.addFree(a, b, true);
  }

  /** その点が、一時的に足した点(道から離れた点)か */
  isTemp(i: number) {
    return i >= this.baseSize;
  }

  get size() {
    return this.lon.length;
  }

  pos(i: number): LonLat {
    return [this.lon[i], this.lat[i]];
  }

  private node(p: LonLat, routes: string[], exp = false, seg = true): number {
    const key = `${Math.round(p[0] * 1e5)},${Math.round(p[1] * 1e5)}`;
    let i = this.ids.get(key);
    if (i === undefined) {
      i = this.lon.length;
      this.ids.set(key, i);
      this.lon.push(p[0]);
      this.lat.push(p[1]);
      this.adj.push([]);
      this.nodeRoutes.push(new Set());
      this.expNode.push(exp);
      this.segNode.push(seg);
    } else {
      // 下の道と共有する点は、下の道の点
      if (!exp) this.expNode[i] = false;
      if (seg) this.segNode[i] = true;
    }
    for (const r of routes) this.nodeRoutes[i].add(r);
    return i;
  }

  /** 高速道路(本線・ランプ)だけの点か */
  isExp(i: number) {
    return !!this.expNode[i];
  }

  /** 近くの点(マス目で探す) */
  private grid(cell: number) {
    const g = new Map<string, number[]>();
    for (let i = 0; i < this.size; i++) {
      const k = `${Math.floor(this.lon[i] / cell)},${Math.floor(this.lat[i] / cell)}`;
      const list = g.get(k);
      if (list) list.push(i);
      else g.set(k, [i]);
    }
    return g;
  }

  private linkNearby() {
    const cell = 0.002;
    const g = this.grid(cell);
    for (let i = 0; i < this.size; i++) {
      // 高速道路はランプでだけ乗り降りする
      if (this.expNode[i]) continue;
      const gx = Math.floor(this.lon[i] / cell);
      const gy = Math.floor(this.lat[i] / cell);
      // 別の国道ごとに、いちばん近い点(と、そこから 40m 以内の点。上下線の両方)とつなぐ
      const near = new Map<string, [number, number][]>();
      for (let dx = -1; dx <= 1; dx++)
        for (let dy = -1; dy <= 1; dy++)
          for (const j of g.get(`${gx + dx},${gy + dy}`) ?? []) {
            if (j === i || this.expNode[j] || shares(this.nodeRoutes[i], this.nodeRoutes[j])) continue;
            const d = dist(this.pos(i), this.pos(j));
            if (d > LINK_DIST) continue;
            const key = [...this.nodeRoutes[j]].sort().join(",");
            const list = near.get(key);
            if (list) list.push([j, d]);
            else near.set(key, [[j, d]]);
          }
      for (const list of near.values()) {
        const dmin = Math.min(...list.map(([, d]) => d));
        for (const [j, d] of list) if (d <= dmin + 40) this.adj[i].push({ to: j, w: d + LINK_COST, seg: -1 });
      }
    }
  }

  /** 点に近い道の点(いちばん近い点から、さらに slack m 以内のもの。上下線の両方を拾う) */
  nearest(p: NaviPoint, slack = 40, within = 1500): number[] {
    const q: LonLat = [p.lon, p.lat];
    let dmin = Infinity;
    const ds: number[] = new Array(this.size);
    const n = this.baseSize || this.size;
    // 選んだ点は下の道に置く(高速道路・ランプの上には置かない)
    for (let i = 0; i < n; i++) {
      ds[i] = this.expNode[i] || !this.segNode[i] ? Infinity : dist(q, this.pos(i));
      if (ds[i] < dmin) dmin = ds[i];
    }
    if (dmin > within) return [];
    const out: number[] = [];
    for (let i = 0; i < n; i++) if (ds[i] <= dmin + slack) out.push(i);
    return out;
  }

  /**
   * 道筋の点のうち交差点(つながる点が3つ以上)の添字。辺は向き付きなので、入ってくる辺も数える。
   * 一般道の仮の辺(データにない道)は数えない
   */
  junctionsOf(nodes: number[]): number[] {
    const want = new Map<number, Set<number>>();
    for (const n of nodes) want.set(n, new Set());
    for (let a = 0; a < this.adj.length; a++)
      for (const e of this.adj[a]) {
        if (e.seg === SEG_FREE) continue;
        want.get(a)?.add(e.to);
        want.get(e.to)?.add(a);
      }
    const out: number[] = [];
    nodes.forEach((n, i) => {
      if (i > 0 && i < nodes.length - 1 && want.get(n)!.size >= 3) out.push(i);
    });
    return out;
  }

  /** 点からいちばん近い道までの距離(m) */
  distanceTo(p: NaviPoint): number {
    const n = this.nearest(p, 0, Infinity);
    return n.length ? dist([p.lon, p.lat], this.pos(n[0])) : Infinity;
  }

  /** 点のいちばん近くの国道(画面の表示用) */
  routesNear(p: NaviPoint): string[] {
    const n = this.nearest(p, 0);
    return n.length ? [...this.nodeRoutes[n[0]]].sort(compareRef) : [];
  }

  /** いくつかの点からいくつかの点への最短の道筋(点の番号の列と、通る辺) */
  shortest(from: number[], to: number[]): { nodes: number[]; edges: Edge[] } | null {
    const goal = new Set(to);
    const d = new Float64Array(this.size).fill(Infinity);
    const prev = new Int32Array(this.size).fill(-1);
    const prevEdge: (Edge | undefined)[] = new Array(this.size);
    const heap = new Heap();
    for (const s of from) {
      d[s] = 0;
      heap.push(0, s);
    }
    while (heap.size) {
      const [du, u] = heap.pop();
      if (du > d[u]) continue;
      if (goal.has(u)) {
        const nodes = [u];
        const edges: Edge[] = [];
        for (let v = u; prev[v] >= 0; v = prev[v]) {
          nodes.push(prev[v]);
          edges.push(prevEdge[v]!);
        }
        return { nodes: nodes.reverse(), edges: edges.reverse() };
      }
      for (const e of this.adj[u]) {
        const nd = du + e.w;
        if (nd < d[e.to]) {
          d[e.to] = nd;
          prev[e.to] = u;
          prevEdge[e.to] = e;
          heap.push(nd, e.to);
        }
      }
    }
    return null;
  }
}

function shares(a: Set<string>, b: Set<string>) {
  for (const x of a) if (b.has(x)) return true;
  return false;
}

/** 小さい順に取り出せる入れ物 */
class Heap {
  private k: number[] = [];
  private v: number[] = [];
  get size() {
    return this.k.length;
  }
  push(key: number, val: number) {
    const { k, v } = this;
    let i = k.length;
    k.push(key);
    v.push(val);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (k[p] <= key) break;
      k[i] = k[p];
      v[i] = v[p];
      i = p;
    }
    k[i] = key;
    v[i] = val;
  }
  pop(): [number, number] {
    const { k, v } = this;
    const top: [number, number] = [k[0], v[0]];
    const lk = k.pop()!;
    const lv = v.pop()!;
    if (k.length) {
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= k.length) break;
        if (c + 1 < k.length && k[c + 1] < k[c]) c++;
        if (k[c] >= lk) break;
        k[i] = k[c];
        v[i] = v[c];
        i = c;
      }
      k[i] = lk;
      v[i] = lv;
    }
    return top;
  }
}

/** 点の並びを、国道(と都道府県道・一般道)でつないだ道筋にして経由地とリンクを作る */
export function planNavi(graph: RoadGraph, points: NaviPoint[], opts: NaviOptions = {}): NaviResult {
  if (points.length < 2) return { error: "出発と到着の2か所以上を選んでください" };
  try {
    return planInner(graph, points, opts);
  } finally {
    graph.resetTemp();
  }
}

function planInner(graph: RoadGraph, points: NaviPoint[], opts: NaviOptions): NaviResult {
  const free = !!opts.free;
  const perLink = Math.max(1, Math.min(9, opts.perLink ?? 9));
  const ratio = opts.ratio ?? 1.15;
  const maxGap = opts.maxGap ?? 7000;

  // 1. 道筋
  const nodes: number[] = [];
  const edges: Edge[] = [];
  /** 選んだ点(途中)に着いた位置(nodes の添字) */
  const picked: number[] = [];
  /** 道から離れた点(その場所にそのまま経由地を置く) */
  const exact = new Set<number>();
  // 一般道も使うときは、道から離れた点はその場所の点にして、一般道で近くの道につなぐ
  const snap = (p: NaviPoint): number[] => (free && graph.distanceTo(p) > OFF_ROAD ? [graph.addOffRoad(p)] : graph.nearest(p));
  let from = snap(points[0]);
  if (!from.length) return { error: "1番目の点の近くに道がありません", leg: 0 };
  for (let i = 1; i < points.length; i++) {
    const to = snap(points[i]);
    if (!to.length) return { error: `${i + 1}番目の点の近くに道がありません`, leg: i };
    let r = graph.shortest(from, to);
    if (!r && free) {
      // データの道でつながらなければ、その区間はまるごと Google に任せる
      graph.addFreeLink(from[0], to[0]);
      r = graph.shortest(from, to);
    }
    if (!r) return { error: `${i}番目から${i + 1}番目の点まで、データの道だけではつながりませんでした(上下線の向きや、データの切れ目のため。「一般道も使う」にするとつなげます)`, leg: i };
    if (nodes.length) r.nodes.shift();
    else nodes.push(r.nodes.shift()!);
    nodes.push(...r.nodes);
    edges.push(...r.edges);
    if (i < points.length - 1) picked.push(nodes.length - 1);
    if (graph.isTemp(nodes[nodes.length - 1])) exact.add(nodes.length - 1);
    from = [nodes[nodes.length - 1]];
  }
  const pos = nodes.map((n) => graph.pos(n));
  const acc = [0];
  for (let i = 1; i < pos.length; i++) acc.push(acc[i - 1] + dist(pos[i - 1], pos[i]));
  const end = pos.length - 1;
  if (end < 1) return { error: "出発と到着が同じ場所です" };

  // 各点の国道(その点に入る辺の区間。最初の点は出る辺)と、経由地にしてよいか
  const segAt = (i: number) => edges[Math.max(0, i - 1)]?.seg ?? SEG_LINK;
  const routesOfSeg = (s: number) => (s === SEG_FREE ? [FREE_REF] : s >= 0 ? graph.segments[s].routes : null);
  const routesAt = (i: number): string[] => {
    for (let j = i; j >= 0 && j > i - 50; j--) {
      const rs = routesOfSeg(segAt(j));
      if (rs) return rs;
    }
    return [];
  };
  /** 高速道路(ランプを含む)の辺か */
  const expEdge = (e: Edge | undefined) => !!e && (e.seg === SEG_RAMP || (e.seg >= 0 && isExpSegment(graph.segments[e.seg])));
  // 一般道の区間と、高速道路の区間
  const spansOf = (pred: (e: Edge) => boolean) => {
    const out: { from: number; to: number }[] = [];
    edges.forEach((e, k) => {
      if (!pred(e)) return;
      const last = out[out.length - 1];
      if (last && last.to === acc[k]) last.to = acc[k + 1];
      else out.push({ from: acc[k], to: acc[k + 1] });
    });
    return out;
  };
  const freeSpans = spansOf((e) => e.seg === SEG_FREE);
  const expSpans = spansOf(expEdge);
  const rampSpans = spansOf((e) => e.seg === SEG_RAMP);
  const safeEdge = (e: Edge | undefined) => {
    if (!e || e.seg < 0) return false;
    const s = graph.segments[e.seg];
    return s.len >= SAFE_LEN && !s.tunnel && !isExpSegment(s);
  };
  // 点の前後の辺がどちらも安全なら、その点は経由地にしてよい
  const safe = (i: number) => i > 0 && i < end && safeEdge(edges[i - 1]) && safeEdge(edges[i]);
  /** i から手前 limit m 以内で、経由地にしてよい点 */
  const backward = (i: number, limit: number) => {
    for (let j = i; j > 0 && acc[i] - acc[j] <= limit; j--) if (safe(j)) return j;
    return i;
  };
  /** i から先 limit m 以内で、経由地にしてよい点 */
  const forward = (i: number, min: number, limit: number) => {
    let first = -1;
    for (let j = i; j < end && acc[j] - acc[i] <= limit; j++) {
      if (acc[j] - acc[i] < min) continue;
      if (first < 0) first = j;
      if (safe(j)) return j;
    }
    return first >= 0 ? first : Math.min(i, end);
  };

  // 2. 必ず置く経由地: 出発の少し先、選んだ点、国道を乗り換えた少し先(400m)
  const must = new Set<number>();
  must.add(forward(0, 200, 800));
  for (const i of picked) must.add(exact.has(i) ? i : forward(i, 0, 500));
  for (const p of opts.extra ?? []) {
    const q: LonLat = [p.lon, p.lat];
    let k = -1;
    let dk = 300;
    for (let i = 1; i < end; i++) {
      const d = dist(q, pos[i]);
      if (d < dk) {
        dk = d;
        k = i;
      }
    }
    if (k > 0) {
      const f = safe(k) ? k : forward(k, 0, 300);
      // 高速道路の上には置かない(高速道路は Google に任せる)
      if (safe(f)) must.add(f);
    }
  }
  // 一般道・高速道路に入る少し手前(そこまではデータの道を通らせる。高速道路は乗る IC を決める)
  edges.forEach((e, k) => {
    if (k === 0) return;
    if (e.seg === SEG_FREE && edges[k - 1].seg !== SEG_FREE) must.add(backward(k, 300));
    if (expEdge(e) && !expEdge(edges[k - 1])) must.add(backward(k, 300));
  });
  let cur = new Set(routesAt(1));
  /** 通る国道と、その区間(道筋の最初からの距離 m) */
  const spans: { ref: string; from: number; to: number }[] = [];
  let spanFrom = 0;
  const pushRoute = (rs: Iterable<string>, to: number) => {
    const r = [...rs].sort(compareRef)[0];
    const last = spans[spans.length - 1];
    if (r && last?.ref === r) last.to = to;
    else if (r) spans.push({ ref: r, from: spanFrom, to });
    spanFrom = to;
  };
  for (let i = 1; i <= end; i++) {
    const rs = routesOfSeg(edges[i - 1].seg);
    if (!rs) continue;
    const common = rs.filter((r) => cur.has(r));
    if (common.length) {
      cur = new Set(common);
      continue;
    }
    pushRoute(cur, acc[i - 1]);
    cur = new Set(rs);
    // 一般道・高速道路に入ったところには置かない(その中は Google に任せる)。
    // 高速道路を降りて下の道に入ったところには置く(降りる IC が決まる)
    if (rs[0] !== FREE_REF && !rs.some(isExpRef)) must.add(forward(i, 400, 1200));
  }
  pushRoute(cur, acc[end]);
  must.add(end);
  // 高速道路の途中には置かない
  const musts = [...must].filter((i) => i > 0 && (i === end || !(expEdge(edges[i - 1]) && expEdge(edges[i])))).sort((a, b) => a - b);

  /** 高速道路の区間が i の先で終わる点(降りたところ) */
  const expEnd = (i: number) => {
    let k = i;
    while (k < end && expEdge(edges[k])) k++;
    return k;
  };

  // 3. 必ず置く経由地の間を埋める。「国道の距離 / 直線距離」が ratio を超えない一番遠い点まで進む。
  //    高速道路の区間は Google に任せるので置かない
  const wps: number[] = [];
  let at = 0;
  let firstDone = false;
  for (const m of musts) {
    if (!firstDone) {
      firstDone = true;
      // 出発(現在地)から最初の経由地までは、Google に任せる
      wps.push(m);
      at = m;
      continue;
    }
    while (at < m) {
      let best = -1;
      let exp = -1;
      for (let j = at + 1; j <= m; j++) {
        if (expEdge(edges[j - 1])) {
          exp = j - 1;
          break;
        }
        const pd = acc[j] - acc[at];
        if (pd > maxGap) break;
        if (pd <= ratio * dist(pos[at], pos[j]) + 1) best = j;
      }
      if (exp >= 0 && (best < 0 || best >= exp || acc[exp] - acc[best] < 1000)) {
        // 高速道路の手前まで来た: 降りたところまで飛ばす
        const k = expEnd(exp);
        if (k >= m) {
          wps.push(m);
          at = m;
          break;
        }
        at = k;
        continue;
      }
      if (best < 0) best = at + 1;
      if (best >= m) {
        wps.push(m);
        at = m;
        break;
      }
      // 近くの安全な点まで戻す(橋・トンネルを避ける)
      let b = best;
      for (let j = best; j > at && acc[best] - acc[j] < 800; j--)
        if (safe(j)) {
          b = j;
          break;
        }
      // 次の必ず置く経由地のすぐ手前なら置かない
      if (acc[m] - acc[b] < 300) {
        wps.push(m);
        at = m;
        break;
      }
      wps.push(b);
      at = b;
    }
  }
  const uniq = [...new Set(wps)].sort((a, b) => a - b);
  const waypoints: Waypoint[] = uniq.map((i) => ({
    lon: round5(pos[i][0]),
    lat: round5(pos[i][1]),
    at: acc[i],
    routes: routesAt(i),
  }));

  // 4. リンクに分ける(経由地 perLink 個 + 目的地 1 個ずつ)
  const links: NaviLink[] = [];
  let prevAt = 0;
  for (let k = 0; k < waypoints.length; k += perLink + 1) {
    const chunk = waypoints.slice(k, k + perLink + 1);
    const dest = chunk[chunk.length - 1];
    const ways = chunk.slice(0, -1);
    // このリンクの区間に 300m 以上かかる国道
    const rs = spans.filter((sp) => Math.min(sp.to, dest.at) - Math.max(sp.from, prevAt) >= 300).map((sp) => sp.ref);
    links.push({ url: googleMapsUrl(ways, dest), from: prevAt, to: dest.at, routes: rs, waypoints: ways, dest });
    prevAt = dest.at;
  }
  return { path: pos, length: acc[end], waypoints, routes: spans.map((sp) => sp.ref), links, acc, freeSpans, expSpans, spans, junctions: graph.junctionsOf(nodes), rampSpans };
}

const round5 = (v: number) => Math.round(v * 1e5) / 1e5;
const ll = (w: { lat: number; lon: number }) => `${w.lat},${w.lon}`;

/** Google マップのルートの URL(出発地なし=現在地から。開くとすぐナビを始める) */
export function googleMapsUrl(waypoints: { lat: number; lon: number }[], dest: { lat: number; lon: number }): string {
  const p = [`api=1`, `destination=${ll(dest)}`];
  if (waypoints.length) p.push(`waypoints=${waypoints.map(ll).join("%7C")}`);
  p.push("travelmode=driving", "dir_action=navigate");
  return `https://www.google.com/maps/dir/?${p.join("&")}`;
}

/** 選んだ点を囲む範囲(経度・緯度)。道筋が少しはみ出してもよいよう margin 度広げる */
export function bboxOf(points: NaviPoint[], margin = 0.15): [number, number, number, number] {
  const lons = points.map((p) => p.lon);
  const lats = points.map((p) => p.lat);
  return [Math.min(...lons) - margin, Math.min(...lats) - margin, Math.max(...lons) + margin, Math.max(...lats) + margin];
}

/**
 * 高速道路を読む範囲。高速道路は選んだ点から離れた所を通ることが多い(東京から奥三河へは浜松のそばを通る)ので、
 * 点の範囲の大きさに応じて広げる(最大 1 度)
 */
export function expBboxOf(points: NaviPoint[]): [number, number, number, number] {
  const [w, s, e, n] = bboxOf(points, 0);
  return bboxOf(points, 0.15 + Math.min(0.85, 0.3 * Math.max(e - w, n - s)));
}

/** 範囲にかかる区間だけを取り出す */
export function segmentsIn(segments: Segment[], box: [number, number, number, number]): Segment[] {
  const [w, s, e, n] = box;
  return segments.filter((seg) => seg.coords.some(([x, y]) => x >= w && x <= e && y >= s && y <= n));
}

/** リンクの一覧を、LINE などに貼れる文字にする */
export function linksText(plan: NaviPlan, routeName: (ref: string) => string): string {
  const km = (m: number) => (m / 1000).toFixed(1);
  const lines = [`ナビ(${plan.routes.map(routeName).join(" → ")}、約${km(plan.length)}km)`, "前のリンクの目的地に着いたら次のリンクを開く"];
  plan.links.forEach((l, i) => {
    lines.push("", `${i + 1}. ${l.routes.map(routeName).join(" → ")}(${km(l.from)}〜${km(l.to)}km)`, l.url);
  });
  return lines.join("\n");
}
