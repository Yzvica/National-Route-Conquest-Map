// 走行ログそのものの走行距離(国道かどうかに関係なく、ログ上で走った距離)
import { distance } from "./geo";
import { DEFAULT_OPTIONS } from "./matcher";
import type { TrackPoint } from "./types";

/** 1本のログの記録。m はメートル */
export interface Trip {
  date: string;
  m: number;
}

/**
 * ログの走行距離(m)。点と点を直線でつないで足す。
 * GPS が途切れた間も、時刻から見て時速200km以下なら走ったものとして足す(トンネルなど)。
 * 時刻がなければ、2km より離れた点の間は足さない
 */
export function trackLength(track: TrackPoint[], opt = DEFAULT_OPTIONS): number {
  let sum = 0;
  for (let i = 1; i < track.length; i++) {
    const a = track[i - 1];
    const b = track[i];
    const d = distance([a.lon, a.lat], [b.lon, b.lat]);
    if (a.time !== undefined && b.time !== undefined) {
      const hours = (b.time - a.time) / 3_600_000;
      if (hours <= 0 ? d > 50 : d / 1000 / hours > opt.maxSpeedKmh) continue;
    } else if (d > opt.maxGap) continue;
    sum += d;
  }
  return sum;
}

/**
 * 同じログを2回読み込んでも二重に数えないための名前。
 * ファイル名は保存のときに変わることがあるので、最初の点の時刻(なければ日付と点の数)で決める
 */
export function tripKey(track: TrackPoint[], date: string): string {
  const t = track.find((p) => p.time !== undefined)?.time;
  return t !== undefined ? `t${t}` : `d${date}-${track.length}`;
}
