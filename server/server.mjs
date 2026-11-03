// MiniPC で動かすサーバー。ビルド済みのアプリ(dist/)を配信し、
// 走行記録を data/record.json に保存して、LAN 内のどの端末からも同じ記録を見られるようにする。
// Node.js の標準機能だけで動く。
import { createServer } from "node:http";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { Worker } from "node:worker_threads";
import { gunzipSync, gzipSync } from "node:zlib";

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

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};
const COMPRESSIBLE = new Set([".html", ".js", ".css", ".json", ".svg"]);

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

function setMeta(id, m) {
  const all = loadMeta();
  all[id] = { date: m.date, m: Math.round(m.m) };
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
  return logFiles().map((id) => ({
    id,
    name: logName(id),
    size: statSync(join(LOGS, id)).size,
    ...(isMeta(meta[id]) ? { date: meta[id].date, m: meta[id].m } : {}),
  }));
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

function stopWorker() {
  const w = worker;
  worker = null;
  workerReady = null;
  if (w) void w.terminate();
}

function startWorker() {
  const w = new Worker(JUDGE_WORKER, { workerData: { dataDir: JUDGE_DATA, logsDir: LOGS } });
  worker = w;
  workerReady = new Promise((ok, ng) => {
    w.on("message", (m) => {
      if (m?.ready) return ok();
      const p = waiting.get(m?.seq);
      if (!p) return;
      waiting.delete(m.seq);
      if (m.error) p.ng(new Error(m.error));
      else p.ok(m.result);
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
    w.on("error", fail);
    w.on("exit", (code) => fail(new Error(`判定の処理が止まりました(${code})`)));
  });
  // 待っている人がいないときに起きた失敗で、未処理の拒否にならないように
  workerReady.catch(() => undefined);
}

/** 保存してあるログ 1 本を判定する */
async function judgeOne(id) {
  clearTimeout(idleTimer);
  if (!worker) startWorker();
  await workerReady;
  const n = ++seq;
  return new Promise((ok, ng) => {
    waiting.set(n, { ok, ng });
    worker.postMessage({ seq: n, logId: id });
  });
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
  if (!isMeta(cur) || cur.date !== trip.date || cur.m !== trip.m) setMeta(id, trip);
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
      clearTimeout(idleTimer);
      idleTimer = setTimeout(stopWorker, JUDGE_IDLE_MS);
      idleTimer.unref?.();
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

export function createApp() {
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
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
          const meta = { date: url.searchParams.get("date"), m: Number(url.searchParams.get("m") ?? NaN) };
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
        if (!judge.rejudgeQueued && judge.running?.kind !== "rejudge") {
          judge.rejudgeQueued = true;
          void enqueue(rejudgeAll);
        }
        return json(res, 202, judgeStatus());
      }

      if (url.pathname === "/api/inbox") {
        if (req.method === "GET") return json(res, 200, listPending());
        // ログをそのまま本文で送る(?name=ファイル名)。前に読み込んだのと同じログなら、判定し直さない
        if (req.method === "POST") {
          const body = Buffer.concat(await readChunks(req));
          if (body.length === 0) return json(res, 400, { error: "empty log" });
          const { id, added } = saveLog(url.searchParams.get("name") ?? "log", body, null);
          if (added) {
            savePending([...loadPending(), id]);
            if (serverJudge()) void enqueue(judgePending);
          }
          return json(res, 200, { id, duplicate: !added });
        }
        return json(res, 405, { error: "method not allowed" });
      }
      const inboxMatch = /^\/api\/inbox\/([^/]+)$/.exec(url.pathname);
      if (inboxMatch && req.method === "DELETE") {
        return json(res, 200, { claimed: claimPending(decodeURIComponent(inboxMatch[1])) });
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
          return json(res, 200, { id, date: meta.date, m: Math.round(meta.m) });
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
    if (serverJudge()) {
      console.log("走行ログはこのサーバーで判定します");
      // 止まっている間に残っていた、まだ判定していないログ
      void enqueue(judgePending);
    } else console.log("サーバーで判定する準備ができていないので、走行ログはブラウザで判定します(npm run build で準備できます)");
  });
}
