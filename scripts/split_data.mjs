// 国道・高速道路のデータ(routes.json・expressways.json)を、画面で分けて読めるように作り直す。
//   node scripts/split_data.mjs [データのフォルダ(既定 public/data)]
// 区間の番号・長さ・両端の点などは一覧(split/<種類>/index.json)にまとめ、
// 区間の途中の点は 0.5 度ごとのマス(split/<種類>/<x>_<y>.json)に分ける。
// 地図を開いたときは一覧だけを読み、拡大した場所のマスや、ログが通った場所のマスをあとから読む(src/splitData.ts)。
// サーバーでの判定(judgeWorker)は今までどおり routes.json をそのまま使う。
// Node.js の標準機能だけで動く。npm run build の最初に実行される。
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const SPLIT_FORMAT = 1;
/** マスの大きさ(度) */
export const CELL = 0.5;
/** 座標は 1e-5 度(約1m)単位の整数で持つ(もとのデータも小数5桁まで) */
const SCALE = 1e5;
const SOURCES = { kokudo: "routes.json", expressway: "expressways.json" };
/** 一覧の列にしない、区間のその他の項目(少ないので区間ごとにそのまま残す) */
const COLUMNS = new Set(["id", "routes", "cats", "len", "coords", "pair", "name", "pref"]);

const q = (v) => Math.round(v * SCALE);
export const cellKey = (lon, lat) => `${Math.floor(lon / CELL)}_${Math.floor(lat / CELL)}`;

/** 区間が通るマス。点と点の間が離れていても、間のマスを飛ばさないよう細かく見る */
function cellsOf(coords) {
  const keys = new Set();
  for (let i = 0; i < coords.length; i++) {
    keys.add(cellKey(coords[i][0], coords[i][1]));
    if (i === 0) continue;
    const [a, b] = [coords[i - 1], coords[i]];
    const n = Math.ceil(Math.max(Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1])) / (CELL / 4));
    for (let k = 1; k < n; k++) keys.add(cellKey(a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n));
  }
  return keys;
}

/** 点の列を、最初の点と、そこからの差の整数の列にする */
function packCoords(coords) {
  const out = [];
  let x = 0;
  let y = 0;
  for (const [lon, lat] of coords) {
    const nx = q(lon);
    const ny = q(lat);
    out.push(nx - x, ny - y);
    x = nx;
    y = ny;
  }
  return out;
}

/**
 * RouteData を一覧とマスに分ける。
 * 戻り値の index は一覧、cells はマスのキー → { i: 区間の番号の列, c: 区間ごとの点の列(packCoords。両端だけの区間は 0) }
 */
export function splitRouteData(data) {
  const segs = data.segments;
  const indexOf = new Map(segs.map((s, i) => [s.id, i]));
  const tables = () => {
    const list = [];
    const ids = new Map();
    return {
      list,
      id(v) {
        const k = JSON.stringify(v);
        let n = ids.get(k);
        if (n === undefined) ids.set(k, (n = list.push(v) - 1));
        return n;
      },
    };
  };
  const routeSets = tables();
  const catSets = tables();
  const names = tables();
  // ID は "w123-0", "w123-1", ... と続くことが多いので、続いている分をまとめる: [頭, 最初の番号, 個数]
  const idRuns = [];
  const r = [];
  const c = [];
  const len = [];
  const ends = [];
  let px = 0;
  let py = 0;
  const pair = [];
  const name = [];
  const pref = [];
  const extra = [];
  const cells = new Map();
  segs.forEach((s, i) => {
    const m = /^(.*)-(\d+)$/.exec(s.id);
    const last = idRuns[idRuns.length - 1];
    if (m && last && last[0] === m[1] && last[1] >= 0 && last[1] + last[2] === Number(m[2]) && String(Number(m[2])) === m[2]) last[2]++;
    else if (m && String(Number(m[2])) === m[2]) idRuns.push([m[1], Number(m[2]), 1]);
    else idRuns.push([s.id, -1, 1]);
    r.push(routeSets.id(s.routes));
    c.push(catSets.id(s.cats));
    len.push(s.len);
    const a = s.coords[0];
    const b = s.coords[s.coords.length - 1];
    // 両端は、前の区間の終わりからの差と、始めからの差で持つ(続いている区間では 0 になって小さい)
    const [ax, ay, bx, by] = [q(a[0]), q(a[1]), q(b[0]), q(b[1])];
    ends.push(ax - px, ay - py, bx - ax, by - ay);
    px = bx;
    py = by;
    pair.push(s.pair !== undefined && indexOf.has(s.pair) ? indexOf.get(s.pair) : -1);
    name.push(s.name !== undefined ? names.id(s.name) + 1 : 0);
    pref.push(s.pref ?? 0);
    const rest = {};
    for (const [k, v] of Object.entries(s)) if (!COLUMNS.has(k)) rest[k] = v;
    // 反対車線がこのデータにない(古いデータなど)ときも、そのまま残す
    if (s.pair !== undefined && !indexOf.has(s.pair)) rest.pair = s.pair;
    if (Object.keys(rest).length) extra.push([i, rest]);
    // 両端だけの区間は一覧だけで形がわかるので、点は入れない(0)。地図に描く区間を決めるため、番号は入れる
    const packed = s.coords.length <= 2 ? 0 : packCoords(s.coords);
    for (const key of cellsOf(s.coords)) {
      let cell = cells.get(key);
      if (!cell) cells.set(key, (cell = { i: [], c: [] }));
      cell.i.push(i);
      cell.c.push(packed);
    }
  });
  const { segments: _segments, ...head } = data;
  const index = {
    ...head,
    split: {
      format: SPLIT_FORMAT,
      cell: CELL,
      scale: SCALE,
      count: segs.length,
      cells: [...cells.keys()].sort(),
      idRuns,
      routeSets: routeSets.list,
      catSets: catSets.list,
      names: names.list,
      r,
      c,
      len,
      ends,
      pair,
      name,
      pref,
      extra,
    },
  };
  return { index, cells };
}

/** dir の routes.json・expressways.json から dir/split/<種類>/ を作る。元のファイルが変わっていなければ作り直さない */
export function splitDataDir(dir, log = console.log) {
  for (const [kind, file] of Object.entries(SOURCES)) {
    const src = join(dir, file);
    const out = join(dir, "split", kind);
    if (!existsSync(src)) {
      // 元のデータがなくなったら、古い分けたデータも消す(画面が古いものを読まないように)
      if (existsSync(out)) rmSync(out, { recursive: true, force: true });
      continue;
    }
    const st = statSync(src);
    // このスクリプトを直したときも作り直す
    const me = statSync(import.meta.filename);
    const stamp = `${SPLIT_FORMAT}-${st.size}-${Math.floor(st.mtimeMs)}-${me.size}-${Math.floor(me.mtimeMs)}`;
    const stampFile = join(out, "source.txt");
    if (existsSync(stampFile) && readFileSync(stampFile, "utf8") === stamp && existsSync(join(out, "index.json"))) {
      log(`${file}: 変わっていないので分け直しません`);
      continue;
    }
    const started = Date.now();
    const { index, cells } = splitRouteData(JSON.parse(readFileSync(src, "utf8")));
    // 書いている途中で画面が読まないよう、別のフォルダに書いてから入れ替える
    const tmp = `${out}.tmp`;
    rmSync(tmp, { recursive: true, force: true });
    mkdirSync(tmp, { recursive: true });
    for (const [key, cell] of cells) writeFileSync(join(tmp, `${key}.json`), JSON.stringify(cell));
    writeFileSync(join(tmp, "index.json"), JSON.stringify(index));
    writeFileSync(join(tmp, "source.txt"), stamp);
    rmSync(out, { recursive: true, force: true });
    mkdirSync(join(dir, "split"), { recursive: true });
    renameSync(tmp, out);
    const mb = (statSync(join(out, "index.json")).size / 1e6).toFixed(1);
    log(`${file}: 一覧 ${mb}MB と ${cells.size} マスに分けました(${((Date.now() - started) / 1000).toFixed(1)} 秒)`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  splitDataDir(resolve(process.argv[2] ?? "public/data"));
}
