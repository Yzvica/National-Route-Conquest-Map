// MiniPC で動かすサーバー。ビルド済みのアプリ(dist/)を配信し、
// 走行記録を data/record.json に保存して、LAN 内のどの端末からも同じ記録を見られるようにする。
// Node.js の標準機能だけで動く。
import { createServer } from "node:http";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { freemem } from "node:os";
import { basename, dirname, extname, join, normalize, resolve } from "node:path";
import { Worker } from "node:worker_threads";
import { gunzipSync, gzipSync } from "node:zlib";
import { listTrips, loadTripEval } from "./trips.mjs";
import { fetchWeather, parseLocationCsv } from "./weather.mjs";
import { createGmaps } from "./gmaps.mjs";
import { collectHealth, renderHealthHtml } from "./health.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const DIST = join(ROOT, "dist");
const RECORD = process.env.RECORD_FILE ?? join(ROOT, "data", "record.json");
const PORT = Number(process.env.PORT ?? 8080);
// 読み込んだ走行ログそのもの。あとで判定方法や対象の道路(高速道路など)を増やしたときに判定し直せるよう残す
const LOGS = process.env.LOGS_DIR ?? join(dirname(RECORD), "logs");
// 走行ログをサーバーで判定する worker(npm run build で作る)と、判定に使う道路データ。
// JUDGE_WORKER を空にすると、サーバーでは判定しない(前と同じくブラウザで判定する)
const JUDGE_WORKER = process.env.JUDGE_WORKER ?? join(ROOT, "server", "build", "judgeWorker.js");
const JUDGE_DATA = process.env.JUDGE_DATA_DIR ?? join(DIST, "data");
// 判定し終えてから worker(道路データで数百MB使う)を止めるまでの時間。続けて送られてきたログで読み直さないよう少し待つ
const JUDGE_IDLE_MS = Number(process.env.JUDGE_IDLE_MS ?? 3 * 60_000);
// 判定 worker が使ってよいメモリ(V8 のヒープの上限、MB)。0 にすると上限なし。
// 実データで測ると、道路データを読んだだけで約 400MB、東京〜大阪(約4万点)の判定で最大約 850MB、
// 全都道府県を通る極端なログでも約 950MB だったので 1024MB にする(上限が近いと V8 がこまめに片付けるので、上限なしより使う量も減る)。
// 上限を超えたらその判定は失敗にし(サーバー本体は止まらない)、/health に出す
export const JUDGE_MAX_MB = Number(process.env.JUDGE_MAX_MB ?? 1024);
// 空きメモリ(MB)がこれより少ないときは、判定し終えたらすぐ worker を止めてメモリを返す
const JUDGE_LOW_FREE_MB = Number(process.env.JUDGE_LOW_FREE_MB ?? 1500);
// iPhone の走行ロガー(drive-logger-ios)が送る生データ(加速度など)の置き場所。
// RAW_LOG_DIR → data/rawlog_dir.txt の1行目(Google ドライブの _drivelog など)→ data/rawlogs の順に決める
const RAW_LOG_DIR = () => {
  if (process.env.RAW_LOG_DIR) return process.env.RAW_LOG_DIR;
  try {
    const line = readFileSync(join(dirname(RECORD), "rawlog_dir.txt"), "utf8").split(/\r?\n/)[0].trim();
    if (line) return line;
  } catch {}
  return join(dirname(RECORD), "rawlogs");
};

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};
const COMPRESSIBLE = new Set([".html", ".js", ".mjs", ".css", ".json", ".svg"]);

// --- 走行記録 ---

function loadRecord() {
  try {
    const j = JSON.parse(readFileSync(RECORD, "utf8"));
    return { coverage: j.coverage ?? {}, dates: j.dates ?? {}, logs: j.logs ?? [], declared: j.declared ?? {}, trips: j.trips ?? {} };
  } catch {
    return { coverage: {}, dates: {}, logs: [], declared: {}, trips: {} };
  }
}

function saveRecord(rec) {
  mkdirSync(join(RECORD, ".."), { recursive: true });
  // 書き込み途中で落ちても記録が壊れないよう、別名で書いてから置き換える
  writeFileSync(`${RECORD}.tmp`, JSON.stringify(rec));
  renameSync(`${RECORD}.tmp`, RECORD);
}

// --- 旅行(名前を付けた期間)。ログタブの「期間を指定」で保存し、どの端末からも選べるようにする ---
const JOURNEYS = () => join(dirname(RECORD), "journeys.json");
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export function loadJourneys() {
  try {
    const list = JSON.parse(readFileSync(JOURNEYS(), "utf8"));
    if (!Array.isArray(list)) return [];
    return list
      .filter((j) => j && typeof j.id === "string" && typeof j.name === "string" && DAY_RE.test(j.from) && DAY_RE.test(j.to))
      .map((j) => ({ ...j, exclude: cleanExclude(j.exclude) }));
  } catch {
    return [];
  }
}

/** 旅行から外したもの("log:<ログ ID>" か "trip:<走行 ID>")。おかしな値は捨てる */
const cleanExclude = (v) => (Array.isArray(v) ? [...new Set(v.filter((x) => typeof x === "string" && /^(log|trip):.{1,200}$/.test(x)))] : []);

/** 旅行から外すものを置き換える。旅行がなければ null */
export function setJourneyExclude(id, exclude) {
  const list = loadJourneys();
  const j = list.find((x) => x.id === id);
  if (!j) return null;
  j.exclude = cleanExclude(exclude);
  return saveJourneys(list);
}

function saveJourneys(list) {
  mkdirSync(dirname(JOURNEYS()), { recursive: true });
  // 新しい旅行(始まりが遅い方)が上
  list.sort((a, b) => b.from.localeCompare(a.from) || b.to.localeCompare(a.to));
  writeFileSync(`${JOURNEYS()}.tmp`, JSON.stringify(list, null, 1));
  renameSync(`${JOURNEYS()}.tmp`, JOURNEYS());
  return list;
}

/** 旅行を足す。同じ期間の旅行があれば名前を付け直す。おかしな値なら null */
export function addJourney(body) {
  const name = typeof body?.name === "string" ? body.name.trim().slice(0, 60) : "";
  let { from, to } = body ?? {};
  if (!name || !DAY_RE.test(from) || !DAY_RE.test(to)) return null;
  if (from > to) [from, to] = [to, from];
  const list = loadJourneys();
  const same = list.find((j) => j.from === from && j.to === to);
  if (same) same.name = name;
  else list.push({ id: `j${Date.now().toString(36)}`, name, from, to, exclude: [] });
  return saveJourneys(list);
}

// --- 車載動画(YouTube)とログのひも付け ---
// _drivelog の YouTubeDesc.bat(youtube_desc.py)が、1 本の動画に入っている録画の時刻と動画の中の位置を送る。
// 地図で YouTube の URL を貼ると、ログ詳細やリプレイからその場面を開ける
const VIDEOS = () => join(dirname(RECORD), "videos.json");
const VIDEO_ID_RE = /^[\w.-]{1,80}$/;

/** 録画の並び。おかしな値は捨て、始まりの早い順にする */
function cleanClips(v) {
  if (!Array.isArray(v)) return [];
  return v
    .map((c) => ({ start: Number(c?.start), dur: Number(c?.dur), offset: Number(c?.offset) }))
    .filter((c) => c.start > 1e9 && c.start < 1e10 && c.dur > 0 && c.dur < 86400 && c.offset >= 0 && c.offset < 86400 * 2)
    .sort((a, b) => a.start - b.start)
    .slice(0, 200);
}

export function loadVideos() {
  try {
    const list = JSON.parse(readFileSync(VIDEOS(), "utf8"));
    if (!Array.isArray(list)) return [];
    return list.filter((v) => v && VIDEO_ID_RE.test(v.id)).map((v) => ({ ...v, clips: cleanClips(v.clips) })).filter((v) => v.clips.length);
  } catch {
    return [];
  }
}

function saveVideos(list) {
  mkdirSync(dirname(VIDEOS()), { recursive: true });
  // 新しい動画が上
  list.sort((a, b) => b.clips[0].start - a.clips[0].start);
  writeFileSync(`${VIDEOS()}.tmp`, JSON.stringify(list, null, 1));
  renameSync(`${VIDEOS()}.tmp`, VIDEOS());
  return list;
}

/** YouTube の URL か動画 ID から ID(11 文字)を取り出す。分からなければ undefined */
export function youtubeId(text) {
  const s = String(text ?? "").trim();
  if (/^[\w-]{11}$/.test(s)) return s;
  let u;
  try {
    u = new URL(s);
  } catch {
    return undefined;
  }
  const host = u.hostname.replace(/^(www|m|music)\./, "");
  let id;
  if (host === "youtu.be") id = u.pathname.split("/")[1];
  else if (host === "youtube.com" || host === "youtube-nocookie.com")
    id = u.searchParams.get("v") ?? /^\/(?:shorts|live|embed)\/([^/?#]+)/.exec(u.pathname)?.[1];
  return id && /^[\w-]{11}$/.test(id) ? id : undefined;
}

/**
 * 動画を足す・作り直す({ id, clips, total?, url? })。同じ id があれば録画の並びを置き換え、
 * 貼ってある YouTube の URL は残す。おかしな値なら null
 */
export function upsertVideo(body) {
  const id = typeof body?.id === "string" ? body.id.trim() : "";
  const clips = cleanClips(body?.clips);
  if (!VIDEO_ID_RE.test(id) || !clips.length) return null;
  const list = loadVideos();
  let v = list.find((x) => x.id === id);
  if (!v) {
    v = { id, clips };
    list.push(v);
  }
  v.clips = clips;
  const total = Number(body.total);
  if (total > 0 && total < 86400 * 2) v.total = total;
  const yt = body.url ? youtubeId(body.url) : undefined;
  if (yt) v.youtube = yt;
  return saveVideos(list);
}

/** 動画に YouTube の URL を貼る(空なら外す)。動画が無ければ null、URL が読めなければ "bad" */
export function setVideoUrl(id, url) {
  const list = loadVideos();
  const v = list.find((x) => x.id === id);
  if (!v) return null;
  if (!String(url ?? "").trim()) delete v.youtube;
  else {
    const yt = youtubeId(url);
    if (!yt) return "bad";
    v.youtube = yt;
  }
  return saveVideos(list);
}

/** 置き換える前の記録を data/backup/record-<時刻>.json に残す(戻せるように) */
function backupRecord() {
  if (!existsSync(RECORD)) return;
  const dir = join(dirname(RECORD), "backup");
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  writeFileSync(join(dir, `record-${stamp}.json`), readFileSync(RECORD));
}

const isDates = (d) => Array.isArray(d) && d.length === 2 && d.every((x) => typeof x === "string");

/**
 * 区間ごとに割合は大きい方、通った日は初めての日が早い方・最後の日が遅い方を残す。
 * (src/store.ts の mergeRecord と同じ規則)
 */
/** 前に時刻を読み違えて 1970-01-01 などになった日付。記録には残さない(src/store.ts と同じ) */
export const isBogusDay = (d) => typeof d === "string" && d < "2000";

export function mergeRecord(base, add) {
  const coverage = { ...base.coverage };
  for (const [id, r] of Object.entries(add.coverage ?? {})) {
    if (typeof r === "number" && r > (coverage[id] ?? 0)) coverage[id] = Math.min(r, 1);
  }
  const dates = { ...base.dates };
  for (const [id, d] of Object.entries(add.dates ?? {})) {
    if (!isDates(d) || isBogusDay(d[0]) || isBogusDay(d[1])) continue;
    const cur = dates[id];
    dates[id] = cur && !isBogusDay(cur[0]) && !isBogusDay(cur[1]) ? [cur[0] < d[0] ? cur[0] : d[0], cur[1] > d[1] ? cur[1] : d[1]] : d;
  }
  // 点線国道の自己申告は、申告した時刻が新しい方を残す(取り消しもできるように)
  const declared = { ...(base.declared ?? {}) };
  for (const [ref, d] of Object.entries(add.declared ?? {})) {
    if (!d || typeof d.on !== "boolean" || typeof d.at !== "string") continue;
    if (!declared[ref] || d.at > declared[ref].at) declared[ref] = { on: d.on, at: d.at };
  }
  // ログごとの走行距離。同じログ(同じキー)は上書きする
  const trips = Object.fromEntries(Object.entries(base.trips ?? {}).filter(([, t]) => !isBogusDay(t?.date)));
  for (const [key, t] of Object.entries(add.trips ?? {})) {
    if (t && typeof t.date === "string" && !isBogusDay(t.date) && typeof t.m === "number" && t.m >= 0) trips[key] = { date: t.date, m: t.m };
  }
  return { coverage, dates, logs: [...base.logs, ...(add.logs ?? [])], declared, trips };
}

// --- 走行ログ ---

/** ファイル名に使えない文字を除く。id は「保存時刻-元の名前.gz」 */
const safeName = (name) => name.replace(/[^\p{L}\p{N}._-]+/gu, "_").slice(0, 120) || "log";

// 振り返りのログ一覧に出す日付と走行距離(ブラウザで読んだときに計算したもの)。ログ ID → { date, m }
const META = () => join(LOGS, "meta.json");

function loadMeta() {
  try {
    return JSON.parse(readFileSync(META(), "utf8"));
  } catch {
    return {};
  }
}

const isMeta = (m) => m && typeof m.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(m.date) && typeof m.m === "number" && m.m >= 0;

/** 走り始めた時刻(UNIX ミリ秒)として正しい値か */
const isStart = (v) => typeof v === "number" && Number.isFinite(v) && v > 0;

function setMeta(id, m) {
  const all = loadMeta();
  all[id] = { date: m.date, m: Math.round(m.m), ...(isStart(m.start) ? { start: m.start } : {}) };
  writeFileSync(`${META()}.tmp`, JSON.stringify(all));
  renameSync(`${META()}.tmp`, META());
}

const logName = (id) => id.replace(/^\d+-/, "").replace(/\.gz$/, "");
const logFiles = () => readdirSync(LOGS).filter((f) => f.endsWith(".gz")).sort();
const sameLog = (id, body) => {
  try {
    return gunzipSync(readFileSync(join(LOGS, id))).equals(body);
  } catch {
    return false;
  }
};

/** ログを保存して { id, added } を返す。added は新しく保存したとき true */
function saveLog(name, body, meta) {
  mkdirSync(LOGS, { recursive: true });
  // 同じ名前・同じ中身のログをもう一度読み込んだときは、新しく保存せず前のものを使う
  const same = logFiles().find((f) => logName(f) === safeName(name) && sameLog(f, body));
  if (same) {
    if (isMeta(meta)) setMeta(same, meta);
    return { id: same, added: false };
  }
  const id = `${Date.now()}-${safeName(name)}.gz`;
  writeFileSync(join(LOGS, id), gzipSync(body));
  if (isMeta(meta)) setMeta(id, meta);
  return { id, added: true };
}

// --- 自動で送られてきたログ(まだ判定していないもの) ---
// gbowl-log-formatter などのツールから POST /api/inbox で送られたログは、保存して pending.json に残し、
// このサーバーで判定して記録に足す。サーバーで判定する準備(npm run build)ができていなければ、
// 次に地図を開いたブラウザが判定する
const PENDING = () => join(LOGS, "pending.json");

function loadPending() {
  try {
    const ids = JSON.parse(readFileSync(PENDING(), "utf8"));
    return Array.isArray(ids) ? ids.filter((id) => typeof id === "string") : [];
  } catch {
    return [];
  }
}

function savePending(ids) {
  mkdirSync(LOGS, { recursive: true });
  writeFileSync(`${PENDING()}.tmp`, JSON.stringify(ids));
  renameSync(`${PENDING()}.tmp`, PENDING());
}

/** まだ判定していないログ(ファイルが残っているものだけ) */
function listPending() {
  const ids = new Set(loadPending());
  return listLogs().filter((l) => ids.has(l.id));
}

/** 判定する前に呼ぶ(サーバーとブラウザ、2台のブラウザで二重に判定しないように) */
function claimPending(id) {
  const ids = loadPending();
  if (!ids.includes(id)) return false;
  savePending(ids.filter((x) => x !== id));
  return true;
}

function listLogs() {
  if (!existsSync(LOGS)) return [];
  const meta = loadMeta();
  return logFiles().map((id) => {
    const score = loadEval(id)?.score;
    const wx = loadWeather(id)?.summary;
    return {
      id,
      name: logName(id),
      size: statSync(join(LOGS, id)).size,
      ...(isMeta(meta[id]) ? { date: meta[id].date, m: meta[id].m, ...(isStart(meta[id].start) ? { start: meta[id].start } : {}) } : {}),
      ...(typeof score === "number" ? { score } : {}),
      ...(wx ? { weather: { icon: wx.icon, label: wx.label, tMin: wx.tMin, tMax: wx.tMax } } : {}),
    };
  });
}

// --- 運転評価 ---
// iPhone の走行ロガーのログ(名前は「<走行ID>.gpx」)は、生データの走行フォルダに DriveLog(gbowl-log-formatter)が
// evaluation.json を作る。使い終わった走行フォルダは old に移すので、そちらも探す。
// GBowl の CSV など、それ以外のログは、まとめて評価したものを RAW_LOG_DIR/evals/<ログの名前から拡張子を除いたもの>.json に置く

const SESSION_RE = /^(\d{8}-\d{6})\.gpx$/i;

function evalPaths(id) {
  const name = logName(id);
  const dir = RAW_LOG_DIR();
  const m = SESSION_RE.exec(name);
  if (m) return [join(dir, m[1], "evaluation.json"), join(dir, "old", m[1], "evaluation.json")];
  return [join(dir, "evals", `${name.replace(/\.[^.]+$/, "")}.json`)];
}

/** ログの運転評価(evaluation.json の中身)。なければ null */
export function loadEval(id) {
  for (const path of evalPaths(id)) {
    try {
      const ev = JSON.parse(readFileSync(path, "utf8"));
      if (ev && typeof ev.score === "number" && Array.isArray(ev.items)) return ev;
    } catch {}
  }
  return null;
}

/**
 * 前に同じログを何度も読み込んで重複して保存されたものを、ログフォルダの duplicates に移す。
 * 同じ名前で中身も同じものは、いちばん古いものだけ残す。移したファイルの数を返す
 */
export function dedupeLogs() {
  if (!existsSync(LOGS)) return 0;
  const meta = loadMeta();
  const kept = new Map(); // 名前 → 残したログの id と中身
  const moved = [];
  for (const id of logFiles()) {
    const body = gunzipSync(readFileSync(join(LOGS, id)));
    const list = kept.get(logName(id)) ?? [];
    const same = list.find((k) => k.body.equals(body));
    if (!same) {
      kept.set(logName(id), [...list, { id, body }]);
      continue;
    }
    if (!isMeta(meta[same.id]) && isMeta(meta[id])) meta[same.id] = meta[id];
    delete meta[id];
    moved.push(id);
  }
  if (!moved.length) return 0;
  mkdirSync(join(LOGS, "duplicates"), { recursive: true });
  for (const id of moved) renameSync(join(LOGS, id), join(LOGS, "duplicates", id));
  writeFileSync(`${META()}.tmp`, JSON.stringify(meta));
  renameSync(`${META()}.tmp`, META());
  return moved.length;
}

// --- サーバーでの判定 ---
// 保存したログの判定し直しと、自動で送られてきたログの判定を MiniPC で行う(画面を閉じても続く)。
// 道路データを読むと重いので、HTTP を受けるのとは別のスレッド(worker)で判定し、記録の保存はこちらで行う

export const serverJudge = () => !!JUDGE_WORKER && existsSync(JUDGE_WORKER) && existsSync(join(JUDGE_DATA, "routes.json"));

let worker = null;
let workerReady = null;
let idleTimer = null;
let seq = 0;
const waiting = new Map(); // seq → { ok, ng }
/** 判定 worker のメモリの様子(/health に出す) */
const workerMem = { startedAt: null, heapMB: null, peakHeapMB: null, lastPeakHeapMB: null, oom: null };

const toMB = (b) => Math.round(b / 1048576);

/** worker のヒープの使用量を読む(判定中でも読める)。止まっている・読めないときは null */
async function readWorkerHeap(w = worker) {
  if (!w || typeof w.getHeapStatistics !== "function") return null;
  try {
    const h = await Promise.race([w.getHeapStatistics(), new Promise((ok) => setTimeout(ok, 1000, null).unref?.())]);
    if (!h) return null;
    const mb = toMB(h.used_heap_size);
    if (w === worker) {
      workerMem.heapMB = mb;
      workerMem.peakHeapMB = Math.max(workerMem.peakHeapMB ?? 0, mb);
    }
    return mb;
  } catch {
    return null;
  }
}

/** /health に出す判定 worker のメモリ */
export async function judgeMemory() {
  if (worker) await readWorkerHeap();
  return {
    running: !!worker,
    limitMB: JUDGE_MAX_MB > 0 ? JUDGE_MAX_MB : null,
    lowFreeMB: JUDGE_LOW_FREE_MB,
    startedAt: worker ? workerMem.startedAt : null,
    heapMB: worker ? workerMem.heapMB : null,
    peakHeapMB: worker ? workerMem.peakHeapMB : null,
    // 前に動いていた worker の最大(止めたあとも残す)
    lastPeakHeapMB: workerMem.lastPeakHeapMB,
    oom: workerMem.oom,
  };
}

/** 空きメモリ(MB)。Windows では「利用可能」の量 */
const freeMB = () => toMB(freemem());

/** 判定を待つ人がいなくなったら worker を止める。空きメモリが少なければすぐ止める */
function scheduleStop() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(stopWorker, freeMB() < JUDGE_LOW_FREE_MB ? 0 : JUDGE_IDLE_MS);
  idleTimer.unref?.();
}

function stopWorker() {
  const w = worker;
  worker = null;
  workerReady = null;
  if (w) {
    if (workerMem.peakHeapMB !== null) workerMem.lastPeakHeapMB = workerMem.peakHeapMB;
    void w.terminate();
  }
}

function startWorker() {
  const w = new Worker(JUDGE_WORKER, {
    workerData: { dataDir: JUDGE_DATA, logsDir: LOGS },
    ...(JUDGE_MAX_MB > 0 ? { resourceLimits: { maxOldGenerationSizeMb: JUDGE_MAX_MB } } : {}),
  });
  worker = w;
  workerMem.startedAt = new Date().toISOString();
  workerMem.heapMB = null;
  workerMem.peakHeapMB = null;
  workerReady = new Promise((ok, ng) => {
    w.on("message", (m) => {
      if (m?.ready) return ok();
      const p = waiting.get(m?.seq);
      if (!p) return;
      waiting.delete(m.seq);
      if (m.error) p.ng(new Error(m.error));
      else p.ok(m.result ?? m.fill);
    });
    const fail = (e) => {
      if (worker === w) {
        worker = null;
        workerReady = null;
      }
      ng(e);
      for (const p of waiting.values()) p.ng(e);
      waiting.clear();
    };
    w.on("error", (e) => {
      if (e?.code === "ERR_WORKER_OUT_OF_MEMORY") {
        workerMem.oom = { at: new Date().toISOString(), limitMB: JUDGE_MAX_MB, freeMB: freeMB() };
        if (workerMem.peakHeapMB !== null) workerMem.lastPeakHeapMB = workerMem.peakHeapMB;
        const msg = `判定の処理がメモリの上限(${JUDGE_MAX_MB}MB)を超えたので止めました`;
        console.error(msg);
        return fail(new Error(msg));
      }
      fail(e);
    });
    w.on("exit", (code) => fail(new Error(`判定の処理が止まりました(${code})`)));
  });
  // 待っている人がいないときに起きた失敗で、未処理の拒否にならないように
  workerReady.catch(() => undefined);
}

/** 判定し終えたら、そのときの worker のヒープを読んでおく(最大値を /health に出すため) */
async function afterJob(p) {
  const w = worker;
  try {
    return await p;
  } finally {
    await readWorkerHeap(w);
  }
}

/** 保存してあるログ 1 本を判定する */
async function judgeOne(id) {
  clearTimeout(idleTimer);
  if (!worker) startWorker();
  await workerReady;
  const n = ++seq;
  return afterJob(
    new Promise((ok, ng) => {
      waiting.set(n, { ok, ng });
      worker.postMessage({ seq: n, logId: id });
    }),
  );
}

/**
 * iPhone の走行ロガーの走行フォルダで、トンネルなどで GPS が途切れた区間を道路に沿って補う。
 * worker が location_filled.csv と tunnel_fill.json を書き、まとめを返す
 */
async function fillOne(dir) {
  clearTimeout(idleTimer);
  if (!worker) startWorker();
  await workerReady;
  const n = ++seq;
  return afterJob(
    new Promise((ok, ng) => {
      waiting.set(n, { ok, ng });
      worker.postMessage({ seq: n, fillDir: dir });
    }),
  );
}

/** GET /api/rawlog で返してよいファイル(サーバーが作るもの) */
const RAW_READABLE = new Set(["location_filled.csv", "tunnel_fill.json", "weather.json"]);

/** 走行ごとのフォルダ(車は RAW_LOG_DIR/<走行ID>、車以外は trips/<走行ID>) */
const rawDir = (session, kind) => (kind === "trip" ? join(RAW_LOG_DIR(), "trips", session) : join(RAW_LOG_DIR(), session));

/**
 * 電車の補い方の版(src/judgeWorker.ts の FILL_REV のうち、電車の補い方が変わった版)。
 * これより古い電車の記録は起動時に補い直す。rev 3 は車だけの変更なので 2 のまま
 */
const RAIL_FILL_REV = 2;

/** 線路のデータ(電車の記録を補うのに使う。scripts/build_railways.py で作り、リリース route-data に置く) */
const hasRails = () => existsSync(join(JUDGE_DATA, "railways.json.gz"));

/**
 * 自動で補う走行か。車(運転)と同乗(バス・タクシー)は道路に沿って、電車は線路に沿って補う(線路のデータがあるとき)。
 * 飛行機は補わない。meta.json の mode がない古い記録は、車のフォルダなら車とみなす
 */
export function shouldFill(kind, meta, rails = hasRails()) {
  const mode = meta?.mode ?? (kind === "trip" ? "other" : "car");
  return mode === "car" || mode === "ride" || (mode === "train" && rails);
}

/** 生データを受け取り終えたら(meta.json は最後に送られる)、トンネルなどで途切れた区間を補う */
function fillAfterUpload(dir, kind) {
  if (!serverJudge() || !existsSync(join(dir, "location.csv"))) return;
  let meta = null;
  try {
    meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8"));
  } catch {}
  if (!shouldFill(kind, meta)) return;
  void enqueue(() =>
    fillOne(dir).then(
      () => applyFillToLogs(dir, kind),
      (e) => console.error(`途切れた区間の補間に失敗: ${dir}: ${e.message}`),
    ),
  );
}

/**
 * 電車の記録で、まだ線路に沿って補っていないもの(線路のデータが入る前に届いたものなど)の走行フォルダ。
 * 補ったことがあっても、道路で補った結果(手動の POST で道路に沿わせたもの)や、補い方の版が古いものは補い直す
 */
export function trainsToFill(root = RAW_LOG_DIR()) {
  const base = join(root, "trips");
  if (!existsSync(base)) return [];
  const out = [];
  for (const e of readdirSync(base, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const dir = join(base, e.name);
    try {
      if (!existsSync(join(dir, "location.csv"))) continue;
      if (JSON.parse(readFileSync(join(dir, "meta.json"), "utf8")).mode !== "train") continue;
      const prev = existsSync(join(dir, "tunnel_fill.json")) ? JSON.parse(readFileSync(join(dir, "tunnel_fill.json"), "utf8")) : null;
      const done = prev?.source === "rail" && (prev.rev ?? 1) >= RAIL_FILL_REV;
      if (!done) out.push(dir);
    } catch {}
  }
  return out;
}

// --- 移動手段を直す ---
// iPhone のロガーで移動手段を間違えて記録したとき(電車を車で記録したなど)に、あとから直す。
// 走行フォルダの meta.json の mode を書き換え、車と車以外でフォルダ(RAW_LOG_DIR/<ID> と trips/<ID>)を移す。
// 車にしたら国道の判定に足し(GPX がなければ location.csv から作る)、車でなくしたら判定から外して判定し直す。
// 外したログは消さずにログフォルダの removed に移す(車に戻したら使う)

export const TRAVEL_MODES = ["car", "ride", "train", "plane", "other"];
const SESSION_ID_RE = /^\d{8}-\d{6}$/;

/** 走行フォルダを探す(車・old・trips の順)。なければ null */
export function findSession(session, root = RAW_LOG_DIR()) {
  for (const [dir, kind] of [
    [join(root, session), "drive"],
    [join(root, "old", session), "drive"],
    [join(root, "trips", session), "trip"],
  ]) {
    if (existsSync(dir) && statSync(dir).isDirectory()) return { dir, kind };
  }
  return null;
}

/** 走行フォルダの meta.json(なければ null) */
function readSessionMeta(dir) {
  try {
    return JSON.parse(readFileSync(join(dir, "meta.json"), "utf8"));
  } catch {
    return null;
  }
}

/** 走行の移動手段。meta.json の mode がない古い記録は、車のフォルダなら車、trips ならその他 */
const modeOfSession = (s) => readSessionMeta(s.dir)?.mode ?? (s.kind === "trip" ? "other" : "car");

/** フォルダを移す。移す先がすでにあれば(途中まで両方に送られたときなど)、ファイルを1つずつ移して上書きする */
function moveDir(from, to) {
  mkdirSync(dirname(to), { recursive: true });
  if (!existsSync(to)) return renameSync(from, to);
  for (const f of readdirSync(from)) {
    const dest = join(to, f);
    if (existsSync(dest) && statSync(dest).isDirectory()) continue;
    renameSync(join(from, f), dest);
  }
  try {
    rmdirSync(from);
  } catch {}
}

/** location.csv(iPhone のロガー)から、アプリが地図に送るのと同じ GPX を作る(精度 50m 以内の点だけ) */
export function gpxFromLocationCsv(text, name) {
  const lines = text.split(/\r?\n/);
  const head = lines[0].split(",");
  const col = (n) => head.indexOf(n);
  const [ti, la, lo, al, acc, sp] = ["unix_s", "lat", "lon", "alt_m", "h_acc_m", "speed_ms"].map(col);
  const pts = [];
  for (const line of lines.slice(1)) {
    const c = line.split(",");
    const t = Number(c[ti]);
    const lat = Number(c[la]);
    const lon = Number(c[lo]);
    if (!line || !Number.isFinite(t) || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    if (acc >= 0 && c[acc] !== "" && Number(c[acc]) > 50) continue;
    let s = `<trkpt lat="${lat.toFixed(7)}" lon="${lon.toFixed(7)}">`;
    if (al >= 0 && c[al] !== "" && Number.isFinite(Number(c[al]))) s += `<ele>${Number(c[al]).toFixed(1)}</ele>`;
    s += `<time>${new Date(Math.round(t * 1000)).toISOString()}</time>`;
    if (sp >= 0 && c[sp] !== "" && Number(c[sp]) >= 0) s += `<extensions><speed>${Number(c[sp]).toFixed(2)}</speed></extensions>`;
    pts.push(`${s}</trkpt>`);
  }
  return {
    points: pts.length,
    gpx: `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="DriveLogger" xmlns="http://www.topografix.com/GPX/1/1">\n<trk><name>${name}</name><trkseg>\n${pts.join("\n")}\n</trkseg></trk>\n</gpx>\n`,
  };
}

/**
 * 車のログ(GPX)に、トンネルなどで途切れた区間を補った点(location_filled.csv の src=road / line)を入れる。
 * 補った区間(sections の fromS〜toS)の中にあった GPX の点(復帰直後の精度の悪い点など)は捨てる。
 * 補った区間がない、または GPX の点に時刻のないものがあるときは null(変えない)
 */
export function gpxWithFill(gpx, filledCsv, sections) {
  if (!Array.isArray(sections) || sections.length === 0) return null;
  const inside = (t) => sections.some((s) => t > s.fromS + 1e-3 && t < s.toS - 1e-3);
  const pts = [];
  for (const m of gpx.matchAll(/<trkpt\b[\s\S]*?<\/trkpt>/g)) {
    const time = /<time>([^<]+)<\/time>/.exec(m[0])?.[1];
    const t = time ? Date.parse(time) / 1000 : NaN;
    if (!Number.isFinite(t)) return null;
    if (!inside(t)) pts.push({ t, s: m[0] });
  }
  const lines = filledCsv.split(/\r?\n/);
  const head = lines[0].split(",");
  const [ti, la, lo, al, est, src] = ["unix_s", "lat", "lon", "alt_m", "speed_est_ms", "src"].map((n) => head.indexOf(n));
  if (ti < 0 || la < 0 || lo < 0 || src < 0) return null;
  let added = 0;
  for (const line of lines.slice(1)) {
    const c = line.split(",");
    if (c[src] !== "road" && c[src] !== "line") continue;
    const t = Number(c[ti]), lat = Number(c[la]), lon = Number(c[lo]);
    if (!Number.isFinite(t) || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    let p = `<trkpt lat="${lat.toFixed(7)}" lon="${lon.toFixed(7)}">`;
    if (al >= 0 && c[al] !== "" && Number.isFinite(Number(c[al]))) p += `<ele>${Number(c[al]).toFixed(1)}</ele>`;
    p += `<time>${new Date(Math.round(t * 1000)).toISOString()}</time>`;
    if (est >= 0 && c[est] !== "" && Number(c[est]) >= 0) p += `<extensions><speed>${Number(c[est]).toFixed(2)}</speed></extensions>`;
    pts.push({ t, s: `${p}</trkpt>` });
    added++;
  }
  const a = gpx.indexOf("<trkseg>");
  const b = gpx.lastIndexOf("</trkseg>");
  if (added === 0 || a < 0 || b < a) return null;
  pts.sort((x, y) => x.t - y.t);
  return `${gpx.slice(0, a)}<trkseg>\n${pts.map((p) => p.s).join("\n")}\n${gpx.slice(b)}`;
}

/** 補う前の車のログ(補い直すときはこちらから作る) */
const UNFILLED = () => join(LOGS, "unfilled");

/**
 * 車の走行を補ったあと、地図のログ(<走行ID>.gpx)にも補った点を入れて、判定し直す(通った区間を足す)。
 * 元のログはログフォルダの unfilled に残し、補い直すときはそこから作る。補った区間がなくなったら元に戻す
 */
function applyFillToLogs(dir, kind) {
  if (kind !== "drive") return;
  const session = basename(dir);
  let summary = null;
  let filled = "";
  try {
    summary = JSON.parse(readFileSync(join(dir, "tunnel_fill.json"), "utf8"));
    filled = readFileSync(join(dir, "location_filled.csv"), "utf8");
  } catch {
    return;
  }
  const sections = (summary?.sections ?? []).filter((s) => s.points > 0);
  for (const id of sessionLogs(session)) {
    const path = join(LOGS, id);
    const orig = join(UNFILLED(), id);
    const base = existsSync(orig) ? readFileSync(orig) : readFileSync(path);
    const next = gpxWithFill(gunzipSync(base).toString("utf8"), filled, sections);
    const body = next === null ? gunzipSync(base) : Buffer.from(next);
    if (gunzipSync(readFileSync(path)).equals(body)) continue;
    if (!existsSync(orig)) {
      mkdirSync(UNFILLED(), { recursive: true });
      writeFileSync(orig, base);
    }
    writeFileSync(`${path}.part`, gzipSync(body));
    renameSync(`${path}.part`, path);
    judge.rev++;
    if (serverJudge() && !loadPending().includes(id)) void enqueue(() => rejudgeLog(id));
  }
}

/** 補った区間があるのに、地図のログがまだ補う前のまま(unfilled に元がない)車の走行フォルダ */
export function carsToApplyFill(root = RAW_LOG_DIR()) {
  if (!existsSync(root)) return [];
  const out = [];
  for (const e of readdirSync(root, { withFileTypes: true })) {
    if (!e.isDirectory() || !SESSION_ID_RE.test(e.name)) continue;
    const dir = join(root, e.name);
    try {
      const sum = JSON.parse(readFileSync(join(dir, "tunnel_fill.json"), "utf8"));
      if (!(sum.sections ?? []).some((x) => x.points > 0)) continue;
      if (sessionLogs(e.name).some((id) => !existsSync(join(UNFILLED(), id)))) out.push(dir);
    } catch {}
  }
  return out;
}

/** テスト用 */
export const applyFillToLogsForTest = applyFillToLogs;

/** 1本のログを判定し直して、通った区間・走行距離を記録に足す(ログの一覧には足さない) */
async function rejudgeLog(id) {
  try {
    const r = await judgeOne(id);
    saveRecord(mergeRecord(loadRecord(), toAdded(r, false)));
    updateMeta(id, r.trip);
    judge.rev++;
  } catch (e) {
    console.error(`補ったログの判定に失敗: ${id}: ${e.message}`);
  }
}

/** 走行 ID のログ(地図に保存した「<走行ID>.gpx」)。dir を渡すとそのフォルダから探す */
const sessionLogs = (session, dir = LOGS) => {
  try {
    return readdirSync(dir).filter((f) => f.endsWith(".gz") && logName(f) === `${session}.gpx`).sort();
  } catch {
    return [];
  }
};

/** ログの最初の点の時刻から、記録の trips(ログごとの走行距離)の名前を出す(src/trips.ts の tripKey と同じ) */
function tripKeyOfLog(path) {
  try {
    const t = /<time>([^<]+)<\/time>/.exec(gunzipSync(readFileSync(path)).toString("utf8"))?.[1];
    const ms = t ? Date.parse(t) : NaN;
    return Number.isFinite(ms) ? `t${ms}` : null;
  } catch {
    return null;
  }
}

/** 旅行から外したもの("log:<ID>" / "trip:<走行ID>")を、移動手段を変えたあとの名前に付け替える */
function renameJourneyKeys(from, to) {
  const list = loadJourneys();
  let changed = false;
  for (const j of list) {
    if (!j.exclude?.includes(from)) continue;
    j.exclude = [...new Set(j.exclude.map((x) => (x === from ? to : x)))];
    changed = true;
  }
  if (changed) saveJourneys(list);
}

/**
 * 走行の移動手段を変える。走行フォルダも地図のログもなければ null。
 * 返す値: { session, mode, from, kind, moved, gpx(地図に車のログがあるか), removed(判定から外したログの数), rejudge }
 * rejudge は判定し直しが要るとき "server"(MiniPC で始めた)か "browser"(画面で判定し直してもらう)
 */
export function changeMode(session, mode) {
  if (!SESSION_ID_RE.test(session) || !TRAVEL_MODES.includes(mode)) throw new Error("bad session or mode");
  const root = RAW_LOG_DIR();
  let cur = findSession(session, root);
  const logs = sessionLogs(session);
  if (!cur && !logs.length) return null;
  const from = cur ? modeOfSession(cur) : "car";
  const kind = mode === "car" ? "drive" : "trip";
  const out = { session, mode, from, kind, moved: false, gpx: logs.length > 0, removed: 0, rejudge: null };

  if (cur) {
    const meta = readSessionMeta(cur.dir);
    if (meta && meta.mode !== mode) {
      meta.mode = mode;
      writeFileSync(join(cur.dir, "meta.json.part"), JSON.stringify(meta, null, 2));
      renameSync(join(cur.dir, "meta.json.part"), join(cur.dir, "meta.json"));
    }
    if (cur.kind !== kind) {
      const to = kind === "trip" ? join(root, "trips", session) : join(root, session);
      moveDir(cur.dir, to);
      cur = { dir: to, kind };
      out.moved = true;
    }
    // トンネルなどを補った位置は、新しい手段で補い直す(道路と線路で補い方が違う。飛行機などは補わない)
    if (meta && from !== mode) {
      for (const f of ["location_filled.csv", "tunnel_fill.json"]) rmSync(join(cur.dir, f), { force: true });
      fillAfterUpload(cur.dir, cur.kind);
      if (!existsSync(join(cur.dir, "weather.json"))) weatherAfterUpload(cur.dir);
    }
  }

  if (mode !== "car" && logs.length) {
    // 国道の判定から外す。走行距離(trips)は判定し直しでも消えないので、ここで消す
    out.removed = removeSessionLogs(session, `trip:${session}`);
    out.gpx = false;
    out.rejudge = startRejudge() ? "server" : "browser";
  } else if (mode === "car" && !logs.length) {
    // 前に外したログがあれば戻す。なければ location.csv から GPX を作って保存する
    const back = sessionLogs(session, join(LOGS, "removed")).at(-1);
    let id = null;
    if (back) {
      mkdirSync(LOGS, { recursive: true });
      renameSync(join(LOGS, "removed", back), join(LOGS, back));
      id = back;
    } else if (cur && existsSync(join(cur.dir, "location.csv"))) {
      const { gpx, points } = gpxFromLocationCsv(readFileSync(join(cur.dir, "location.csv"), "utf8"), session);
      if (points > 0) id = saveLog(`${session}.gpx`, Buffer.from(gpx), null).id;
    }
    if (id) {
      renameJourneyKeys(`trip:${session}`, `log:${id}`);
      savePending([...loadPending().filter((x) => x !== id), id]);
      if (serverJudge()) void enqueue(judgePending);
      judge.rev++;
      out.gpx = true;
    }
  }
  return out;
}

/**
 * 地図のログ(<走行ID>.gpx)を国道の判定から外す(ログフォルダの into に移し、走行距離も消す)。外した数を返す。
 * removed に移したものは車に戻したときに使う。replaced(ログを分けたときの元のログ)は使わない
 */
function removeSessionLogs(session, journeyKey, into = "removed") {
  const logs = sessionLogs(session);
  if (!logs.length) return 0;
  const removedDir = join(LOGS, into);
  mkdirSync(removedDir, { recursive: true });
  const keys = logs.map((id) => tripKeyOfLog(join(LOGS, id))).filter(Boolean);
  for (const id of logs) {
    renameSync(join(LOGS, id), join(removedDir, id));
    if (journeyKey) renameJourneyKeys(`log:${id}`, journeyKey);
  }
  savePending(loadPending().filter((id) => !logs.includes(id)));
  const rec = loadRecord();
  if (keys.some((k) => rec.trips[k])) {
    backupRecord();
    for (const k of keys) delete rec.trips[k];
    saveRecord(rec);
  }
  judge.rev++;
  return logs.length;
}

/**
 * 走行をいったん忘れる(アプリでログを分けたときに、前半を送り直す前に呼ぶ)。
 * 走行フォルダは消さずに RAW_LOG_DIR/replaced/<走行ID>_<時刻> に移し、地図のログは判定から外して判定し直す。
 * 走行フォルダも地図のログもなければ null
 */
export function forgetSession(session) {
  if (!SESSION_ID_RE.test(session)) throw new Error("bad session");
  const root = RAW_LOG_DIR();
  const cur = findSession(session, root);
  if (!cur && !sessionLogs(session).length) return null;
  let moved = null;
  if (cur) {
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*$/, "");
    moved = join(root, "replaced", `${session}_${stamp}`);
    moveDir(cur.dir, moved);
    saveWeatherPending(loadWeatherPending().filter((p) => p.dir !== cur.dir));
  }
  const removed = removeSessionLogs(session, null, "replaced");
  return { session, moved: !!moved, removed, rejudge: removed ? (startRejudge() ? "server" : "browser") : null };
}

/** 保存したログの判定し直しを MiniPC で始める。始められなければ false */
function startRejudge() {
  if (!serverJudge()) return false;
  if (!judge.rejudgeQueued && judge.running?.kind !== "rejudge") {
    judge.rejudgeQueued = true;
    void enqueue(rejudgeAll);
  }
  return true;
}

// --- 天気 ---
// 走り終えて生データ(meta.json は最後)が届いたら、走った時刻・場所の天気を Open-Meteo から取って
// 走行フォルダの weather.json に書く。つながらなかった走行は data/weather_pending.json に残し、あとで取り直す。
// iPhone のロガー以外のログ(GBowl・GoPro など)は、地図でログを開いたときにブラウザが軌跡の点を送り、
// RAW_LOG_DIR/weather/<ログの名前から拡張子を除いたもの>.json に残す。WEATHER=off で取らない

const weatherOn = () => process.env.WEATHER !== "off";
const WEATHER_PENDING = () => join(dirname(RECORD), "weather_pending.json");
/** 取れなかった走行を取り直す間隔と、あきらめるまでの日数 */
const WEATHER_RETRY_MS = Number(process.env.WEATHER_RETRY_MS ?? 30 * 60_000);
const WEATHER_GIVE_UP_DAYS = 14;

/** 天気を取る走行か。飛行機は地上の天気が意味をなさないので取らない */
export const shouldWeather = (meta) => meta?.mode !== "plane";

function loadWeatherPending() {
  try {
    const j = JSON.parse(readFileSync(WEATHER_PENDING(), "utf8"));
    return Array.isArray(j) ? j.filter((p) => p && typeof p.dir === "string") : [];
  } catch {
    return [];
  }
}

function saveWeatherPending(list) {
  mkdirSync(dirname(WEATHER_PENDING()), { recursive: true });
  writeFileSync(`${WEATHER_PENDING()}.tmp`, JSON.stringify(list, null, 1));
  renameSync(`${WEATHER_PENDING()}.tmp`, WEATHER_PENDING());
}

let weatherQueue = Promise.resolve();
const weatherEnqueue = (fn) => (weatherQueue = weatherQueue.then(fn).catch((e) => console.error(e)));
/** 天気を取り終えるまで待つ(テスト用) */
export const weatherIdle = () => weatherQueue;

/** 位置のファイルを読む(トンネルを補ったものがあればそちら) */
function readTrackPoints(dir) {
  for (const f of ["location_filled.csv", "location.csv"]) {
    const path = join(dir, f);
    if (existsSync(path)) return parseLocationCsv(readFileSync(path, "utf8"));
  }
  return [];
}

/** 走行フォルダの天気を取って weather.json に書く。取れなければ例外 */
async function weatherForDir(dir) {
  const w = await fetchWeather(readTrackPoints(dir));
  writeFileSync(join(dir, "weather.json.part"), JSON.stringify(w, null, 1));
  renameSync(join(dir, "weather.json.part"), join(dir, "weather.json"));
  return w;
}

/** 走行フォルダの天気を取る。失敗したら取り直す一覧に残す */
function weatherLater(dir) {
  if (!weatherOn()) return;
  void weatherEnqueue(async () => {
    try {
      await weatherForDir(dir);
      const rest = loadWeatherPending().filter((p) => p.dir !== dir);
      if (rest.length !== loadWeatherPending().length) saveWeatherPending(rest);
    } catch (e) {
      console.error(`天気を取れませんでした: ${dir}: ${e.message}`);
      const list = loadWeatherPending();
      const cur = list.find((p) => p.dir === dir);
      if (cur) cur.error = e.message;
      else list.push({ dir, since: new Date().toISOString(), error: e.message });
      saveWeatherPending(list);
    }
  });
}

/** 生データを受け取り終えたら、天気を取る */
function weatherAfterUpload(dir) {
  if (!existsSync(join(dir, "location.csv"))) return;
  let meta = null;
  try {
    meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8"));
  } catch {}
  if (shouldWeather(meta)) weatherLater(dir);
}

/** 取れなかった走行を取り直す(古すぎるものはあきらめる) */
export function retryWeather() {
  const list = loadWeatherPending();
  const keep = list.filter((p) => Date.now() - Date.parse(p.since) < WEATHER_GIVE_UP_DAYS * 86400_000 && existsSync(p.dir));
  if (keep.length !== list.length) saveWeatherPending(keep);
  for (const p of keep) if (!existsSync(join(p.dir, "weather.json"))) weatherLater(p.dir);
  return keep.length;
}

/** 前からある走行フォルダ(車・old・trips)で、まだ天気のないものを探す */
export function weatherMissingDirs() {
  const root = RAW_LOG_DIR();
  const out = [];
  for (const base of [root, join(root, "old"), join(root, "trips")]) {
    let names = [];
    try {
      names = readdirSync(base).filter((n) => /^\d{8}-\d{6}$/.test(n));
    } catch {
      continue;
    }
    for (const n of names) {
      const dir = join(base, n);
      if (!existsSync(join(dir, "location.csv")) || existsSync(join(dir, "weather.json"))) continue;
      let meta = null;
      try {
        meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8"));
      } catch {
        continue; // まだ送り終えていない
      }
      if (shouldWeather(meta)) out.push(dir);
    }
  }
  return out;
}

/** ログ(地図に保存したもの)の天気の置き場所。iPhone のロガーのログは走行フォルダ、それ以外は weather フォルダ */
function weatherPaths(id) {
  const name = logName(id);
  const dir = RAW_LOG_DIR();
  const m = SESSION_RE.exec(name);
  const own = join(dir, "weather", `${name.replace(/\.[^.]+$/, "")}.json`);
  if (m) return [join(dir, m[1], "weather.json"), join(dir, "old", m[1], "weather.json"), own];
  return [own];
}

/** 旅の記録の詳細で返す位置の数の上限(多ければ間引く) */
const TRIP_TRACK_MAX = 20000;

/**
 * 旅の記録(trips/<走行ID>)の詳細。track は [UNIX 秒, 緯度, 経度, 高度 m, 速さ m/s] の並び(補った位置があればそちら)。
 * 高度・速さは記録がなければ null(速さは GPS の値、なければ補ったときの推定の値)。
 * 運転評価(同乗のとき)と天気は、なければ null。走行がなければ null
 */
export function tripDetail(session) {
  const dir = join(RAW_LOG_DIR(), "trips", session);
  if (!existsSync(dir)) return null;
  const pts = readTrackPoints(dir);
  const step = Math.max(1, Math.ceil(pts.length / TRIP_TRACK_MAX));
  const track = pts.filter((_, i) => i % step === 0 || i === pts.length - 1).map((p) => [p.t, p.lat, p.lon, p.alt === null ? null : Math.round(p.alt * 10) / 10, p.sp === null ? null : Math.round(p.sp * 100) / 100]);
  let weather = null;
  try {
    const w = JSON.parse(readFileSync(join(dir, "weather.json"), "utf8"));
    if (w && w.summary && Array.isArray(w.samples)) weather = w;
  } catch {}
  const weatherError = weather ? undefined : loadWeatherPending().find((p) => p.dir === dir)?.error;
  return { track, eval: loadTripEval(dir), weather, ...(weatherError ? { weatherError } : {}) };
}

/** ログの天気(weather.json の中身)。なければ null */
export function loadWeather(id) {
  for (const path of weatherPaths(id)) {
    try {
      const w = JSON.parse(readFileSync(path, "utf8"));
      if (w && w.summary && Array.isArray(w.samples)) return w;
    } catch {}
  }
  return null;
}

/** ブラウザが送ってきた軌跡の点([UNIX秒, 緯度, 経度] の並び)で天気を取って残す */
async function weatherForLog(id, points) {
  const w = await fetchWeather(points);
  const path = weatherPaths(id).at(-1);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.part`, JSON.stringify(w, null, 1));
  renameSync(`${path}.part`, path);
  return w;
}

/** 判定した結果を、記録に足す形にする。logEntry なら読み込み履歴にも足す */
const toAdded = (r, logEntry) => ({
  coverage: r.coverage,
  dates: r.dates,
  logs: logEntry ? [{ name: r.name, importedAt: new Date().toISOString(), points: r.points }] : [],
  declared: {},
  trips: { [r.tripKey]: r.trip },
});

function updateMeta(id, trip) {
  const cur = loadMeta()[id];
  if (!isMeta(cur) || cur.date !== trip.date || cur.m !== trip.m || (isStart(trip.start) && cur.start !== trip.start)) setMeta(id, trip);
}

/** 画面に出す判定の様子。rev は判定で記録が変わるたびに増やす(ブラウザが読み直すため) */
const judge = { rev: 0, running: null, last: null, rejudgeQueued: false };
let queue = Promise.resolve();

function enqueue(fn) {
  queue = queue
    .then(fn)
    .catch((e) => console.error(e))
    .finally(() => {
      if (judge.running || waiting.size) return;
      scheduleStop();
    });
  return queue;
}

/** 判定が終わるまで待つ(テスト用) */
export const judgeIdle = () => queue;

/** 保存してあるログをすべて判定し直し、通った区間の記録を作り直す */
async function rejudgeAll() {
  judge.rejudgeQueued = false;
  const run = { kind: "rejudge", done: 0, total: 0, failed: [], passed: 0, startedAt: new Date().toISOString() };
  judge.running = run;
  let acc = { coverage: {}, dates: {}, logs: [], declared: {}, trips: {} };
  const seen = new Set();
  const passed = new Set();
  try {
    // 判定している間に保存されたログも判定する
    for (;;) {
      const todo = listLogs().filter((l) => !seen.has(l.id));
      if (todo.length === 0) break;
      run.total = seen.size + todo.length;
      for (const l of todo) {
        seen.add(l.id);
        run.current = l.name;
        try {
          const r = await judgeOne(l.id);
          acc = mergeRecord(acc, toAdded(r, false));
          for (const id of Object.keys(r.coverage)) passed.add(id);
          updateMeta(l.id, r.trip);
        } catch (e) {
          run.failed.push(`${l.name}: ${e.message}`);
        }
        run.done++;
        run.passed = passed.size;
      }
    }
    delete run.current;
    // 読めなかったログがあると、その分の記録が消えてしまうので、置き換えずに足すだけにする
    if (run.failed.length === 0 && run.total > 0) {
      backupRecord();
      const cur = loadRecord();
      saveRecord(mergeRecord({ ...cur, coverage: {}, dates: {} }, acc));
      run.replaced = true;
    } else {
      saveRecord(mergeRecord(loadRecord(), acc));
      run.replaced = false;
    }
    judge.rev++;
  } finally {
    run.finishedAt = new Date().toISOString();
    judge.running = null;
    judge.last = run;
  }
}

/** 自動で送られてきて、まだ判定していないログを判定して記録に足す */
async function judgePending() {
  const ids = loadPending();
  if (ids.length === 0) return;
  const run = { kind: "inbox", done: 0, total: ids.length, failed: [], passed: 0, startedAt: new Date().toISOString() };
  judge.running = run;
  const passed = new Set();
  try {
    for (const id of ids) {
      // ブラウザ(古い版の画面)が先に判定していれば飛ばす
      if (!claimPending(id)) {
        run.total--;
        continue;
      }
      run.current = logName(id);
      try {
        const r = await judgeOne(id);
        saveRecord(mergeRecord(loadRecord(), toAdded(r, true)));
        updateMeta(id, r.trip);
        for (const s of Object.keys(r.coverage)) passed.add(s);
        judge.rev++;
      } catch (e) {
        // 判定できなかったログも保存はしてあるので、「保存したログで判定し直す」で読み直せる
        run.failed.push(`${logName(id)}: ${e.message}`);
      }
      run.done++;
      run.passed = passed.size;
    }
    delete run.current;
  } finally {
    run.finishedAt = new Date().toISOString();
    judge.running = null;
    if (run.total > 0) judge.last = run;
  }
}

const judgeStatus = () => ({
  enabled: serverJudge(),
  rev: judge.rev,
  running: judge.running,
  last: judge.last,
  pending: loadPending().length,
  rejudgeQueued: judge.rejudgeQueued,
});

// --- 配信 ---

const gzCache = new Map();

function sendFile(req, res, path) {
  const ext = extname(path);
  const st = statSync(path);
  // 国道データ(数十MB)を開くたびに送り直さないよう、変わっていなければ 304 を返す。
  // ブラウザには毎回確かめさせる(no-cache)ので、update.bat でデータを入れ替えればすぐ新しいものになる
  const etag = `"${st.size.toString(36)}-${Math.floor(st.mtimeMs).toString(36)}"`;
  const headers = { "Content-Type": TYPES[ext] ?? "application/octet-stream", ETag: etag, "Cache-Control": "no-cache" };
  if (req.headers["if-none-match"] === etag) {
    res.writeHead(304, headers);
    return res.end();
  }
  // 国道データ(約50MB)は gzip で送ると1/6になる。一度圧縮したら使い回す
  if (COMPRESSIBLE.has(ext) && /\bgzip\b/.test(req.headers["accept-encoding"] ?? "")) {
    const mtime = st.mtimeMs;
    let hit = gzCache.get(path);
    if (!hit || hit.mtime !== mtime) gzCache.set(path, (hit = { mtime, body: gzipSync(readFileSync(path)) }));
    res.writeHead(200, { ...headers, "Content-Encoding": "gzip", Vary: "Accept-Encoding" });
    return res.end(hit.body);
  }
  res.writeHead(200, headers);
  res.end(readFileSync(path));
}

function readChunks(req) {
  return new Promise((ok, ng) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => ok(chunks));
    req.on("error", ng);
  });
}

const readBody = async (req) => Buffer.concat(await readChunks(req)).toString("utf8");

function json(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

// ---- ナビのコース(data/navi-courses.json) ----
const COURSES = join(dirname(RECORD), "navi-courses.json");
const NAVI_MODES = ["kokudo", "pref", "free"];

export function loadCourses() {
  try {
    const list = JSON.parse(readFileSync(COURSES, "utf8"));
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function writeCourses(list) {
  mkdirSync(dirname(COURSES), { recursive: true });
  writeFileSync(COURSES, JSON.stringify(list, null, 1));
}

/** 同じ名前があれば置き換える。新しく保存したものが先頭 */
export function saveCourse(body) {
  const name = String(body?.name ?? "").trim().slice(0, 60);
  const pts = (v) =>
    Array.isArray(v)
      ? v
          .map((p) => ({ lon: Number(p?.lon), lat: Number(p?.lat) }))
          .filter((p) => Number.isFinite(p.lon) && Number.isFinite(p.lat) && Math.abs(p.lat) <= 90 && Math.abs(p.lon) <= 180)
      : [];
  const points = pts(body?.points);
  if (!name || points.length < 2 || points.length > 200) return null;
  const mode = NAVI_MODES.includes(body?.mode) ? body.mode : "kokudo";
  // Google が道筋から外れた所に足した経由地
  const extra = pts(body?.extra).slice(0, 100);
  const list = loadCourses().filter((c) => c.name !== name);
  list.unshift({ name, points, mode, extra, savedAt: new Date().toISOString() });
  writeCourses(list);
  return list;
}

export function deleteCourse(name) {
  const list = loadCourses().filter((c) => c.name !== name);
  writeCourses(list);
  return list;
}

export function createApp() {
  const gmaps = createGmaps(dirname(RECORD));
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      // Google マップの背景(キーは data/google-maps.json。server/gmaps.mjs)
      if (url.pathname === "/api/gmaps/status") return json(res, 200, gmaps.status());
      // ナビのリンクを Google(Routes API)で確かめる
      if (url.pathname === "/api/gmaps/route") {
        if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
        let body;
        try {
          body = JSON.parse(await readBody(req));
        } catch {
          return json(res, 400, { error: "bad json" });
        }
        const [code, out] = await gmaps.route(body);
        return json(res, code, out);
      }
      // ナビのコース(名前を付けて保存した点の並び)
      if (url.pathname === "/api/navi/courses") {
        if (req.method === "GET") return json(res, 200, loadCourses());
        if (req.method === "POST") {
          const list = saveCourse(JSON.parse(await readBody(req)));
          return list ? json(res, 200, list) : json(res, 400, { error: "名前と2つ以上の点を入れてください" });
        }
        if (req.method === "DELETE") return json(res, 200, deleteCourse(url.searchParams.get("name") ?? ""));
        return json(res, 405, { error: "method not allowed" });
      }
      // 保守用の状態まとめ(server/health.mjs)
      if (url.pathname === "/api/health" || url.pathname === "/health") {
        const h = collectHealth({
          root: ROOT,
          rawLogDir: RAW_LOG_DIR(),
          judge: judgeStatus,
          judgeMemory: await judgeMemory(),
          weatherPending: loadWeatherPending,
          gmaps: gmaps.status,
          logs: listLogs,
        });
        if (url.pathname === "/api/health") return json(res, 200, h);
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
        return res.end(renderHealthHtml(h));
      }
      const gTile = /^\/api\/gmaps\/tile\/(\w+)\/(\d+)\/(\d+)\/(\d+)$/.exec(url.pathname);
      if (gTile) return await gmaps.tile(req, res, gTile[1], gTile[2], gTile[3], gTile[4]);
      const gView = /^\/api\/gmaps\/viewport\/(\w+)$/.exec(url.pathname);
      if (gView) return json(res, 200, await gmaps.viewport(gView[1], url.searchParams));

      if (url.pathname === "/api/record") {
        if (req.method === "GET") return json(res, 200, loadRecord());
        if (req.method === "POST") {
          const merged = mergeRecord(loadRecord(), JSON.parse(await readBody(req)));
          saveRecord(merged);
          return json(res, 200, merged);
        }
        // 保存したログで判定し直した結果で、通った区間(coverage・dates)を置き換える。
        // 判定の誤り(交差した道路を走ったことにしていたなど)を消すため。ほかの記録は POST と同じく足す
        if (req.method === "PUT") {
          const cur = loadRecord();
          backupRecord();
          const merged = mergeRecord({ ...cur, coverage: {}, dates: {} }, JSON.parse(await readBody(req)));
          saveRecord(merged);
          return json(res, 200, merged);
        }
        if (req.method === "DELETE") {
          const empty = { coverage: {}, dates: {}, logs: [], declared: {}, trips: {} };
          saveRecord(empty);
          return json(res, 200, empty);
        }
        return json(res, 405, { error: "method not allowed" });
      }

      if (url.pathname === "/api/logs") {
        if (req.method === "GET") return json(res, 200, listLogs());
        if (req.method === "POST") {
          const body = Buffer.concat(await readChunks(req));
          const meta = { date: url.searchParams.get("date"), m: Number(url.searchParams.get("m") ?? NaN), start: Number(url.searchParams.get("start") ?? NaN) };
          return json(res, 200, { id: saveLog(url.searchParams.get("name") ?? "log", body, meta).id });
        }
        return json(res, 405, { error: "method not allowed" });
      }

      if (url.pathname === "/api/judge") {
        if (req.method === "GET") return json(res, 200, judgeStatus());
        return json(res, 405, { error: "method not allowed" });
      }
      // 保存したログをすべて MiniPC で判定し直す。すぐに返し、様子は GET /api/judge で見る
      if (url.pathname === "/api/rejudge") {
        if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
        if (!serverJudge()) return json(res, 503, { error: "サーバーで判定する準備ができていません(npm run build を実行してください)" });
        startRejudge();
        return json(res, 202, judgeStatus());
      }

      if (url.pathname === "/api/inbox") {
        if (req.method === "GET") return json(res, 200, listPending());
        // ログをそのまま本文で送る(?name=ファイル名)。前に読み込んだのと同じログなら、判定し直さない
        if (req.method === "POST") {
          const body = Buffer.concat(await readChunks(req));
          if (body.length === 0) return json(res, 400, { error: "empty log" });
          const name = url.searchParams.get("name") ?? "log";
          // iPhone のロガーの走行は、同じ走行のログがもうあれば(移動手段を車に直したときにサーバーで作ったものなど)保存しない。
          // 車以外に直した走行(trips にあるもの)も地図には入れない
          const sm = SESSION_RE.exec(name);
          if (sm) {
            const have = sessionLogs(sm[1]);
            if (have.length) return json(res, 200, { id: have[0], duplicate: true });
            if (findSession(sm[1])?.kind === "trip") return json(res, 200, { id: null, duplicate: false, ignored: "trip" });
          }
          const { id, added } = saveLog(name, body, null);
          if (added) {
            // 生データが先に届いて補ってあれば、補った点を入れてから判定する
            if (sm) {
              const s = findSession(sm[1]);
              if (s?.kind === "drive") applyFillToLogs(s.dir, "drive");
            }
            savePending([...loadPending(), id]);
            if (serverJudge()) void enqueue(judgePending);
          }
          return json(res, 200, { id, duplicate: !added });
        }
        return json(res, 405, { error: "method not allowed" });
      }
      // 走行ロガーの生データを1ファイルずつ受け取る(?session=走行ID&file=ファイル名)。同じファイルは上書きする
      // 車以外の移動(電車・飛行機など)は &kind=trip を付けて送られ、trips フォルダの下に分けて置く
      if (url.pathname === "/api/rawlog") {
        if (req.method !== "PUT" && req.method !== "POST" && req.method !== "GET") return json(res, 405, { error: "method not allowed" });
        const session = url.searchParams.get("session") ?? "";
        const file = url.searchParams.get("file") ?? "";
        const ok = (s) => /^[\p{L}\p{N}][\p{L}\p{N}._-]{0,119}$/u.test(s) && !s.includes("..");
        if (!ok(session) || !ok(file)) return json(res, 400, { error: "bad session or file" });
        const kind = url.searchParams.get("kind") ?? "drive";
        if (kind !== "drive" && kind !== "trip") return json(res, 400, { error: "bad kind" });
        // サーバーが作ったファイル(トンネルを補った位置)だけは、アプリが取りに来られる
        if (req.method === "GET") {
          if (!RAW_READABLE.has(file)) return json(res, 403, { error: "not readable" });
          const path = join(rawDir(session, kind), file);
          if (!existsSync(path)) return json(res, 404, { error: "not found" });
          res.writeHead(200, { "Content-Type": file.endsWith(".json") ? "application/json" : "text/csv; charset=utf-8", "Cache-Control": "no-cache" });
          return res.end(readFileSync(path));
        }
        const body = Buffer.concat(await readChunks(req));
        const dir = rawDir(session, kind);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, `${file}.part`), body);
        renameSync(join(dir, `${file}.part`), join(dir, file));
        if (file === "meta.json") {
          fillAfterUpload(dir, kind);
          weatherAfterUpload(dir);
        }
        return json(res, 200, { saved: `${kind === "trip" ? "trips/" : ""}${session}/${file}`, bytes: body.length });
      }
      // 走行を忘れる(?session=走行ID)。アプリでログを分けたとき、前半を送り直す前に呼ぶ(forgetSession)
      if (url.pathname === "/api/rawlog/session") {
        const session = url.searchParams.get("session") ?? "";
        if (!SESSION_ID_RE.test(session)) return json(res, 400, { error: "bad session" });
        if (req.method !== "DELETE") return json(res, 405, { error: "method not allowed" });
        const r = forgetSession(session);
        return r ? json(res, 200, r) : json(res, 404, { error: "no session" });
      }
      // 走行の移動手段(?session=走行ID)。GET は { mode, kind }、POST は ?mode= に変える(changeMode)
      if (url.pathname === "/api/rawlog/mode") {
        const session = url.searchParams.get("session") ?? "";
        if (!SESSION_ID_RE.test(session)) return json(res, 400, { error: "bad session" });
        if (req.method === "GET") {
          const s = findSession(session);
          if (s) return json(res, 200, { session, mode: modeOfSession(s), kind: s.kind, sent: existsSync(join(s.dir, "meta.json")) });
          return sessionLogs(session).length ? json(res, 200, { session, mode: "car", kind: "drive", sent: false }) : json(res, 404, { error: "no session" });
        }
        if (req.method === "POST") {
          const mode = url.searchParams.get("mode") ?? "";
          if (!TRAVEL_MODES.includes(mode)) return json(res, 400, { error: "bad mode" });
          const r = changeMode(session, mode);
          // アプリは "no session" を見て、サーバーに何もない(送り直す)のか、古いサーバーで直せないのかを見分ける
          return r ? json(res, 200, r) : json(res, 404, { error: "no session" });
        }
        return json(res, 405, { error: "method not allowed" });
      }
      // 地図の「旅の記録」: trips フォルダの電車・飛行機などの移動を、間引いた線にして返す(制覇の判定には使わない)
      if (url.pathname === "/api/journeys") {
        if (req.method === "GET") return json(res, 200, loadJourneys());
        if (req.method === "POST") {
          const list = addJourney(JSON.parse(await readBody(req)));
          return list ? json(res, 200, list) : json(res, 400, { error: "名前と期間(YYYY-MM-DD)を入れてください" });
        }
        return json(res, 405, { error: "method not allowed" });
      }
      // 車載動画(YouTube)とログのひも付け
      if (url.pathname === "/api/videos") {
        if (req.method === "GET") return json(res, 200, loadVideos());
        if (req.method === "POST") {
          const list = upsertVideo(JSON.parse(await readBody(req)));
          return list ? json(res, 200, list) : json(res, 400, { error: "id と clips(start・dur・offset)を入れてください" });
        }
        return json(res, 405, { error: "method not allowed" });
      }
      const videoMatch = /^\/api\/videos\/([^/]+)$/.exec(url.pathname);
      if (videoMatch) {
        const id = decodeURIComponent(videoMatch[1]);
        if (req.method === "PATCH") {
          const r = setVideoUrl(id, JSON.parse(await readBody(req)).url);
          if (r === "bad") return json(res, 400, { error: "YouTube の URL が読めませんでした" });
          return r ? json(res, 200, r) : json(res, 404, { error: "not found" });
        }
        if (req.method === "DELETE") return json(res, 200, saveVideos(loadVideos().filter((v) => v.id !== id)));
        return json(res, 405, { error: "method not allowed" });
      }
      const journeyMatch = /^\/api\/journeys\/([^/]+)$/.exec(url.pathname);
      if (journeyMatch && req.method === "DELETE") {
        const id = decodeURIComponent(journeyMatch[1]);
        return json(res, 200, saveJourneys(loadJourneys().filter((j) => j.id !== id)));
      }
      // 旅行から外すログ・旅の記録を変える({ exclude: ["log:<ID>", "trip:<ID>", …] })
      if (journeyMatch && req.method === "PATCH") {
        const list = setJourneyExclude(decodeURIComponent(journeyMatch[1]), JSON.parse(await readBody(req)).exclude);
        return list ? json(res, 200, list) : json(res, 404, { error: "not found" });
      }
      // 旅の記録(同乗・電車など)の詳細: 時刻つきの位置(速度のグラフ用)・運転評価・天気
      const tripDetailMatch = /^\/api\/trips\/(\d{8}-\d{6})\/detail$/.exec(url.pathname);
      if (tripDetailMatch) {
        if (req.method !== "GET") return json(res, 405, { error: "method not allowed" });
        const d = tripDetail(tripDetailMatch[1]);
        return d ? json(res, 200, d) : json(res, 404, { error: "not found" });
      }
      // リプレイ用の 0.5 秒ごとの速度・前後G・横G・躍度(アプリが作って送る replay.csv)。車・old・trips の順に探す
      const replayMatch = /^\/api\/replay\/(\d{8}-\d{6})$/.exec(url.pathname);
      if (replayMatch) {
        if (req.method !== "GET") return json(res, 405, { error: "method not allowed" });
        const s = findSession(replayMatch[1]);
        const path = s && join(s.dir, "replay.csv");
        if (!path || !existsSync(path)) return json(res, 404, { error: "not found" });
        const body = readFileSync(path);
        if (/\bgzip\b/.test(req.headers["accept-encoding"] ?? "")) {
          res.writeHead(200, { "Content-Type": "text/csv; charset=utf-8", "Content-Encoding": "gzip", "Cache-Control": "no-cache", Vary: "Accept-Encoding" });
          return res.end(gzipSync(body));
        }
        res.writeHead(200, { "Content-Type": "text/csv; charset=utf-8", "Cache-Control": "no-cache" });
        return res.end(body);
      }
      if (url.pathname === "/api/trips") {
        if (req.method !== "GET") return json(res, 405, { error: "method not allowed" });
        const body = Buffer.from(JSON.stringify({ trips: listTrips(RAW_LOG_DIR()) }));
        if (/\bgzip\b/.test(req.headers["accept-encoding"] ?? "")) {
          res.writeHead(200, { "Content-Type": "application/json", "Content-Encoding": "gzip", "Cache-Control": "no-cache", Vary: "Accept-Encoding" });
          return res.end(gzipSync(body));
        }
        res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-cache" });
        return res.end(body);
      }
      // トンネルなどで途切れた区間を道路(電車は線路)に沿って補った結果(?session=走行ID[&kind=trip])。
      // GET は tunnel_fill.json を返す。POST は今すぐ補い直す(自動で補わない走行も補う)
      if (url.pathname === "/api/rawlog/fill") {
        const session = url.searchParams.get("session") ?? "";
        const kind = url.searchParams.get("kind") ?? "drive";
        if (!/^[\p{L}\p{N}][\p{L}\p{N}._-]{0,119}$/u.test(session) || session.includes("..") || (kind !== "drive" && kind !== "trip")) {
          return json(res, 400, { error: "bad session or kind" });
        }
        const dir = rawDir(session, kind);
        if (req.method === "GET") {
          try {
            return json(res, 200, JSON.parse(readFileSync(join(dir, "tunnel_fill.json"), "utf8")));
          } catch {
            return json(res, 404, { error: "not filled" });
          }
        }
        if (req.method === "POST") {
          if (!existsSync(join(dir, "location.csv"))) return json(res, 404, { error: "no location.csv" });
          if (!serverJudge()) return json(res, 503, { error: "道路データがないので補えません" });
          let out = null;
          let err = null;
          await enqueue(() => fillOne(dir).then((r) => (out = r), (e) => (err = e)));
          if (err) return json(res, 500, { error: err.message });
          applyFillToLogs(dir, kind);
          return json(res, 200, out);
        }
        return json(res, 405, { error: "method not allowed" });
      }
      // 走行の天気(?session=走行ID[&kind=trip])。GET は weather.json、POST は今すぐ取り直す
      if (url.pathname === "/api/rawlog/weather") {
        const session = url.searchParams.get("session") ?? "";
        const kind = url.searchParams.get("kind") ?? "drive";
        if (!/^[\p{L}\p{N}][\p{L}\p{N}._-]{0,119}$/u.test(session) || session.includes("..") || (kind !== "drive" && kind !== "trip")) {
          return json(res, 400, { error: "bad session or kind" });
        }
        const dir = rawDir(session, kind);
        if (req.method === "GET") {
          try {
            return json(res, 200, JSON.parse(readFileSync(join(dir, "weather.json"), "utf8")));
          } catch {
            return json(res, 404, { error: "no weather" });
          }
        }
        if (req.method === "POST") {
          if (!existsSync(join(dir, "location.csv"))) return json(res, 404, { error: "no location.csv" });
          let out = null;
          let err = null;
          await weatherEnqueue(() => weatherForDir(dir).then((r) => (out = r), (e) => (err = e)));
          return err ? json(res, 502, { error: err.message }) : json(res, 200, out);
        }
        return json(res, 405, { error: "method not allowed" });
      }
      const inboxMatch = /^\/api\/inbox\/([^/]+)$/.exec(url.pathname);
      if (inboxMatch && req.method === "DELETE") {
        return json(res, 200, { claimed: claimPending(decodeURIComponent(inboxMatch[1])) });
      }
      const evalMatch = /^\/api\/logs\/([^/]+)\/eval$/.exec(url.pathname);
      if (evalMatch && req.method === "GET") {
        const ev = loadEval(decodeURIComponent(evalMatch[1]));
        return ev ? json(res, 200, ev) : json(res, 404, { error: "not found" });
      }
      // ログの天気。GET はあるものを返す。POST は本文の軌跡の点 { points: [[UNIX秒, 緯度, 経度], …] } で取る
      const wxMatch = /^\/api\/logs\/([^/]+)\/weather$/.exec(url.pathname);
      if (wxMatch) {
        const id = decodeURIComponent(wxMatch[1]);
        if (id !== safeName(id) || !id.endsWith(".gz") || !existsSync(join(LOGS, id))) return json(res, 404, { error: "not found" });
        if (req.method === "GET") {
          const w = loadWeather(id);
          return w ? json(res, 200, w) : json(res, 404, { error: "no weather" });
        }
        if (req.method === "POST") {
          if (!weatherOn()) return json(res, 503, { error: "天気の取得は止めてあります" });
          const pts = JSON.parse(await readBody(req))?.points;
          if (!Array.isArray(pts) || pts.length === 0 || pts.length > 20000) return json(res, 400, { error: "bad points" });
          const points = pts.filter((p) => Array.isArray(p) && p.length >= 3).map(([t, lat, lon]) => ({ t: Number(t), lat: Number(lat), lon: Number(lon) }));
          let out = null;
          let err = null;
          await weatherEnqueue(() => weatherForLog(id, points).then((r) => (out = r), (e) => (err = e)));
          return err ? json(res, 502, { error: err.message }) : json(res, 200, out);
        }
        return json(res, 405, { error: "method not allowed" });
      }
      const logMatch = /^\/api\/logs\/([^/]+)$/.exec(url.pathname);
      if (logMatch && (req.method === "GET" || req.method === "PATCH")) {
        const id = decodeURIComponent(logMatch[1]);
        const path = join(LOGS, id);
        if (id !== safeName(id) || !id.endsWith(".gz") || !existsSync(path)) return json(res, 404, { error: "not found" });
        // 前から保存してあるログの日付と距離を、ブラウザで読んだときに足す
        if (req.method === "PATCH") {
          const meta = JSON.parse(await readBody(req));
          if (!isMeta(meta)) return json(res, 400, { error: "bad meta" });
          setMeta(id, meta);
          return json(res, 200, { id, date: meta.date, m: Math.round(meta.m), ...(isStart(meta.start) ? { start: meta.start } : {}) });
        }
        // 保存している gzip をそのまま送り、ブラウザに展開してもらう
        res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Content-Encoding": "gzip" });
        return res.end(readFileSync(path));
      }

      let path = normalize(join(DIST, decodeURIComponent(url.pathname)));
      if (!path.startsWith(DIST)) return json(res, 403, { error: "forbidden" });
      if (existsSync(path) && statSync(path).isDirectory()) path = join(path, "index.html");
      if (!existsSync(path)) return json(res, 404, { error: "not found" });
      sendFile(req, res, path);
    } catch (e) {
      console.error(e);
      json(res, 500, { error: String(e) });
    }
  });
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  if (!existsSync(join(DIST, "index.html"))) {
    console.error("dist/ がありません。先に npm run build(または scripts\\update.ps1)を実行してください。");
    process.exit(1);
  }
  const moved = dedupeLogs();
  if (moved) console.log(`重複して保存されていたログ ${moved} 件を ${join(LOGS, "duplicates")} に移しました`);
  const app = createApp();
  app.on("error", (e) => {
    if (e.code === "EADDRINUSE") console.error(`ポート ${PORT} はほかのプログラムが使っています(前のサーバーが残っている可能性があります)。`);
    else console.error(e);
    process.exit(1);
  });
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`${new Date().toISOString()} 国道制覇マップ: http://localhost:${PORT}/ (LAN からは http://<このPCのIPアドレス>:${PORT}/)`);
    console.log(`走行記録の保存先: ${RECORD}`);
    if (weatherOn()) {
      // 止まっている間に届いた走行・前からある走行で、天気のないものを取る。取れなかったものは定期的に取り直す
      const missing = [...new Set([...loadWeatherPending().map((p) => p.dir), ...weatherMissingDirs()])];
      if (missing.length) console.log(`天気のない走行 ${missing.length} 本の天気を取ります`);
      for (const dir of missing) weatherLater(dir);
      setInterval(retryWeather, WEATHER_RETRY_MS).unref();
    }
    if (serverJudge()) {
      console.log("走行ログはこのサーバーで判定します");
      // 止まっている間に残っていた、まだ判定していないログ
      void enqueue(judgePending);
      if (hasRails()) {
        const trains = trainsToFill();
        if (trains.length) console.log(`線路に沿って補っていない電車の記録 ${trains.length} 本を補います`);
        for (const dir of trains) void enqueue(() => fillOne(dir).catch((e) => console.error(`途切れた区間の補間に失敗: ${dir}: ${e.message}`)));
      }
      // 前に補ってあるのに、地図のログに補った点が入っていない車の走行
      const cars = carsToApplyFill();
      if (cars.length) console.log(`補った点を地図のログに入れる車の走行 ${cars.length} 本`);
      for (const dir of cars) applyFillToLogs(dir, "drive");
    } else console.log("サーバーで判定する準備ができていないので、走行ログはブラウザで判定します(npm run build で準備できます)");
  });
}
