// 国道だけを通るルートを Google マップのナビに送るためのリンクを作る。
// Google マップは「速い道」を選ぶので、県道の近道を選ばせないよう、国道の上に経由地を細かく置く。
//   1. 地図で選んだ点(出発・通りたい国道の上・到着)を、国道のデータだけでつないだ道筋にする
//   2. 道筋の上に経由地を置く。曲がりくねって近道ができやすいところほど細かく、
//      国道を乗り換えたところ(分岐点)の少し先には必ず置く(手前で県道へ逃げにくくする)
//   3. Google マップの URL は経由地が最大9個(スマホのブラウザは3個)なので、区間ごとに複数のリンクに分ける
// 出発地は入れない(=現在地から)。前のリンクの目的地に着いたら次のリンクを開く使い方。
import type { LonLat, Segment } from "./types";

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
  /** その場所の国道番号 */
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
}

export interface NaviOptions {
  /** 1本のリンクに入れる経由地の数(目的地は別)。Google マップのアプリは9、スマホのブラウザは3 */
  perLink?: number;
  /** 経由地の間の「国道の距離 / 直線距離」の上限。小さいほど細かく置く */
  ratio?: number;
  /** 経由地の間の最大距離(m) */
  maxGap?: number;
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
/** 橋・高架・トンネルの上は経由地にしない(下の道や近くの道に付いてしまうため)。この長さ未満の区間は橋などとみなす */
const SAFE_LEN = 250;

interface Edge {
  to: number;
  w: number;
  /** 区間(つなぎの辺は -1) */
  seg: number;
}

/** 国道のデータから作った道のつながり */
export class RoadGraph {
  readonly lon: number[] = [];
  readonly lat: number[] = [];
  readonly adj: Edge[][] = [];
  private readonly ids = new Map<string, number>();
  private readonly nodeRoutes: Set<string>[] = [];

  constructor(readonly segments: Segment[]) {
    segments.forEach((s, si) => {
      const c = s.coords;
      // 上下線が別の道は一方通行(点の並びの向きに進む)
      const oneway = !!s.pair;
      for (let i = 0; i + 1 < c.length; i++) {
        const d = dist(c[i], c[i + 1]);
        const n = Math.max(1, Math.ceil(d / STEP));
        let prev = this.node(c[i], s.routes);
        for (let k = 1; k <= n; k++) {
          const p: LonLat = k === n ? c[i + 1] : [c[i][0] + ((c[i + 1][0] - c[i][0]) * k) / n, c[i][1] + ((c[i + 1][1] - c[i][1]) * k) / n];
          const cur = this.node(p, s.routes);
          this.adj[prev].push({ to: cur, w: d / n, seg: si });
          if (!oneway) this.adj[cur].push({ to: prev, w: d / n, seg: si });
          prev = cur;
        }
      }
    });
    this.linkNearby();
  }

  get size() {
    return this.lon.length;
  }

  pos(i: number): LonLat {
    return [this.lon[i], this.lat[i]];
  }

  private node(p: LonLat, routes: string[]): number {
    const key = `${Math.round(p[0] * 1e5)},${Math.round(p[1] * 1e5)}`;
    let i = this.ids.get(key);
    if (i === undefined) {
      i = this.lon.length;
      this.ids.set(key, i);
      this.lon.push(p[0]);
      this.lat.push(p[1]);
      this.adj.push([]);
      this.nodeRoutes.push(new Set());
    }
    for (const r of routes) this.nodeRoutes[i].add(r);
    return i;
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
      const gx = Math.floor(this.lon[i] / cell);
      const gy = Math.floor(this.lat[i] / cell);
      // 別の国道ごとに、いちばん近い点(と、そこから 40m 以内の点。上下線の両方)とつなぐ
      const near = new Map<string, [number, number][]>();
      for (let dx = -1; dx <= 1; dx++)
        for (let dy = -1; dy <= 1; dy++)
          for (const j of g.get(`${gx + dx},${gy + dy}`) ?? []) {
            if (j === i || shares(this.nodeRoutes[i], this.nodeRoutes[j])) continue;
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
    for (let i = 0; i < this.size; i++) {
      ds[i] = dist(q, this.pos(i));
      if (ds[i] < dmin) dmin = ds[i];
    }
    if (dmin > within) return [];
    const out: number[] = [];
    for (let i = 0; i < this.size; i++) if (ds[i] <= dmin + slack) out.push(i);
    return out;
  }

  /** 点のいちばん近くの国道(画面の表示用) */
  routesNear(p: NaviPoint): string[] {
    const n = this.nearest(p, 0);
    return n.length ? [...this.nodeRoutes[n[0]]].sort((a, b) => Number(a) - Number(b)) : [];
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

/** 点の並びを、国道だけでつないだ道筋にして経由地とリンクを作る */
export function planNavi(graph: RoadGraph, points: NaviPoint[], opts: NaviOptions = {}): NaviResult {
  if (points.length < 2) return { error: "出発と到着の2か所以上を選んでください" };
  const perLink = Math.max(1, Math.min(9, opts.perLink ?? 9));
  const ratio = opts.ratio ?? 1.15;
  const maxGap = opts.maxGap ?? 7000;

  // 1. 道筋
  const nodes: number[] = [];
  const edges: Edge[] = [];
  /** 選んだ点(途中)に着いた位置(nodes の添字) */
  const picked: number[] = [];
  let from = graph.nearest(points[0]);
  if (!from.length) return { error: "1番目の点の近くに国道がありません", leg: 0 };
  for (let i = 1; i < points.length; i++) {
    const to = graph.nearest(points[i]);
    if (!to.length) return { error: `${i + 1}番目の点の近くに国道がありません`, leg: i };
    const r = graph.shortest(from, to);
    if (!r) return { error: `${i}番目から${i + 1}番目の点まで、国道だけではつながりませんでした(上下線の向きや、データの切れ目のため)`, leg: i };
    if (nodes.length) r.nodes.shift();
    else nodes.push(r.nodes.shift()!);
    nodes.push(...r.nodes);
    edges.push(...r.edges);
    if (i < points.length - 1) picked.push(nodes.length - 1);
    from = [nodes[nodes.length - 1]];
  }
  const pos = nodes.map((n) => graph.pos(n));
  const acc = [0];
  for (let i = 1; i < pos.length; i++) acc.push(acc[i - 1] + dist(pos[i - 1], pos[i]));
  const end = pos.length - 1;
  if (end < 1) return { error: "出発と到着が同じ場所です" };

  // 各点の国道(その点に入る辺の区間。最初の点は出る辺)と、経由地にしてよいか
  const segAt = (i: number) => edges[Math.max(0, i - 1)]?.seg ?? -1;
  const routesAt = (i: number): string[] => {
    for (let j = i; j >= 0 && j > i - 50; j--) {
      const s = segAt(j);
      if (s >= 0) return graph.segments[s].routes;
    }
    return [];
  };
  const safeEdge = (e: Edge | undefined) => {
    if (!e || e.seg < 0) return false;
    const s = graph.segments[e.seg];
    return s.len >= SAFE_LEN && !s.tunnel;
  };
  // 点の前後の辺がどちらも安全なら、その点は経由地にしてよい
  const safe = (i: number) => i > 0 && i < end && safeEdge(edges[i - 1]) && safeEdge(edges[i]);
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
  for (const i of picked) must.add(forward(i, 0, 500));
  let cur = new Set(routesAt(1));
  /** 通る国道と、その区間(道筋の最初からの距離 m) */
  const spans: { ref: string; from: number; to: number }[] = [];
  let spanFrom = 0;
  const pushRoute = (rs: Iterable<string>, to: number) => {
    const r = [...rs].sort((a, b) => Number(a) - Number(b))[0];
    const last = spans[spans.length - 1];
    if (r && last?.ref === r) last.to = to;
    else if (r) spans.push({ ref: r, from: spanFrom, to });
    spanFrom = to;
  };
  for (let i = 1; i <= end; i++) {
    const s = edges[i - 1].seg;
    if (s < 0) continue;
    const rs = graph.segments[s].routes;
    const common = rs.filter((r) => cur.has(r));
    if (common.length) {
      cur = new Set(common);
      continue;
    }
    pushRoute(cur, acc[i - 1]);
    cur = new Set(rs);
    must.add(forward(i, 400, 1200));
  }
  pushRoute(cur, acc[end]);
  must.add(end);
  const musts = [...must].filter((i) => i > 0).sort((a, b) => a - b);

  // 3. 必ず置く経由地の間を埋める。「国道の距離 / 直線距離」が ratio を超えない一番遠い点まで進む
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
      for (let j = at + 1; j <= m; j++) {
        const pd = acc[j] - acc[at];
        if (pd > maxGap) break;
        if (pd <= ratio * dist(pos[at], pos[j]) + 1) best = j;
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
  return { path: pos, length: acc[end], waypoints, routes: spans.map((sp) => sp.ref), links };
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

/** 範囲にかかる区間だけを取り出す */
export function segmentsIn(segments: Segment[], box: [number, number, number, number]): Segment[] {
  const [w, s, e, n] = box;
  return segments.filter((seg) => seg.coords.some(([x, y]) => x >= w && x <= e && y >= s && y <= n));
}

/** リンクの一覧を、LINE などに貼れる文字にする */
export function linksText(plan: NaviPlan, routeName: (ref: string) => string): string {
  const km = (m: number) => (m / 1000).toFixed(1);
  const lines = [`国道ナビ(${plan.routes.map(routeName).join(" → ")}、約${km(plan.length)}km)`, "前のリンクの目的地に着いたら次のリンクを開く"];
  plan.links.forEach((l, i) => {
    lines.push("", `${i + 1}. ${l.routes.map(routeName).join(" → ")}(${km(l.from)}〜${km(l.to)}km)`, l.url);
  });
  return lines.join("\n");
}
