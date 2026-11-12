// 車以外の移動(電車・飛行機・同乗・その他)の記録を、地図の「旅の記録」に出す線にする。
// iPhone の走行ロガーが RAW_LOG_DIR/trips/<走行ID>/ に送った location.csv と meta.json を読む。
// 国道の制覇には使わない(見るだけ)。
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** 地図に出す移動手段(meta.json の mode)。車は国道の判定に使うのでここには出さない */
export const TRIP_MODES = ["train", "plane", "ride", "other"];

/** 精度がこれより悪い点(基地局での測位など)は使わない(m) */
const MAX_ACC_M = 200;
/** 前の点からこれより速く動いた点は飛びとして捨てる(km/h) */
const MAX_SPEED_KMH = 1200;
/** 点の間がこれより空いたら、その間は点線にする(秒) */
const GAP_S = 180;
/** 線を間引くときの許容ずれ(m) */
const SIMPLIFY_M = 20;

const R = 6371008.8;
const rad = Math.PI / 180;

function dist(a, b) {
  const dLat = (b[1] - a[1]) * rad;
  const dLon = (b[0] - a[0]) * rad;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** 点 p と線分 a-b の距離(m)。狭い範囲なので平面で近似する */
function segDist(p, a, b) {
  const k = Math.cos(a[1] * rad) * R * rad;
  const ax = 0, ay = 0;
  const bx = (b[0] - a[0]) * k, by = (b[1] - a[1]) * R * rad;
  const px = (p[0] - a[0]) * k, py = (p[1] - a[1]) * R * rad;
  const len = bx * bx + by * by;
  const t = len === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * bx + (py - ay) * by) / len));
  return Math.hypot(px - t * bx, py - t * by);
}

/** Douglas-Peucker で線を間引く(再帰を使わない) */
export function simplify(line, tol = SIMPLIFY_M) {
  if (line.length <= 2) return line;
  const keep = new Uint8Array(line.length);
  keep[0] = keep[line.length - 1] = 1;
  const stack = [[0, line.length - 1]];
  while (stack.length) {
    const [i, j] = stack.pop();
    let best = -1, bestD = tol;
    for (let k = i + 1; k < j; k++) {
      const d = segDist(line[k], line[i], line[j]);
      if (d > bestD) (bestD = d), (best = k);
    }
    if (best >= 0) {
      keep[best] = 1;
      stack.push([i, best], [best, j]);
    }
  }
  return line.filter((_, k) => keep[k]);
}

const round = (v) => Math.round(v * 1e5) / 1e5;

/**
 * location.csv を、実線の区間(lines)と、点が途切れた間をつなぐ点線(gaps)にする。
 * 距離(m)は実線と点線の両方を足したもの
 */
export function tripLines(csv) {
  const rows = csv.split(/\r?\n/);
  const head = (rows.shift() ?? "").split(",");
  const col = (n) => head.indexOf(n);
  const cT = col("unix_s"), cLat = col("lat"), cLon = col("lon"), cAcc = col("h_acc_m"), cAlt = col("alt_m");
  if (cT < 0 || cLat < 0 || cLon < 0) throw new Error("location.csv に unix_s・lat・lon の列がありません");
  const lines = [];
  const gaps = [];
  let cur = [];
  let prev = null;
  let m = 0;
  let maxAlt = null;
  let first = null;
  let last = null;
  for (const row of rows) {
    if (!row) continue;
    const f = row.split(",");
    const t = Number(f[cT]), lat = Number(f[cLat]), lon = Number(f[cLon]);
    const acc = cAcc >= 0 && f[cAcc] !== "" ? Number(f[cAcc]) : 0;
    if (!Number.isFinite(t) || !Number.isFinite(lat) || !Number.isFinite(lon) || (lat === 0 && lon === 0)) continue;
    if (!(acc >= 0) || acc > MAX_ACC_M) continue;
    const p = [lon, lat];
    if (prev) {
      const d = dist(prev.p, p);
      const dt = t - prev.t;
      if (dt <= 0 || (d / dt) * 3.6 > MAX_SPEED_KMH) continue;
      m += d;
      if (dt > GAP_S) {
        if (cur.length > 1) lines.push(cur);
        gaps.push([prev.p, p]);
        cur = [];
      }
    }
    cur.push(p);
    prev = { t, p };
    first ??= t;
    last = t;
    const alt = cAlt >= 0 && f[cAlt] !== "" ? Number(f[cAlt]) : NaN;
    if (Number.isFinite(alt) && (maxAlt === null || alt > maxAlt)) maxAlt = alt;
  }
  if (cur.length > 1) lines.push(cur);
  return {
    lines: lines.map((l) => simplify(l).map((p) => [round(p[0]), round(p[1])])),
    gaps: gaps.map((g) => g.map((p) => [round(p[0]), round(p[1])])),
    m: Math.round(m),
    first,
    last,
    maxAlt,
  };
}

/**
 * 走行フォルダの運転評価(同乗でアプリが作る evaluation.json)。なければ null。
 * mount は端末の置き方("fixed" 固定・"hand" 手持ち)、usable_ratio は手持ちで採点に使えた時間の割合
 */
export function loadTripEval(dir) {
  try {
    const ev = JSON.parse(readFileSync(join(dir, "evaluation.json"), "utf8"));
    if (ev && typeof ev.score === "number" && Array.isArray(ev.items)) return ev;
  } catch {}
  return null;
}

/** 一覧に出す点数と置き方 */
function tripEvalSummary(dir) {
  const ev = loadTripEval(dir);
  if (!ev) return {};
  return { score: ev.score, ...(typeof ev.mount === "string" ? { mount: ev.mount } : {}) };
}

const cache = new Map();

/**
 * 1回の移動を読む。location.csv と meta.json が変わっていなければ前に作ったものを使う。
 * サーバーが途切れた区間を線路・道路に沿って補った location_filled.csv があれば、そちらを使う
 */
function loadTrip(dir, id) {
  const filled = join(dir, "location_filled.csv");
  const csvPath = existsSync(filled) ? filled : join(dir, "location.csv");
  const metaPath = join(dir, "meta.json");
  const evalPath = join(dir, "evaluation.json");
  if (!existsSync(csvPath)) return null;
  const mtime = (p) => (existsSync(p) ? statSync(p).mtimeMs : 0);
  const stamp = `${csvPath}:${statSync(csvPath).mtimeMs}:${mtime(metaPath)}:${mtime(evalPath)}`;
  const hit = cache.get(dir);
  if (hit?.stamp === stamp) return hit.trip;
  let meta = {};
  try {
    meta = JSON.parse(readFileSync(metaPath, "utf8"));
  } catch {}
  const mode = TRIP_MODES.includes(meta.mode) ? meta.mode : meta.mode === "car" ? null : "other";
  let trip = null;
  if (mode) {
    const l = tripLines(readFileSync(csvPath, "utf8"));
    if (l.lines.length || l.gaps.length) {
      const iso = (s) => (s === null ? null : new Date(s * 1000).toISOString());
      trip = {
        id,
        mode,
        start: typeof meta.start === "string" ? meta.start : iso(l.first),
        end: typeof meta.end === "string" ? meta.end : iso(l.last),
        m: typeof meta.distanceM === "number" && meta.distanceM > 0 ? Math.round(meta.distanceM) : l.m,
        maxAltM: typeof meta.maxAltitudeM === "number" ? Math.round(meta.maxAltitudeM) : l.maxAlt === null ? null : Math.round(l.maxAlt),
        lines: l.lines,
        gaps: l.gaps,
        ...tripEvalSummary(dir),
      };
    }
  }
  cache.set(dir, { stamp, trip });
  return trip;
}

/** trips フォルダの移動をすべて、新しい順に返す。読めないものは飛ばす */
export function listTrips(root) {
  const base = join(root, "trips");
  if (!existsSync(base)) return [];
  const out = [];
  for (const e of readdirSync(base, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    try {
      const t = loadTrip(join(base, e.name), e.name);
      if (t) out.push(t);
    } catch (err) {
      console.error(`旅の記録を読めません: ${e.name}: ${err.message}`);
    }
  }
  return out.sort((a, b) => String(b.start).localeCompare(String(a.start)));
}
