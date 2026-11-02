// 都道府県道のデータ。全国だと国道の2倍以上あって重いので、都道府県ごとのファイル(prefroads/NN.json)に分けてあり、
// 画面には選んだ都道府県だけを読む。ログの判定では、ログが通った都道府県のファイルを読んで使う。
import type { Category, PrefRoadIndex, RouteData, Segment, TrackPoint, Tunnel } from "./types";

export const prefFileName = (code: number) => `prefroads/${String(code).padStart(2, "0")}.json`;

/** 都道府県ごとのファイルを1つのデータにまとめる。両方のファイルにある区間(県境の道)は路線をあわせて重複にする */
export function mergePrefData(list: RouteData[]): RouteData {
  const routes: RouteData["routes"] = {};
  const segs = new Map<string, Segment>();
  const tunnels = new Map<string, Tunnel>();
  for (const d of list) {
    Object.assign(routes, d.routes);
    for (const s of d.segments) {
      const prev = segs.get(s.id);
      if (!prev) {
        segs.set(s.id, s);
        continue;
      }
      const refs = [...new Set([...prev.routes, ...s.routes])];
      // 種別(主要地方道か一般か)は先のファイルのものを使う。両方入れると種別ごとの距離を二重に数えてしまう
      const cats: Category[] = refs.length > 1 ? [...new Set<Category>([...prev.cats, "overlap"])] : prev.cats;
      segs.set(s.id, { ...prev, routes: refs, cats });
    }
    for (const t of d.tunnels) tunnels.set(t.id, t);
  }
  return {
    version: 1,
    kind: "prefroad",
    generatedAt: list.map((d) => d.generatedAt).sort()[0] ?? "",
    routes,
    segments: [...segs.values()],
    tunnels: [...tunnels.values()],
  };
}

/** ログが通った(そばに都道府県道がある)都道府県のコード */
export function prefsOfTrack(index: PrefRoadIndex, track: TrackPoint[]): number[] {
  const cells = new Set<number>();
  for (const p of track) cells.add(Math.floor(p.lon / index.cell) * 1000 + Math.floor(p.lat / index.cell));
  const out: number[] = [];
  for (const [code, info] of Object.entries(index.prefs)) {
    if (info.cells.some((c) => cells.has(c))) out.push(Number(code));
  }
  return out.sort((a, b) => a - b);
}

/** 路線のキー "13-413" → [都道府県コード, 番号] */
export const splitPrefRef = (ref: string): [number, number] => {
  const [code, num] = ref.split("-").map(Number);
  return [code, num];
};

/** 路線一覧の並び: 都道府県コード順、その中は番号順 */
export function comparePrefRefs(a: string, b: string): number {
  const [ca, na] = splitPrefRef(a);
  const [cb, nb] = splitPrefRef(b);
  return ca - cb || na - nb;
}

/**
 * 都道府県道の路線の表示名。番号の入っていない名前(「津久井道」など。古いデータにある)には
 * 「神奈川県道3号」のような番号を前に付ける
 */
export function prefRouteLabel(ref: string, name: string | undefined, prefName: (code: number) => string): string {
  const [code, num] = splitPrefRef(ref);
  const base = `${prefName(code)}道${num}号`;
  if (!name) return base;
  return new RegExp(`(^|[^0-9])${num}号`).test(name) ? name : `${base} ${name}`;
}
