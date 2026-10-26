import type { TrackPoint } from "../types";

/** ダブルクォート対応の最小限の CSV パーサー */
export function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      if (row.some((f) => f !== "")) rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f !== "")) rows.push(row);
  return rows;
}

const LAT = /^(lat|latitude|緯度)$/i;
const LON = /^(lon|lng|long|longitude|経度)$/i;
const TIME = /(time|date|timestamp|日時|時刻|日付)/i;

/** UNIX 秒/ミリ秒、または Date.parse できる文字列を UNIX ミリ秒にする */
export function parseTime(s: string): number | undefined {
  const v = s.trim();
  if (v === "") return undefined;
  if (/^\d+(\.\d+)?$/.test(v)) {
    const n = Number(v);
    return n < 1e11 ? n * 1000 : n;
  }
  // "2026/10/26 13:44:50" のような区切りにも対応する
  const t = Date.parse(v.replace(/^(\d{4})\/(\d{1,2})\/(\d{1,2})/, "$1-$2-$3").replace(" ", "T"));
  return Number.isNaN(t) ? undefined : t;
}

/** "Latitude(deg)" → "Latitude" のように単位を外して比べる */
const normalizeHeader = (h: string) => h.replace(/[(（].*?[)）]/g, "").trim();

/** gbowl の 1行目 "#GBOWLCSV,2026-09-19 20:05:37 (13m) DriverA" から記録開始時刻(日本時間)を読む */
function gbowlStartTime(rows: string[][]): number | undefined {
  const first = rows[0]?.[0]?.trim();
  if (first !== "#GBOWLCSV") return undefined;
  const m = rows[0][1]?.match(/(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})/);
  if (!m) return undefined;
  const t = Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}+09:00`);
  return Number.isNaN(t) ? undefined : t;
}

/**
 * 緯度・経度(・時刻)列をヘッダー名から探して読む。
 * gbowl の CSV は先頭に "#GBOWLCSV" などの情報行があり、時刻は記録開始からの秒数。
 */
export function parseTrackCsv(text: string): TrackPoint[] {
  const rows = parseCsvRows(text.replace(/^\uFEFF/, ""));
  const headerIndex = rows.findIndex((r) => {
    const h = r.map(normalizeHeader);
    return h.some((c) => LAT.test(c)) && h.some((c) => LON.test(c));
  });
  if (headerIndex < 0) {
    throw new Error(`緯度・経度の列が見つかりません(1行目: ${rows[0]?.join(", ") ?? ""})`);
  }
  const header = rows[headerIndex].map(normalizeHeader);
  const latCol = header.findIndex((h) => LAT.test(h));
  const lonCol = header.findIndex((h) => LON.test(h));
  const timeCol = header.findIndex((h) => TIME.test(h));
  const start = gbowlStartTime(rows);

  const points: TrackPoint[] = [];
  for (const r of rows.slice(headerIndex + 1)) {
    const lat = Number(r[latCol]);
    const lon = Number(r[lonCol]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || (lat === 0 && lon === 0)) continue;
    const prev = points[points.length - 1];
    // 停車中などで同じ座標が続く行は1つにまとめる
    if (prev && prev.lat === lat && prev.lon === lon) continue;
    let time: number | undefined;
    if (timeCol >= 0) {
      const raw = r[timeCol] ?? "";
      time = start !== undefined ? start + Number(raw) * 1000 : parseTime(raw);
      if (time !== undefined && Number.isNaN(time)) time = undefined;
    }
    points.push({ lat, lon, time });
  }
  return points;
}
