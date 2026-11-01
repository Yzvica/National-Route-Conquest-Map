import { distance, PointGrid } from "./geo";
import type { Coverage, LonLat, RouteData, TrackPoint } from "./types";

export interface MatchOptions {
  /** 道路からこの距離以内を通っていれば「通った」とみなす(m) */
  tolerance: number;
  /** 区間の何割以上を通れば100%扱いにするか */
  fullThreshold: number;
  /** ログの点と点の間がこの距離以内なら直線で補間する(m)。トンネル等で途切れたログを埋める */
  maxGap: number;
  /** 補間するときの上限速度(km/h)。これより速い移動は別の移動手段や飛びとみなす */
  maxSpeedKmh: number;
  /** トンネルの坑口判定の半径(m) */
  portalRadius: number;
  /**
   * 道路の向きとログの進んでいた向きの差がこれ(度)以下のときだけ、その道路を通ったとみなす。
   * 立体交差・交差点で横切っただけの道路(国道の上を通る高速道路など)を走ったことにしないため
   */
  maxAngle: number;
}

export const DEFAULT_OPTIONS: MatchOptions = {
  tolerance: 30,
  fullThreshold: 0.8,
  maxGap: 2000,
  maxSpeedKmh: 200,
  portalRadius: 80,
  maxAngle: 45,
};

const SAMPLE_STEP = 20;
const DENSIFY_STEP = 10;
const MIN_HIT_METERS = 50;
const COARSE = 500;
/** 進んでいた向きを、前後この距離(m)の点から求める */
const HEADING_SPAN = 20;
/** 前後の点がこれより近ければ止まっていたとみなし、向きは使わない */
const MIN_HEADING_SPAN = 8;
/** 前後の点の直線距離が、その間の道のりのこの割合より短ければ、ふらついているとみなし向きは使わない */
const MIN_STRAIGHTNESS = 0.75;

/** 2点の間をどうつなぐか。near: 近いのでそのまま / fill: 直線で補間する / break: 別の移動とみなして切る */
function legKind(pa: TrackPoint, pb: TrackPoint, d: number, opt: MatchOptions): "near" | "fill" | "break" {
  if (d <= DENSIFY_STEP) return "near";
  if (d > opt.maxGap) return "break";
  if (pa.time !== undefined && pb.time !== undefined) {
    const sec = (pb.time - pa.time) / 1000;
    if (sec <= 0 || (d / sec) * 3.6 > opt.maxSpeedKmh) return "break";
  }
  return "fill";
}

/** ログの点の間を補間して、DENSIFY_STEP 間隔の点列にする。補間できない飛びで切った、ひと続きの点列のリストを返す */
export function densifyRuns(track: TrackPoint[], opt: MatchOptions): LonLat[][] {
  const runs: LonLat[][] = [];
  let run: LonLat[] = [];
  for (let i = 0; i < track.length; i++) {
    const b: LonLat = [track[i].lon, track[i].lat];
    if (i > 0) {
      const pa = track[i - 1];
      const a: LonLat = [pa.lon, pa.lat];
      const d = distance(a, b);
      const kind = legKind(pa, track[i], d, opt);
      if (kind === "break") {
        runs.push(run);
        run = [];
      } else if (kind === "fill") {
        const n = Math.floor(d / DENSIFY_STEP);
        for (let k = 1; k <= n; k++) {
          const f = k / (n + 1);
          run.push([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f]);
        }
      }
    }
    run.push(b);
  }
  runs.push(run);
  return runs.filter((r) => r.length > 0);
}

/**
 * 向き(東を0とした角度、ラジアン)。上り下りは区別しないので、比べるときは angleDiff を使う。
 * 緯度による東西の縮みだけ補正した平面の近似
 */
function bearing(a: LonLat, b: LonLat): number {
  const k = Math.cos(((a[1] + b[1]) / 2) * (Math.PI / 180));
  return Math.atan2(b[1] - a[1], (b[0] - a[0]) * k);
}

/** 2つの向きの差(0〜π/2)。逆向きは同じ向きとみなす */
export function angleDiff(a: number, b: number): number {
  let d = Math.abs(a - b) % Math.PI;
  if (d > Math.PI / 2) d = Math.PI - d;
  return d;
}

/**
 * ひと続きの点列の各点で、進んでいた向きを求める。前後 HEADING_SPAN m ずつの点を結んだ向きにして
 * GPS のふらつきをならす。止まっていて向きが分からない点は NaN
 */
export function headings(run: LonLat[]): number[] {
  const cum = [0];
  for (let i = 1; i < run.length; i++) cum.push(cum[i - 1] + distance(run[i - 1], run[i]));
  const out: number[] = [];
  let lo = 0;
  let hi = 0;
  for (let i = 0; i < run.length; i++) {
    while (cum[i] - cum[lo] > HEADING_SPAN) lo++;
    if (hi < i) hi = i;
    while (hi < run.length - 1 && cum[hi] - cum[i] < HEADING_SPAN) hi++;
    // 止まっている間の GPS のふらつきは、道のりのわりに前後の点が近い(まっすぐ進んでいない)
    const chord = distance(run[lo], run[hi]);
    out.push(chord < MIN_HEADING_SPAN || chord < (cum[hi] - cum[lo]) * MIN_STRAIGHTNESS ? NaN : bearing(run[lo], run[hi]));
  }
  return out;
}

/** 線上に step メートルおきの点を取り、その場所での線の向きも返す(両端を含む) */
function samplePointsWithDir(coords: LonLat[], step: number): { p: LonLat; dir: number }[] {
  const out: { p: LonLat; dir: number }[] = [];
  const dirOf = (i: number) => bearing(coords[i - 1], coords[i]);
  if (coords.length < 2) return coords.map((p) => ({ p, dir: NaN }));
  out.push({ p: coords[0], dir: dirOf(1) });
  let carry = 0;
  for (let i = 1; i < coords.length; i++) {
    const a = coords[i - 1];
    const b = coords[i];
    const d = distance(a, b);
    const dir = dirOf(i);
    let t = step - carry;
    while (t < d) {
      const f = t / d;
      out.push({ p: [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f], dir });
      t += step;
    }
    carry = d - (t - step);
  }
  const last = coords[coords.length - 1];
  const prev = out[out.length - 1].p;
  if (prev[0] !== last[0] || prev[1] !== last[1]) out.push({ p: last, dir: dirOf(coords.length - 1) });
  return out;
}

/**
 * トンネルは GPS が飛ぶので、中の点ではなく「両方の坑口の近くを、
 * 短い時間差(またはログ上で連続して)通ったか」で判定する。
 */
function tunnelPassed(
  grid: PointGrid<number>,
  track: TrackPoint[],
  a: LonLat,
  b: LonLat,
  len: number,
  opt: MatchOptions,
): boolean {
  const nearA = grid.near(a, opt.portalRadius).map((e) => e.v);
  if (nearA.length === 0) return false;
  const nearB = grid.near(b, opt.portalRadius).map((e) => e.v);
  for (const i of nearA) {
    for (const j of nearB) {
      const ti = track[i].time;
      const tj = track[j].time;
      if (ti !== undefined && tj !== undefined) {
        // 渋滞で時速7kmまで落ちても通過とみなせる幅を持たせる
        const limit = (len / 2 + 300) * 1000;
        if (Math.abs(ti - tj) <= limit) return true;
      } else if (Math.abs(i - j) <= Math.max(50, len / 20)) {
        return true;
      }
    }
  }
  return false;
}

/** 1本のログで、各区間を何割走ったかを求める */
export function matchTrack(
  data: RouteData,
  track: TrackPoint[],
  opt: MatchOptions = DEFAULT_OPTIONS,
): Coverage {
  const result: Coverage = new Map();
  if (track.length === 0) return result;

  // 補間したログの点と、そこで進んでいた向き
  const dense = new PointGrid<number>(Math.max(opt.tolerance, 50));
  // ログから遠い区間をまとめて飛ばすための粗いマス(区間は 200m 前後なので、端から COARSE m 以内を見れば足りる)
  const coarse = new PointGrid<null>(COARSE);
  for (const run of densifyRuns(track, opt)) {
    const hs = headings(run);
    run.forEach((p, i) => {
      dense.add(p, hs[i]);
      coarse.add(p, null);
    });
  }
  const maxAngle = (opt.maxAngle * Math.PI) / 180;

  const raw = new PointGrid<number>(Math.max(opt.portalRadius, 50));
  track.forEach((p, i) => raw.add([p.lon, p.lat], i));

  const tunnelOk = new Map<string, boolean>();
  for (const t of data.tunnels) {
    tunnelOk.set(t.id, tunnelPassed(raw, track, t.a, t.b, t.len, opt));
  }

  for (const seg of data.segments) {
    if (seg.tunnel && tunnelOk.get(seg.tunnel)) {
      result.set(seg.id, 1);
      continue;
    }
    if (seg.len + opt.tolerance <= COARSE && !coarse.hasNear(seg.coords[0], COARSE)) continue;
    const samples = samplePointsWithDir(seg.coords, SAMPLE_STEP);
    let hit = 0;
    for (const s of samples) {
      // 近くを、道路と同じ向き(上り下りは問わない)に進んでいたログの点があれば通ったとみなす。
      // 止まっていて向きが分からない点は使わない(前後に動いていた点があるので、それで判定できる)
      if (dense.some(s.p, opt.tolerance, (h) => !Number.isNaN(h) && (Number.isNaN(s.dir) || angleDiff(h, s.dir) <= maxAngle)))
        hit++;
    }
    // 交差点で隣の区間の端に触れただけ、のようなものは数えない
    if (hit * SAMPLE_STEP < MIN_HIT_METERS) continue;
    const ratio = hit / samples.length;
    result.set(seg.id, ratio >= opt.fullThreshold ? 1 : ratio);
  }
  return result;
}
