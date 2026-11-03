import { distance, PointGrid } from "./geo";
import { angleDiff, DEFAULT_OPTIONS, densify, headings, samplePointsWithDir, wayOf, type MatchOptions } from "./matcher";
import type { LonLat, RouteData, TrackPoint } from "./types";

/**
 * ログの各点が、高速道路の上(1)か、下の道(0)かの判定結果。
 * 高架の高速道路と、その下を並んで走る国道は GPS の位置だけでは区別できないので、
 * 道のつながり(ランプを通ったか)と速度・停止で、ログの前後の流れから決める(classifyTrack)
 */
export interface RoadLayers {
  /** densify の各点列の、各点の判定 */
  dense: Uint8Array[];
  /** ログの各点の判定 */
  raw: Uint8Array;
  /** 高速道路のデータにある OSM の way。国道データのうちこれと同じ way の区間は、高速道路と同じ道 */
  expWays: Set<string>;
  /** ログの近くにある国道・都道府県道の way。高速道路データのうちこれと同じ way の区間は、下の道と同じ道 */
  genWays: Set<string>;
}

const SAMPLE_STEP = 20;
const COARSE = 500;
/** 高速道路に出入りできる場所(ランプが本線につながる点など)から、この距離(m)以内なら乗り降りできる */
const ACCESS_RADIUS = 150;

// 以下は 10m ごとの点1つあたりの「ありえなさ」。合計が一番小さくなるように、高速道路の上か下の道かを決める
/** 高速道路の上としたのに、近くに高速道路がない */
const OFF_EXPRESSWAY = 0.5;
/** 下の道としたのに、近くに高速道路しかない(データにない市道などを走ったこともあるので小さめ) */
const EXPRESSWAY_ONLY = 0.3;
/** 下の道としたのに、この速度(km/h)より速い */
const FAST_KMH = 100;
const FAST = 0.1;
/** この速度(km/h)より遅い状態が STOP_SEC 秒続いたら、信号などで止まったとみなす */
const STOP_KMH = 5;
const STOP_SEC = 20;
/** 高速道路の上としたのに、止まった(信号は下の道にしかない。渋滞もあるので強くはしない) */
const STOP = 1;
/** ランプを通ったのに、乗り降りしていないとする */
const RAMP = 40;
/**
 * ランプのほとんどが下の道と重なっていて(道の真ん中から高架に上がるランプなど)、通ったのか下の道を走っただけか分からないとき。
 * あとで止まったか(信号)で決まるよう、乗り換え(SWITCH_NEAR)と止まったとき(STOP)の合計より小さくする
 */
const RAMP_WEAK = 2.5;
/** ランプの何割を、進む向きに通っていれば通ったとするか */
const RAMP_HIT = 0.7;
/** 高速道路と下の道を乗り換える。出入りできる場所の近く / それ以外 / 出入りできる場所のデータがないとき */
const SWITCH_NEAR = 2;
const SWITCH_FAR = 20;
const SWITCH_UNKNOWN = 10;
/** これより長く補間した点は GPS が切れていた(トンネルなど)ので、手がかりにしない(m) */
const GAP_FILL = 100;
/** 速度は前後この秒数の範囲で求める */
const SPEED_SPAN_SEC = 5;

const expWaysCache = new WeakMap<RouteData, Set<string>>();

function waysOf(data: RouteData): Set<string> {
  let s = expWaysCache.get(data);
  if (!s) {
    s = new Set(data.segments.map((x) => wayOf(x.id)));
    expWaysCache.set(data, s);
  }
  return s;
}

/** 向きの差(0〜π)。こちらは上り下りを区別する(ランプは一方通行なので) */
function directedDiff(a: number, b: number): number {
  return Math.abs(((((a - b + Math.PI) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) - Math.PI);
}

/** ログの各点の速度(km/h)。前後 SPEED_SPAN_SEC 秒の道のりから求める。時刻がなければ NaN */
function speeds(track: TrackPoint[]): Float64Array {
  const n = track.length;
  const v = new Float64Array(n).fill(NaN);
  const cum = new Float64Array(n);
  for (let i = 1; i < n; i++)
    cum[i] = cum[i - 1] + distance([track[i - 1].lon, track[i - 1].lat], [track[i].lon, track[i].lat]);
  let lo = 0;
  let hi = 0;
  for (let i = 0; i < n; i++) {
    const t = track[i].time;
    if (t === undefined) continue;
    while (lo < i && (track[lo].time === undefined || t - track[lo].time! > SPEED_SPAN_SEC * 1000)) lo++;
    if (hi < i) hi = i;
    while (hi + 1 < n && track[hi + 1].time !== undefined && track[hi + 1].time! - t <= SPEED_SPAN_SEC * 1000) hi++;
    const dt = (track[hi].time! - track[lo].time!) / 1000;
    if (dt > 0) v[i] = ((cum[hi] - cum[lo]) / dt) * 3.6;
  }
  return v;
}

/**
 * ログの各点が高速道路の上か、下の道(国道・都道府県道など)かを決める。
 * - 近くに高速道路しかなければ高速道路、高速道路がなければ下の道
 * - 両方が並んでいるところ(高架の下を国道が通るなど)は、前後の流れのまま。乗り換えられるのは、
 *   ランプが本線につながる場所の近くだけ(それ以外で乗り換えたとするのは、ありえなさが大きい)
 * - IC のランプを進む向きに通ったら、乗った・降りたとする
 * - 信号などで止まったら下の道、時速 100km を超えたら高速道路に寄せる
 * generals は国道・都道府県道のデータ
 */
export function classifyTrack(
  track: TrackPoint[],
  expressway: RouteData,
  generals: RouteData[],
  opt: MatchOptions = DEFAULT_OPTIONS,
): RoadLayers {
  const runs = densify(track, opt);
  const pts: LonLat[] = [];
  const hd: number[] = [];
  const rawOf: number[] = [];
  const filled: boolean[] = [];
  const runStart: number[] = [];
  const rawToFlat = new Int32Array(track.length).fill(-1);
  for (const run of runs) {
    runStart.push(pts.length);
    const hs = headings(run.pts);
    run.pts.forEach((p, i) => {
      if (!run.filled[i]) rawToFlat[run.raw[i]] = pts.length;
      pts.push(p);
      hd.push(hs[i]);
      rawOf.push(run.raw[i]);
      filled.push(run.filled[i]);
    });
  }
  const n = pts.length;
  const expWays = waysOf(expressway);
  const genWays = new Set<string>();
  const coarse = new PointGrid<null>(COARSE);
  for (const p of pts) coarse.add(p, null);
  const nearTrack = (coords: LonLat[], len: number) => len + opt.tolerance > COARSE || coarse.hasNear(coords[0], COARSE);

  const cell = Math.max(opt.tolerance, 50);
  const expGrid = new PointGrid<{ dir: number; toll: boolean }>(cell);
  for (const seg of expressway.segments) {
    if (!nearTrack(seg.coords, seg.len)) continue;
    const toll = seg.cats.includes("toll");
    for (const s of samplePointsWithDir(seg.coords, SAMPLE_STEP)) expGrid.add(s.p, { dir: s.dir, toll });
  }
  const genGrid = new PointGrid<number>(cell);
  for (const d of generals) {
    for (const seg of d.segments) {
      if (!nearTrack(seg.coords, seg.len)) continue;
      genWays.add(wayOf(seg.id));
      for (const s of samplePointsWithDir(seg.coords, SAMPLE_STEP)) genGrid.add(s.p, s.dir);
    }
  }
  const accessGrid = new PointGrid<null>(ACCESS_RADIUS);
  for (const p of expressway.access ?? []) if (coarse.hasNear(p, COARSE)) accessGrid.add(p, null);
  const hasAccessData = (expressway.access?.length ?? 0) > 0;

  const maxAngle = (opt.maxAngle * Math.PI) / 180;
  const along = (h: number, dir: number) => Number.isNaN(dir) || angleDiff(h, dir) <= maxAngle;
  const v = speeds(track);
  const costE = new Float64Array(n);
  const costN = new Float64Array(n);
  const access = new Uint8Array(n);
  for (let k = 0; k < n; k++) {
    const p = pts[k];
    const h = hd[k];
    let toll = false;
    const prev = rawOf[k] > 0 ? track[rawOf[k] - 1] : undefined;
    const gap =
      filled[k] && prev !== undefined && distance([prev.lon, prev.lat], [track[rawOf[k]].lon, track[rawOf[k]].lat]) > GAP_FILL;
    // 止まっていて向きが分からない点と、GPS が切れて補間した点は手がかりにしない
    if (!Number.isNaN(h) && !gap) {
      const cands = expGrid.near(p, opt.tolerance).filter((e) => along(h, e.v.dir));
      const hasE = cands.length > 0;
      toll = cands.some((e) => e.v.toll);
      const hasG = genGrid.some(p, opt.tolerance, (dir) => along(h, dir));
      if (!hasE) costE[k] += OFF_EXPRESSWAY;
      else if (!hasG) costN[k] += EXPRESSWAY_ONLY;
      if (v[rawOf[k]] > FAST_KMH) costN[k] += FAST;
    }
    // 有料道路(一般道)は交差点でも出入りできる
    if (toll || accessGrid.hasNear(p, ACCESS_RADIUS)) access[k] = 1;
  }

  // 止まった場所
  let slowSince: number | undefined;
  let counted = false;
  for (let i = 0; i < track.length; i++) {
    const t = track[i].time;
    if (t === undefined || !(v[i] < STOP_KMH)) {
      slowSince = undefined;
      counted = false;
      continue;
    }
    slowSince ??= t;
    if (!counted && t - slowSince >= STOP_SEC * 1000 && rawToFlat[i] >= 0) {
      costE[rawToFlat[i]] += STOP;
      counted = true;
    }
  }

  // ランプを通った場所
  const flatGrid = new PointGrid<number>(cell);
  pts.forEach((p, k) => flatGrid.add(p, k));
  for (const ramp of expressway.ramps ?? []) {
    if (ramp.c.length < 2 || !ramp.c.some((p) => coarse.hasNear(p, COARSE))) continue;
    const samples = samplePointsWithDir(ramp.c, SAMPLE_STEP);
    const hits = samples.map((s) =>
      flatGrid
        .near(s.p, opt.tolerance)
        .map((e) => e.v)
        .filter((k) => !Number.isNaN(hd[k]) && (Number.isNaN(s.dir) || directedDiff(hd[k], s.dir) <= maxAngle)),
    );
    const ends = [...hits[hits.length - 1]].sort((a, b) => a - b);
    if (ends.length === 0) continue;
    const overlap = samples.filter((s) => genGrid.some(s.p, opt.tolerance, (dir) => along(s.dir, dir))).length;
    const weight = overlap >= samples.length * RAMP_HIT ? RAMP_WEAK : RAMP;
    // ランプを通るのにかかる点の数のめやす(ランプの長さの3倍まで、ゆっくり走ったり止まったりしてもよい)
    const span = Math.ceil(((samples.length * SAMPLE_STEP) / 10) * 3) + 120;
    for (let j = 0; j < ends.length; j++) {
      // 同じときに通った点はまとめ、一番あとの点で調べる
      if (j + 1 < ends.length && ends[j + 1] - ends[j] <= span) continue;
      const end = ends[j];
      const ok = hits.filter((hs) => hs.some((k) => k <= end && k >= end - span)).length;
      if (ok < samples.length * RAMP_HIT) continue;
      // 入口のランプなら、通る前は下の道で、通ったあとは高速道路の上。出口のランプはその逆
      const start = Math.min(end, ...hits[0].filter((k) => k <= end && k >= end - span));
      if (ramp.k === "in") {
        costE[start] += weight;
        costN[end] += weight;
      } else {
        costN[start] += weight;
        costE[end] += weight;
      }
    }
  }

  // ありえなさの合計が一番小さい並びを、点列ごとに求める(ビタビ法)
  const state = new Uint8Array(n);
  const fromE = new Uint8Array(n); // その点で高速道路の上のとき、前の点が高速道路の上だったか
  const fromN = new Uint8Array(n);
  runStart.forEach((s, r) => {
    const e = r + 1 < runStart.length ? runStart[r + 1] : n;
    let dE = costE[s];
    let dN = costN[s];
    for (let k = s + 1; k < e; k++) {
      const sw = access[k] || access[k - 1] ? SWITCH_NEAR : hasAccessData ? SWITCH_FAR : SWITCH_UNKNOWN;
      // 同じなら乗り換えない
      const eFromN = dN + sw < dE;
      const nFromE = dE + sw < dN;
      const nE = costE[k] + (eFromN ? dN + sw : dE);
      const nN = costN[k] + (nFromE ? dE + sw : dN);
      fromE[k] = eFromN ? 0 : 1;
      fromN[k] = nFromE ? 1 : 0;
      dE = nE;
      dN = nN;
    }
    // 決め手がなければ下の道(これまでと同じ判定)
    let st = dE < dN ? 1 : 0;
    for (let k = e - 1; k >= s; k--) {
      state[k] = st;
      if (k > s) st = st ? fromE[k] : fromN[k];
    }
  });

  const dense = runStart.map((s, r) => state.slice(s, r + 1 < runStart.length ? runStart[r + 1] : n));
  const raw = new Uint8Array(track.length);
  for (let i = 0; i < track.length; i++) if (rawToFlat[i] >= 0) raw[i] = state[rawToFlat[i]];
  return { dense, raw, expWays, genWays };
}
