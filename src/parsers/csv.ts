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

/**
 * 緯度・経度(・時刻)列をヘッダー名から探して読む。
 * gbowl の CSV もこれで読む想定(サンプル受領後に列名を確定させる)。
 */
export function parseTrackCsv(text: string): TrackPoint[] {
  const rows = parseCsvRows(text.replace(/^﻿/, ""));
  if (rows.length < 2) return [];
  const header = rows[0].map((h) => h.trim());
  const latCol = header.findIndex((h) => LAT.test(h));
  const lonCol = header.findIndex((h) => LON.test(h));
  const timeCol = header.findIndex((h) => TIME.test(h));
  if (latCol < 0 || lonCol < 0) {
    throw new Error(`緯度・経度の列が見つかりません(ヘッダー: ${header.join(", ")})`);
  }
  const points: TrackPoint[] = [];
  for (const r of rows.slice(1)) {
    const lat = Number(r[latCol]);
    const lon = Number(r[lonCol]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || (lat === 0 && lon === 0)) continue;
    points.push({ lat, lon, time: timeCol >= 0 ? parseTime(r[timeCol] ?? "") : undefined });
  }
  return points;
}
