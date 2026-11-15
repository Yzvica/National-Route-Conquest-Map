// 電車の記録で GPS が途切れた区間(車内で電波が弱い・地下を走るなど)を、線路の形に沿って補うための線を作る。
// 補い方そのもの(途切れの見つけ方・最短の道・点の置き方)は tunnelFill.ts と同じで、道路の代わりに線路を渡す。
// 線路データ railways.json.gz は scripts/build_railways.py で OSM から作る(リリース route-data に置く)。
// 別の路線の線路どうしはつながっていないので、駅の近くでは線路と線路を「乗り換え」の短い線でつなぐ
import { distance } from "./geo";
import { DEFAULT_FILL_OPTIONS, type FillOptions, type FillRoad, type RoadSource } from "./tunnelFill";
import type { LonLat } from "./types";

export interface RailData {
  version: 1;
  generated?: string;
  /** 路線名(OSM の線路の name) */
  lines: string[];
  /** c: 線路の形、l: 路線名の番号、t: トンネル・地下 */
  segments: { c: LonLat[]; l?: number; t?: 1 }[];
  /** [経度, 緯度, 駅名] */
  stations: [number, number, string][];
}

/**
 * 電車の補い方。車内の GPS は精度が悪くなりがちなので、端の点とみなす精度と線路までの距離を道路より広く取る。
 * 線路は道路より遠回りに見えやすい(直線距離に対して)ので、遠回りの許容も広げる。新幹線の速さまで認める
 */
export const RAIL_FILL_OPTIONS: FillOptions = {
  ...DEFAULT_FILL_OPTIONS,
  anchorAccuracy: 100,
  maxSnapM: 150,
  detourRatio: 1.6,
  detourExtraM: 1500,
  maxSpeedMS: 330 / 3.6,
  // 短い途切れの補完と復帰直後の点を捨てるのは、車(道路)だけにする
  shortGapSec: 0,
  recoverMaxAcc: Infinity,
};

/** 駅からこの距離以内の線路どうしを乗り換えでつなぐ(m) */
export const TRANSFER_RADIUS_M = 300;
/** 乗り換え1回を道のりに直すと何 m 分か(これより短くなるときだけ乗り換える) */
export const TRANSFER_PENALTY_M = 1000;
/** 1つの駅で乗り換えをつなぐ線路の数の上限(近い順) */
const TRANSFER_MAX = 12;

const toRad = (d: number) => (d * Math.PI) / 180;
const M_PER_DEG = 111_320;

/** 点 p を線分 ab に下ろした位置(0〜1)と、その点 */
function project(p: LonLat, a: LonLat, b: LonLat): { f: number; q: LonLat } {
  const k = Math.cos(toRad(p[1]));
  const ax = (a[0] - p[0]) * k, ay = a[1] - p[1];
  const bx = (b[0] - p[0]) * k, by = b[1] - p[1];
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const f = len2 > 0 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
  return { f, q: [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f] };
}

type Box = [number, number, number, number];

function boxOf(c: LonLat[]): Box {
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const p of c) {
    if (p[0] < w) w = p[0];
    if (p[0] > e) e = p[0];
    if (p[1] < s) s = p[1];
    if (p[1] > n) n = p[1];
  }
  return [w, s, e, n];
}

const overlaps = (a: Box, b: Box) => a[2] >= b[0] && a[0] <= b[2] && a[3] >= b[1] && a[1] <= b[3];

/** 線路データから、範囲にかかる線路と、駅での乗り換えのつなぎを返す */
export function railsFromData(data: RailData): RoadSource {
  const boxes = data.segments.map((s) => boxOf(s.c));
  return (bbox) => {
    const segs: number[] = [];
    for (let i = 0; i < boxes.length; i++) if (overlaps(boxes[i], bbox)) segs.push(i);

    // 駅の近くの線路に、駅にいちばん近い位置の点を足し、別の路線の線路どうしをその点でつなぐ
    const inserts = new Map<number, { j: number; f: number; q: LonLat }[]>();
    const transfers: FillRoad[] = [];
    for (const [lon, lat] of data.stations) {
      if (lon < bbox[0] || lon > bbox[2] || lat < bbox[1] || lat > bbox[3]) continue;
      const st: LonLat = [lon, lat];
      const r = TRANSFER_RADIUS_M / M_PER_DEG;
      const rk = r / Math.cos(toRad(lat));
      const near: Box = [lon - rk, lat - r, lon + rk, lat + r];
      const cand: { seg: number; j: number; f: number; q: LonLat; d: number }[] = [];
      for (const i of segs) {
        if (!overlaps(boxes[i], near)) continue;
        const c = data.segments[i].c;
        let best: (typeof cand)[number] | null = null;
        for (let j = 1; j < c.length; j++) {
          const { f, q } = project(st, c[j - 1], c[j]);
          const d = distance(st, q);
          if (d <= TRANSFER_RADIUS_M && (!best || d < best.d)) best = { seg: i, j: j - 1, f, q, d };
        }
        if (best) cand.push(best);
      }
      cand.sort((a, b) => a.d - b.d).splice(TRANSFER_MAX);
      for (const c of cand) {
        const list = inserts.get(c.seg) ?? [];
        list.push(c);
        inserts.set(c.seg, list);
      }
      for (let x = 0; x < cand.length; x++) {
        for (let y = x + 1; y < cand.length; y++) {
          const la = data.segments[cand[x].seg].l, lb = data.segments[cand[y].seg].l;
          // 同じ名前の線路(複線の上下線など)は、線路どうしでつながっているはずなので乗り換えにしない
          if (la !== undefined && la === lb) continue;
          transfers.push({ coords: [cand[x].q, cand[y].q], oneway: false, tunnel: false, penaltyM: TRANSFER_PENALTY_M });
        }
      }
    }

    const out: FillRoad[] = [];
    for (const i of segs) {
      const s = data.segments[i];
      let coords = s.c;
      const ins = inserts.get(i);
      if (ins) {
        ins.sort((a, b) => a.j - b.j || a.f - b.f);
        coords = [];
        let k = 0;
        for (let j = 0; j < s.c.length; j++) {
          coords.push(s.c[j]);
          while (k < ins.length && ins[k].j === j) coords.push(ins[k++].q);
        }
      }
      out.push({ coords, oneway: false, tunnel: !!s.t, name: s.l !== undefined ? data.lines[s.l] : undefined });
    }
    return out.concat(transfers);
  };
}
