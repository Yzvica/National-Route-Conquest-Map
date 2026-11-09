// 分けて読む道路データ(scripts/split_data.mjs が作る split/<種類>/)。
// 地図を開いたときは一覧(index.json)だけを読み、区間は両端の点だけの形で作る。
// 区間の途中の点は 0.5 度ごとのマスに分けてあり、拡大した場所や、ログが通った場所のマスを読んだときに、
// その区間の coords を本当の形に置き換える(同じ Segment を書き換えるので、ほかの処理はそのまま使える)。
import type { Category, LonLat, RouteData, Segment, TrackPoint } from "./types";

export const SPLIT_FORMAT = 1;

interface SplitColumns {
  format: number;
  cell: number;
  scale: number;
  count: number;
  cells: string[];
  idRuns: [string, number, number][];
  routeSets: string[][];
  catSets: Category[][];
  names: string[];
  r: number[];
  c: number[];
  len: number[];
  ends: number[];
  pair: number[];
  name: number[];
  pref: number[];
  extra: [number, Partial<Segment>][];
}

export type SplitIndex = Omit<RouteData, "segments"> & { split: SplitColumns };

/** マスのファイル。i は区間の番号、c はその区間の点(最初の点と差の整数の列)。両端だけの区間は 0 */
interface CellFile {
  i: number[];
  c: (number[] | 0)[];
}

export class SplitLoader {
  readonly data: RouteData;
  readonly cell: number;
  private readonly scale: number;
  private readonly cells: Set<string>;
  private readonly loaded = new Map<string, Promise<number[]>>();
  /** 読み終えたマスにかかる区間(形が本当のものになっている) */
  private readonly seen: Uint8Array;
  private readonly listeners = new Set<(segs: number[]) => void>();

  constructor(
    index: SplitIndex,
    private readonly url: (key: string) => string,
    private readonly fetchJson: (url: string) => Promise<unknown> = defaultFetch,
  ) {
    const { split, ...head } = index;
    this.cell = split.cell;
    this.scale = split.scale;
    this.cells = new Set(split.cells);
    this.data = { ...head, segments: decodeSegments(split) };
    this.seen = new Uint8Array(split.count);
  }

  /** マスのキー */
  key(lon: number, lat: number) {
    return `${Math.floor(lon / this.cell)}_${Math.floor(lat / this.cell)}`;
  }

  /** 範囲(経度・緯度)にかかる、データのあるマス */
  cellsIn(west: number, south: number, east: number, north: number): string[] {
    const out: string[] = [];
    const [x0, x1] = [Math.floor(west / this.cell), Math.floor(east / this.cell)];
    const [y0, y1] = [Math.floor(south / this.cell), Math.floor(north / this.cell)];
    // 日本全体を見ているような広い範囲では、マスの一覧から拾う
    if ((x1 - x0 + 1) * (y1 - y0 + 1) > this.cells.size) {
      for (const k of this.cells) {
        const [x, y] = k.split("_").map(Number);
        if (x >= x0 && x <= x1 && y >= y0 && y <= y1) out.push(k);
      }
      return out;
    }
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) if (this.cells.has(`${x}_${y}`)) out.push(`${x}_${y}`);
    return out;
  }

  /** ログの判定に要るマス。点と点の間(トンネルなどで途切れたところ)も含め、少し(約1km)広めにとる */
  cellsOfTrack(track: TrackPoint[], margin = 0.01): string[] {
    const keys = new Set<string>();
    const add = (lon: number, lat: number) => {
      for (const dx of [-margin, margin]) for (const dy of [-margin, margin]) keys.add(this.key(lon + dx, lat + dy));
    };
    const step = this.cell / 4;
    for (let i = 0; i < track.length; i++) {
      const p = track[i];
      add(p.lon, p.lat);
      if (i === 0) continue;
      const a = track[i - 1];
      const n = Math.ceil(Math.max(Math.abs(p.lon - a.lon), Math.abs(p.lat - a.lat)) / step);
      // 遠く離れた点(別の日のログをつないだものなど)の間は見ない
      if (n > 40) continue;
      for (let k = 1; k < n; k++) add(a.lon + ((p.lon - a.lon) * k) / n, a.lat + ((p.lat - a.lat) * k) / n);
    }
    return [...keys].filter((k) => this.cells.has(k));
  }

  /** マスを読んで区間の形を置き換える。戻り値は、そのマスにかかる区間の番号 */
  load(keys: string[]): Promise<number[]> {
    return Promise.all(keys.map((k) => this.loadCell(k))).then((lists) => lists.flat());
  }

  /** マスを読み終えて区間の形が変わったときに呼ぶ(地図の描き直し用) */
  onLoad(fn: (segs: number[]) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** 区間 i の形を読み終えているか */
  hasShape(i: number) {
    return this.seen[i] === 1;
  }

  private loadCell(key: string): Promise<number[]> {
    let p = this.loaded.get(key);
    if (p) return p;
    p = this.fetchJson(this.url(key)).then((json) => {
      const cell = json as CellFile;
      const segs = this.data.segments;
      const changed: number[] = [];
      cell.i.forEach((i, n) => {
        const packed = cell.c[n];
        if (packed && !this.seen[i]) segs[i].coords = unpackCoords(packed, this.scale);
        this.seen[i] = 1;
        changed.push(i);
      });
      for (const fn of this.listeners) fn(changed);
      return cell.i;
    });
    this.loaded.set(key, p);
    // 読めなかったマスは、次に要るときにもう一度読む
    p.catch(() => this.loaded.delete(key));
    return p;
  }
}

async function defaultFetch(url: string): Promise<unknown> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url} を読めませんでした(${r.status})`);
  return r.json();
}

function decodeSegments(s: SplitColumns): Segment[] {
  const ids: string[] = [];
  for (const [head, start, count] of s.idRuns) {
    if (start < 0) ids.push(head);
    else for (let k = 0; k < count; k++) ids.push(`${head}-${start + k}`);
  }
  const segs: Segment[] = new Array(s.count);
  let px = 0;
  let py = 0;
  for (let i = 0; i < s.count; i++) {
    const e = 4 * i;
    const ax = px + s.ends[e];
    const ay = py + s.ends[e + 1];
    const bx = ax + s.ends[e + 2];
    const by = ay + s.ends[e + 3];
    px = bx;
    py = by;
    const seg: Segment = {
      id: ids[i],
      routes: s.routeSets[s.r[i]],
      cats: s.catSets[s.c[i]],
      len: s.len[i],
      coords: [
        [ax / s.scale, ay / s.scale],
        [bx / s.scale, by / s.scale],
      ],
    };
    if (s.name[i]) seg.name = s.names[s.name[i] - 1];
    if (s.pref[i]) seg.pref = s.pref[i];
    segs[i] = seg;
  }
  for (let i = 0; i < s.count; i++) if (s.pair[i] >= 0) segs[i].pair = ids[s.pair[i]];
  for (const [i, rest] of s.extra) Object.assign(segs[i], rest);
  return segs;
}

function unpackCoords(packed: number[], scale: number): LonLat[] {
  const out: LonLat[] = [];
  let x = 0;
  let y = 0;
  for (let k = 0; k < packed.length; k += 2) {
    x += packed[k];
    y += packed[k + 1];
    out.push([x / scale, y / scale]);
  }
  return out;
}

/** 分けて読んでいるデータの読み込み役。分けていない(全部読んだ)データなら undefined */
const loaders = new WeakMap<RouteData, SplitLoader>();
export const splitLoaderOf = (data: RouteData | undefined) => (data ? loaders.get(data) : undefined);

/** 一覧からデータを作る。マスは base + "<キー>.json" から読む */
export function openSplit(index: SplitIndex, base: string, fetchJson?: (url: string) => Promise<unknown>): RouteData {
  const loader = new SplitLoader(index, (k) => `${base}${k}.json`, fetchJson);
  loaders.set(loader.data, loader);
  return loader.data;
}

export const isSplitIndex = (j: unknown): j is SplitIndex =>
  typeof j === "object" && j !== null && (j as SplitIndex).split?.format === SPLIT_FORMAT;

/** ログの判定の前に、ログが通った場所のマスを読んでおく(分けていないデータなら何もしない) */
export async function prepareForTrack(data: RouteData | undefined, track: TrackPoint[]) {
  const loader = splitLoaderOf(data);
  if (loader) await loader.load(loader.cellsOfTrack(track));
}
