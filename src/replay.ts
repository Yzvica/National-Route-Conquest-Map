// 運転リプレイのデータ: 時刻ごとの位置・速度・前後G・横G・躍度。
// 出どころは 3 つ(どれも同じ形にそろえる)
//   - iPhone のロガー: アプリが作って送る replay.csv(0.5 秒ごと。車の向きはアプリが評価と同じ方法で決める)
//   - GBowl の CSV: Raw X・Raw Y(G)の列から、運転評価(eval_gbowl.py)と同じ方法で計算する
//   - それ以外(GPX だけ・GoPro など): 位置と速度だけ
import { distance } from "./geo";
import { fileNameTime, gbowlStartTime, parseCsvRows } from "./parsers/csv";
import type { TrackPoint } from "./types";

export interface ReplayData {
  /** UNIX ミリ秒(増える順) */
  t: number[];
  lat: number[];
  lon: number[];
  kmh: number[];
  /** 前後の加速度(G、加速が +)。加速度の記録がなければ undefined */
  lonG?: number[];
  /** 左右の加速度(G、左に曲がる(体が右に押される)向きが +) */
  latG?: number[];
  /** 躍度(m/s³、前後と左右を合わせた大きさ) */
  jerk?: number[];
  source: "app" | "gbowl" | "gps";
}

const G0 = 9.80665;
const HZ = 10;
/** 躍度は加速度をこの時間でならしてから求める(運転評価の JERK_SMOOTH_S と同じ) */
const JERK_SMOOTH_S = 1.0;
/** GBowl の坂の分を求めるときにならす時間(eval_gbowl.py の BIAS_WINDOW_S と同じ) */
const BIAS_WINDOW_S = 20;

export const hasMotion = (d: ReplayData): d is ReplayData & Required<Pick<ReplayData, "lonG" | "latG" | "jerk">> =>
  !!(d.lonG && d.latG && d.jerk);

/** アプリが作る replay.csv(unix_s,lat,lon,kmh,lon_g,lat_g,jerk)を読む。読めなければ null */
export function parseReplayCsv(text: string): ReplayData | null {
  const rows = parseCsvRows(text.replace(/^﻿/, ""));
  if (rows.length < 3) return null;
  const head = rows[0].map((h) => h.trim());
  const col = (n: string) => head.indexOf(n);
  const [ct, cla, clo, ck, cg1, cg2, cj] = ["unix_s", "lat", "lon", "kmh", "lon_g", "lat_g", "jerk"].map(col);
  if (ct < 0 || cla < 0 || clo < 0 || ck < 0) return null;
  const motion = cg1 >= 0 && cg2 >= 0 && cj >= 0;
  const d: ReplayData = { t: [], lat: [], lon: [], kmh: [], source: "app" };
  if (motion) Object.assign(d, { lonG: [], latG: [], jerk: [] });
  for (const r of rows.slice(1)) {
    const t = Number(r[ct]) * 1000, la = Number(r[cla]), lo = Number(r[clo]), k = Number(r[ck]);
    if (![t, la, lo, k].every(Number.isFinite) || (d.t.length && t <= d.t[d.t.length - 1])) continue;
    d.t.push(t);
    d.lat.push(la);
    d.lon.push(lo);
    d.kmh.push(k);
    if (motion) {
      // 向きが決まらなかった区間などは空欄になるので 0 にする
      const num = (s: string | undefined) => (s === undefined || s.trim() === "" || !Number.isFinite(Number(s)) ? 0 : Number(s));
      d.lonG!.push(num(r[cg1]));
      d.latG!.push(num(r[cg2]));
      d.jerk!.push(num(r[cj]));
    }
  }
  return d.t.length >= 2 ? d : null;
}

/** 見出しから "(G)" などの単位を外す */
const bare = (h: string) => h.split("(")[0].trim();

/**
 * GBowl の CSV(と gbowl2csv.py が作った CSV)から、10 Hz の前後G・横G・躍度を作る。
 * GBowl は重力を分けられないので、前後の G から坂の分(GPS の速度の変化との差を 20 秒でならしたもの)を引く。
 * 加速度の列がなければ null
 */
export function gbowlReplay(text: string, fileName = ""): ReplayData | null {
  const rows = parseCsvRows(text.replace(/^﻿/, ""));
  const hi = rows.findIndex((r) => r[0]?.trim().startsWith("Time(") || (r[0]?.trim() === "datetime" && r[1]?.trim() === "elapsed_s"));
  if (hi < 0) return null;
  const head = rows[hi].map(bare);
  const conv = head[0] === "datetime";
  const pick = (gbowl: string, c: string) => head.indexOf(conv ? c : gbowl);
  const cols = {
    t: pick("Time", "elapsed_s"),
    gx: pick("Raw X", "g_lateral"),
    gy: pick("Raw Y", "g_longitudinal"),
    v: pick("Speed", "speed_kmh"),
    la: pick("Latitude", "latitude"),
    lo: pick("Longitude", "longitude"),
  };
  if (Object.values(cols).some((c) => c < 0)) return null;
  const valid = conv ? head.indexOf("motion_valid") : -1;

  let start: number | undefined;
  if (conv) {
    const first = rows[hi + 1];
    const m = first?.[0]?.trim().match(/^(\d{4})-(\d\d)-(\d\d) (\d\d):(\d\d):(\d\d(?:\.\d+)?)/);
    if (m) start = Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6].padStart(2, "0")}+09:00`) - Number(first[cols.t]) * 1000;
  } else start = gbowlStartTime(rows) ?? fileNameTime(fileName);
  if (start === undefined || !Number.isFinite(start)) return null;

  // [経過秒, 横G(左+), 前後G(後ろ+), km/h, 緯度, 経度]
  const num = (s: string | undefined) => (s === undefined || s.trim() === "" ? 0 : Number(s));
  const data: number[][] = [];
  for (const r of rows.slice(hi + 1)) {
    const v = [cols.t, cols.gx, cols.gy, cols.v, cols.la, cols.lo].map((c) => num(r[c]));
    if (!v.every(Number.isFinite) || (data.length && v[0] <= data[data.length - 1][0])) continue;
    if (valid >= 0 && r[valid]?.trim() === "0") v[1] = v[2] = 0;
    data.push(v);
  }
  if (data.length < HZ * 5) return null;
  // 位置が取れていない行(0,0)は前後の取れている位置で埋める
  fillMissingPositions(data);
  if (data.every((v) => v[4] === 0 && v[5] === 0)) return null;

  // 10 Hz の格子にする(抜けは線形に補う)
  const t0 = data[0][0];
  const n = Math.floor((data[data.length - 1][0] - t0) * HZ + 1e-6) + 1;
  const grid: number[][] = [];
  for (let i = 0, j = 0; i < n; i++) {
    const t = t0 + i / HZ;
    while (j + 2 < data.length && data[j + 1][0] <= t) j++;
    const a = data[j], b = data[Math.min(j + 1, data.length - 1)];
    const f = b[0] === a[0] ? 0 : Math.max(0, Math.min(1, (t - a[0]) / (b[0] - a[0])));
    grid.push(a.map((x, k) => x + (b[k] - x) * f));
  }

  // 坂の分を引く(前後だけ): GPS の速度の変化(前後 0.5 秒)から求めた前後の G との差を 20 秒でならす
  const h = HZ / 2;
  const ref = grid.map((_, i) => {
    const a = Math.max(0, i - h), b = Math.min(n - 1, i + h);
    return b > a ? -(grid[b][3] / 3.6 - grid[a][3] / 3.6) / ((b - a) / HZ) / G0 : 0;
  });
  const bias = movingAverage(grid.map((r, i) => r[2] - ref[i]), Math.floor((BIAS_WINDOW_S * HZ) / 2));
  const w = Math.floor((JERK_SMOOTH_S * HZ) / 2);
  const slon = movingAverage(grid.map((r, i) => -(r[2] - bias[i]) * G0), w);
  const slat = movingAverage(grid.map((r) => r[1] * G0), w);
  const jerk = slon.map((_, i) => (i === 0 ? 0 : Math.hypot((slon[i] - slon[i - 1]) * HZ, (slat[i] - slat[i - 1]) * HZ)));
  return {
    t: grid.map((_, i) => start! + (t0 + i / HZ) * 1000),
    lat: grid.map((r) => r[4]),
    lon: grid.map((r) => r[5]),
    kmh: grid.map((r) => Math.max(0, r[3])),
    lonG: slon.map((v) => v / G0),
    latG: slat.map((v) => v / G0),
    jerk,
    source: "gbowl",
  };
}

function fillMissingPositions(data: number[][]) {
  const ok = (v: number[]) => !(v[4] === 0 && v[5] === 0);
  let last = data.find(ok);
  if (!last) return;
  for (const v of data) {
    if (ok(v)) last = v;
    else {
      v[4] = last[4];
      v[5] = last[5];
    }
  }
}

/** 前後 w 点ずつの平均(端は入る点だけで) */
export function movingAverage(xs: number[], w: number): number[] {
  const pre = [0];
  for (const v of xs) pre.push(pre[pre.length - 1] + v);
  const n = xs.length;
  return xs.map((_, i) => {
    const lo = Math.max(0, i - w), hi = Math.min(n, i + w + 1);
    return (pre[hi] - pre[lo]) / (hi - lo);
  });
}

/**
 * 位置と速度だけのリプレイ。speeds は tripStats の速度(GPS の飛びを除いたもの)。
 * 時刻のない点は使わない。2 点に満たなければ null
 */
export function gpsReplay(track: TrackPoint[], speeds: { t: number; kmh: number }[]): ReplayData | null {
  const timed = track.filter((p): p is TrackPoint & { time: number } => p.time !== undefined).sort((a, b) => a.time - b.time);
  const d: ReplayData = { t: [], lat: [], lon: [], kmh: [], source: "gps" };
  const st = speeds.map((s) => s.t), sv = speeds.map((s) => s.kmh);
  for (const p of timed) {
    if (d.t.length && p.time <= d.t[d.t.length - 1]) continue;
    d.t.push(p.time);
    d.lat.push(p.lat);
    d.lon.push(p.lon);
    d.kmh.push(st.length ? interp(st, sv, p.time) : 0);
  }
  return d.t.length >= 2 ? d : null;
}

/** xs(増える順)で x の位置の値を線形に補う(範囲の外は端の値) */
export function interp(xs: number[], ys: number[], x: number): number {
  const n = xs.length;
  if (n === 0) return NaN;
  if (x <= xs[0]) return ys[0];
  if (x >= xs[n - 1]) return ys[n - 1];
  const i = indexAt(xs, x);
  const f = (x - xs[i]) / (xs[i + 1] - xs[i]);
  return ys[i] + (ys[i + 1] - ys[i]) * f;
}

/** xs(増える順)で xs[i] <= x となる最後の i(x が最初より前なら 0) */
export function indexAt(xs: number[], x: number): number {
  let lo = 0, hi = xs.length - 1;
  if (hi < 0 || x < xs[0]) return 0;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (xs[mid] <= x) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** 時刻 t の値(位置・速度・G・躍度) */
export interface ReplayFrame {
  t: number;
  lat: number;
  lon: number;
  kmh: number;
  lonG?: number;
  latG?: number;
  jerk?: number;
  /** 進む向き(北から時計回りの度)。止まっていて分からなければ undefined */
  bearing?: number;
}

export function frameAt(d: ReplayData, t: number): ReplayFrame {
  const f: ReplayFrame = { t, lat: interp(d.t, d.lat, t), lon: interp(d.t, d.lon, t), kmh: interp(d.t, d.kmh, t) };
  if (hasMotion(d)) {
    f.lonG = interp(d.t, d.lonG, t);
    f.latG = interp(d.t, d.latG, t);
    f.jerk = interp(d.t, d.jerk, t);
  }
  f.bearing = bearingAround(d, t);
  return f;
}

/** 前後数秒の位置から進む向きを求める(GPS の細かい揺れで向きがふらつかないように、5 m 以上離れた点で) */
function bearingAround(d: ReplayData, t: number): number | undefined {
  for (const s of [3000, 6000, 12000]) {
    const a: [number, number] = [interp(d.t, d.lon, t - s), interp(d.t, d.lat, t - s)];
    const b: [number, number] = [interp(d.t, d.lon, t + s), interp(d.t, d.lat, t + s)];
    if (distance(a, b) >= 5) return bearing(a, b);
  }
  return undefined;
}

/** a から b への向き(北から時計回りの度) */
export function bearing(a: [number, number], b: [number, number]): number {
  const r = Math.PI / 180;
  const y = Math.sin((b[0] - a[0]) * r) * Math.cos(b[1] * r);
  const x = Math.cos(a[1] * r) * Math.sin(b[1] * r) - Math.sin(a[1] * r) * Math.cos(b[1] * r) * Math.cos((b[0] - a[0]) * r);
  return ((Math.atan2(y, x) / r) + 360) % 360;
}

/** 地図で押した場所にいちばん近い点の時刻。maxPx より遠ければ undefined */
export function nearestTime(d: ReplayData, project: (lon: number, lat: number) => { x: number; y: number }, at: { x: number; y: number }, maxPx = 24): number | undefined {
  let best = Infinity, bt: number | undefined;
  for (let i = 0; i < d.t.length; i++) {
    const p = project(d.lon[i], d.lat[i]);
    const dd = (p.x - at.x) ** 2 + (p.y - at.y) ** 2;
    if (dd < best) {
      best = dd;
      bt = d.t[i];
    }
  }
  return best <= maxPx * maxPx ? bt : undefined;
}

/** 縦軸の上限を切りのよい値に(上位 0.5% は飛びとして外す) */
export function niceMax(vals: number[], floor: number, step: number, cap: number): number {
  const abs = vals.map(Math.abs).filter(Number.isFinite).sort((a, b) => a - b);
  const p = abs.length ? abs[Math.min(abs.length - 1, Math.floor(abs.length * 0.995))] : 0;
  return Math.min(cap, Math.max(floor, Math.ceil((p * 1.1) / step) * step));
}

/** MiniPC から iPhone のロガーの記録の replay.csv を読む。無ければ(アプリが古い・サーバーがない)null */
export async function fetchReplay(session: string): Promise<ReplayData | null> {
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}api/replay/${encodeURIComponent(session)}`);
    if (!res.ok) return null;
    return parseReplayCsv(await res.text());
  } catch {
    return null;
  }
}
