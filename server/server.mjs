// MiniPC で動かすサーバー。ビルド済みのアプリ(dist/)を配信し、
// 走行記録を data/record.json に保存して、LAN 内のどの端末からも同じ記録を見られるようにする。
// Node.js の標準機能だけで動く。
import { createServer } from "node:http";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { gzipSync } from "node:zlib";

const ROOT = resolve(import.meta.dirname, "..");
const DIST = join(ROOT, "dist");
const RECORD = process.env.RECORD_FILE ?? join(ROOT, "data", "record.json");
const PORT = Number(process.env.PORT ?? 8080);
// 読み込んだ走行ログそのもの。あとで判定方法や対象の道路(高速道路など)を増やしたときに判定し直せるよう残す
const LOGS = process.env.LOGS_DIR ?? join(dirname(RECORD), "logs");

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
export function mergeRecord(base, add) {
  const coverage = { ...base.coverage };
  for (const [id, r] of Object.entries(add.coverage ?? {})) {
    if (typeof r === "number" && r > (coverage[id] ?? 0)) coverage[id] = Math.min(r, 1);
  }
  const dates = { ...base.dates };
  for (const [id, d] of Object.entries(add.dates ?? {})) {
    if (!isDates(d)) continue;
    const cur = dates[id];
    dates[id] = cur ? [cur[0] < d[0] ? cur[0] : d[0], cur[1] > d[1] ? cur[1] : d[1]] : d;
  }
  // 点線国道の自己申告は、申告した時刻が新しい方を残す(取り消しもできるように)
  const declared = { ...(base.declared ?? {}) };
  for (const [ref, d] of Object.entries(add.declared ?? {})) {
    if (!d || typeof d.on !== "boolean" || typeof d.at !== "string") continue;
    if (!declared[ref] || d.at > declared[ref].at) declared[ref] = { on: d.on, at: d.at };
  }
  // ログごとの走行距離。同じログ(同じキー)は上書きする
  const trips = { ...(base.trips ?? {}) };
  for (const [key, t] of Object.entries(add.trips ?? {})) {
    if (t && typeof t.date === "string" && typeof t.m === "number" && t.m >= 0) trips[key] = { date: t.date, m: t.m };
  }
  return { coverage, dates, logs: [...base.logs, ...(add.logs ?? [])], declared, trips };
}

// --- 走行ログ ---

/** ファイル名に使えない文字を除く。id は「保存時刻-元の名前.gz」 */
const safeName = (name) => name.replace(/[^\p{L}\p{N}._-]+/gu, "_").slice(0, 120) || "log";

function saveLog(name, body) {
  mkdirSync(LOGS, { recursive: true });
  const id = `${Date.now()}-${safeName(name)}.gz`;
  writeFileSync(join(LOGS, id), gzipSync(body));
  return id;
}

function listLogs() {
  if (!existsSync(LOGS)) return [];
  return readdirSync(LOGS)
    .filter((f) => f.endsWith(".gz"))
    .sort()
    .map((id) => ({ id, name: id.replace(/^\d+-/, "").replace(/\.gz$/, ""), size: statSync(join(LOGS, id)).size }));
}

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
          return json(res, 200, { id: saveLog(url.searchParams.get("name") ?? "log", body) });
        }
        return json(res, 405, { error: "method not allowed" });
      }
      const logMatch = /^\/api\/logs\/([^/]+)$/.exec(url.pathname);
      if (logMatch && req.method === "GET") {
        const id = decodeURIComponent(logMatch[1]);
        const path = join(LOGS, id);
        if (id !== safeName(id) || !existsSync(path)) return json(res, 404, { error: "not found" });
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
  const app = createApp();
  app.on("error", (e) => {
    if (e.code === "EADDRINUSE") console.error(`ポート ${PORT} はほかのプログラムが使っています(前のサーバーが残っている可能性があります)。`);
    else console.error(e);
    process.exit(1);
  });
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`${new Date().toISOString()} 国道制覇マップ: http://localhost:${PORT}/ (LAN からは http://<このPCのIPアドレス>:${PORT}/)`);
    console.log(`走行記録の保存先: ${RECORD}`);
  });
}
