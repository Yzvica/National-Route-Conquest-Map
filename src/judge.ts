// 走行ログの判定(ブラウザと MiniPC のサーバーで同じものを使う)
import { classifyTrack } from "./layers";
import { DEFAULT_OPTIONS, matchTrack } from "./matcher";
import { parseGpx } from "./parsers/gpx";
import { fileNameTime, parseTrackCsv } from "./parsers/csv";
import { prefsOfTrack } from "./prefroads";
import { prepareForTrack } from "./splitData";
import { trackLength, tripKey, type Trip } from "./trips";
import type { Coverage, PrefRoadIndex, RouteData, TrackPoint } from "./types";

/** 判定に使う道路データ。都道府県道は都道府県ごとのファイルを、要るときに読む */
export interface JudgeData {
  kokudo?: RouteData;
  expressway?: RouteData;
  prefIndex?: PrefRoadIndex | null;
  loadPref(code: number): Promise<RouteData | undefined>;
}

export function parseTrackText(text: string, name: string): TrackPoint[] {
  if (/\.gpx$/i.test(name) || text.trimStart().startsWith("<")) return parseGpx(text);
  return parseTrackCsv(text, name);
}

/** ログの日付(YYYY-MM-DD、端末の時刻帯)。ログに時刻がなければファイル名の日時、それもなければ fallback(ファイルの更新日など) */
export function logDate(track: TrackPoint[], name: string, fallback: number): string {
  const d = new Date(track.find((p) => p.time !== undefined)?.time ?? fileNameTime(name) ?? fallback);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * 国道・高速道路と、ログが通った都道府県の都道府県道で判定し、区間ごとに大きいほうをとる。
 * 都道府県道は画面に出していない都道府県の分も判定する(あとでその都道府県を選んだときに記録があるように)
 */
export async function matchAll(track: TrackPoint[], data: JudgeData): Promise<Coverage> {
  const out: Coverage = new Map();
  // 画面で分けて読んでいるデータなら、ログが通った場所の区間の形を先に読む
  await Promise.all([prepareForTrack(data.kokudo, track), prepareForTrack(data.expressway, track)]);
  const generals: RouteData[] = [];
  if (data.kokudo) generals.push(data.kokudo);
  if (data.prefIndex) {
    for (const code of prefsOfTrack(data.prefIndex, track)) {
      const d = await data.loadPref(code);
      if (d) generals.push(d);
    }
  }
  const expressway = data.expressway;
  // 高架の高速道路と下の国道が並んでいるところで、走っていないほうを塗らないように、ログの各点がどちらの上かを先に決める
  const layers = expressway ? classifyTrack(track, expressway, generals) : undefined;
  for (const d of expressway ? [...generals, expressway] : generals) {
    for (const [id, r] of matchTrack(d, track, DEFAULT_OPTIONS, layers)) out.set(id, Math.max(out.get(id) ?? 0, r));
  }
  return out;
}

/** 1本のログを判定した結果 */
export interface JudgedLog {
  track: TrackPoint[];
  day: string;
  trip: Trip;
  tripKey: string;
  coverage: Coverage;
}

export async function judgeLog(text: string, name: string, fallback: number, data: JudgeData): Promise<JudgedLog> {
  const track = parseTrackText(text, name);
  const day = logDate(track, name, fallback);
  const trip = { date: day, m: Math.round(trackLength(track)) };
  return { track, day, trip, tripKey: tripKey(track, day), coverage: await matchAll(track, data) };
}
