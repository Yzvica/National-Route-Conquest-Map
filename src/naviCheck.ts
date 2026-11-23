// 作ったリンクを Google(Routes API。MiniPC が中継)に問い合わせて、Google が実際に引く道と道筋を比べる。
// Google が道筋から外れる所(近道や回り道)を見つけて、そこに経由地を足せば直せるようにする。
// 一般道・高速道路の区間は Google に任せているので、そこで外れるのは数えない。
import { dist, type NaviLink, type NaviPlan } from "./navi";
import type { LonLat } from "./types";

/** Google の encoded polyline を [経度, 緯度] の列にする */
export function decodePolyline(str: string): LonLat[] {
  const out: LonLat[] = [];
  let i = 0;
  let lat = 0;
  let lon = 0;
  const next = () => {
    let shift = 0;
    let result = 0;
    let b: number;
    do {
      b = str.charCodeAt(i++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20 && i <= str.length);
    return result & 1 ? ~(result >> 1) : result >> 1;
  };
  while (i < str.length) {
    lat += next();
    lon += next();
    out.push([lon / 1e5, lat / 1e5]);
  }
  return out;
}

/** Google が道筋から外れた所 */
export interface OffRoute {
  /** 道筋のどこから外れて、どこで戻ったか(道筋の最初からの距離 m) */
  from: number;
  to: number;
  /** 道筋からいちばん離れた Google の道の点と、その距離(m) */
  far: LonLat;
  off: number;
  /** Google の道の外れた部分 */
  line: LonLat[];
}

export interface RouteCheck {
  /** Google の道の長さ(m) */
  googleLength: number;
  /** このリンクの道筋の長さ(m。一般道の区間は直線) */
  planLength: number;
  /** 秒 */
  duration: number;
  line: LonLat[];
  offs: OffRoute[];
}

/** これより離れたら外れたとみなす(m) */
const OFF_DIST = 120;
/** 外れて戻るまでの道筋の長さがこれ未満のものは数えない(交差点の曲がり方の違いなど) */
const MIN_SPAN = 200;
/** 一般道の区間の前後この距離(m)は数えない */
const FREE_MARGIN = 300;

/** 点 p に一番近い、道筋(from〜to の範囲)の上の位置と距離 */
function locate(plan: NaviPlan, p: LonLat, lo: number, hi: number): { at: number; d: number } {
  const { path, acc } = plan;
  let best = { at: 0, d: Infinity };
  const k = Math.cos(p[1] * (Math.PI / 180)) * 111320;
  const m = 110950;
  for (let i = lo; i < hi; i++) {
    const a = path[i];
    const b = path[i + 1];
    const ax = (a[0] - p[0]) * k;
    const ay = (a[1] - p[1]) * m;
    const bx = (b[0] - p[0]) * k;
    const by = (b[1] - p[1]) * m;
    const dx = bx - ax;
    const dy = by - ay;
    const l2 = dx * dx + dy * dy;
    const t = l2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / l2)) : 0;
    const d = Math.hypot(ax + dx * t, ay + dy * t);
    if (d < best.d) best = { at: acc[i] + (acc[i + 1] - acc[i]) * t, d };
  }
  return best;
}

/** Google の道(line)と、プランのリンク(link)の道筋を比べる */
export function compareRoute(plan: NaviPlan, link: NaviLink, googleLine: LonLat[], googleLength: number, duration = 0): RouteCheck {
  const { acc } = plan;
  // 点の間が長いところは細かく切る(まっすぐな長い辺の途中で外れているのを見逃さないように)
  const line = densify(googleLine, 50);
  // このリンクの範囲の道筋(少し広めに)
  let lo = 0;
  while (lo < acc.length - 1 && acc[lo + 1] < link.from - 500) lo++;
  let hi = lo;
  while (hi < acc.length - 1 && acc[hi] < link.to + 500) hi++;
  const loc = line.map((p) => locate(plan, p, lo, hi));
  // 高速道路の区間も Google に任せている(どの高速道路を通るか、どこで乗り換えるか)
  const inFree = (a: number, b: number) =>
    [...plan.freeSpans, ...(plan.expSpans ?? [])].some((f) => Math.min(b, f.to + FREE_MARGIN) > Math.max(a, f.from - FREE_MARGIN));
  const offs: OffRoute[] = [];
  let i = 0;
  while (i < line.length) {
    if (loc[i].d <= OFF_DIST) {
      i++;
      continue;
    }
    let j = i;
    while (j < line.length && loc[j].d > OFF_DIST) j++;
    // 外れる直前と戻った直後の道筋の位置
    const from = i > 0 ? loc[i - 1].at : link.from;
    const to = j < line.length ? loc[j].at : link.to;
    let far = i;
    for (let k = i; k < j; k++) if (loc[k].d > loc[far].d) far = k;
    const a = Math.min(from, to);
    const b = Math.max(from, to);
    // 道筋を戻る向きに外れた(引き返した)ときは、長さによらず数える
    if (!inFree(a, b) && (b - a >= MIN_SPAN || to < from - 50)) {
      offs.push({ from, to, far: line[far], off: loc[far].d, line: line.slice(Math.max(0, i - 1), Math.min(line.length, j + 1)) });
    }
    i = j;
  }
  return { googleLength, planLength: link.to - link.from, duration, line: googleLine, offs };
}

function densify(line: LonLat[], step: number): LonLat[] {
  const out: LonLat[] = line.slice(0, 1);
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1];
    const b = line[i];
    const n = Math.ceil(dist(a, b) / step);
    for (let k = 1; k < n; k++) out.push([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n]);
    out.push(b);
  }
  return out;
}

/** 外れた所を直すために経由地を置く場所。道筋の、外れた区間の真ん中の点 */
export function fixPoint(plan: NaviPlan, o: OffRoute): { lon: number; lat: number } {
  const at = (Math.min(o.from, o.to) + Math.max(o.from, o.to)) / 2;
  let i = 0;
  while (i < plan.acc.length - 1 && plan.acc[i] < at) i++;
  const p = plan.path[i];
  return { lon: Math.round(p[0] * 1e5) / 1e5, lat: Math.round(p[1] * 1e5) / 1e5 };
}

/** リンクを Google に問い合わせるときの出発地(1本目は道筋の最初、2本目からは前のリンクの目的地) */
export function originOf(plan: NaviPlan, index: number): { lat: number; lon: number } {
  if (index > 0) return plan.links[index - 1].dest;
  const p = plan.path[0];
  return { lon: Math.round(p[0] * 1e5) / 1e5, lat: Math.round(p[1] * 1e5) / 1e5 };
}

/** 道の長さ(m) */
export const lineLength = (line: LonLat[]) => line.slice(1).reduce((s, p, i) => s + dist(line[i], p), 0);
