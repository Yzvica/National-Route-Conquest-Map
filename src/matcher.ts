import { distance, PointGrid, samplePoints } from "./geo";
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
}

export const DEFAULT_OPTIONS: MatchOptions = {
  tolerance: 30,
  fullThreshold: 0.8,
  maxGap: 2000,
  maxSpeedKmh: 200,
  portalRadius: 80,
};

const SAMPLE_STEP = 20;
const DENSIFY_STEP = 10;
const MIN_HIT_METERS = 50;
const COARSE = 500;

function pushGapPoints(out: LonLat[], pa: TrackPoint, pb: TrackPoint, b: LonLat, opt: MatchOptions) {
  const a: LonLat = [pa.lon, pa.lat];
  const d = distance(a, b);
  if (d <= DENSIFY_STEP || d > opt.maxGap) return;
  if (pa.time !== undefined && pb.time !== undefined) {
    const sec = (pb.time - pa.time) / 1000;
    if (sec <= 0 || (d / sec) * 3.6 > opt.maxSpeedKmh) return;
  }
  const n = Math.floor(d / DENSIFY_STEP);
  for (let k = 1; k <= n; k++) {
    const f = k / (n + 1);
    out.push([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f]);
  }
}

/** ログの点の間を補間して、DENSIFY_STEP 間隔の点列にする */
export function densify(track: TrackPoint[], opt: MatchOptions): LonLat[] {
  const out: LonLat[] = [];
  for (let i = 0; i < track.length; i++) {
    const b: LonLat = [track[i].lon, track[i].lat];
    if (i > 0) pushGapPoints(out, track[i - 1], track[i], b, opt);
    out.push(b);
  }
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

  const dense = new PointGrid<null>(Math.max(opt.tolerance, 50));
  // ログから遠い区間をまとめて飛ばすための粗いマス(区間は 200m 前後なので、端から COARSE m 以内を見れば足りる)
  const coarse = new PointGrid<null>(COARSE);
  for (const p of densify(track, opt)) {
    dense.add(p, null);
    coarse.add(p, null);
  }

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
    const samples = samplePoints(seg.coords, SAMPLE_STEP);
    let hit = 0;
    for (const s of samples) if (dense.hasNear(s, opt.tolerance)) hit++;
    // 交差点で隣の区間の端に触れただけ、のようなものは数えない
    if (hit * SAMPLE_STEP < MIN_HIT_METERS) continue;
    const ratio = hit / samples.length;
    result.set(seg.id, ratio >= opt.fullThreshold ? 1 : ratio);
  }
  return result;
}
