import type { Trip } from "./trips";
import type { Coverage } from "./types";

export interface LogEntry {
  name: string;
  importedAt: string;
  points: number;
}

/** 区間を通った日 [初めて, 最後](YYYY-MM-DD) */
export type PassDates = [string, string];

/** 点線国道の自己申告。on: 走った、at: 申告した時刻(ISO)。端末間では新しい方を残す */
export interface Declared {
  on: boolean;
  at: string;
}

export interface Record {
  coverage: Coverage;
  /** 区間ID → 通った日。日付を記録する前に取り込んだ区間にはない */
  dates: Map<string, PassDates>;
  logs: LogEntry[];
  /** 国道番号 → 点線国道を走ったかの自己申告 */
  declared: Map<string, Declared>;
  /** ログごとの走行距離(tripKey → 日付と距離)。振り返りでログ上の走行距離を出すのに使う */
  trips: Map<string, Trip>;
}

interface RecordJson {
  coverage: { [id: string]: number };
  dates?: { [id: string]: PassDates };
  logs: LogEntry[];
  declared?: { [ref: string]: Declared };
  trips?: { [key: string]: Trip };
}

const KEY = "nrcm:coverage:v1";
const LOGS_KEY = "nrcm:logs:v1";
const API = `${import.meta.env.BASE_URL}api/record`;

const DATES_KEY = "nrcm:dates:v1";
const DECLARED_KEY = "nrcm:declared:v1";
const TRIPS_KEY = "nrcm:trips:v1";

export const emptyRecord = (): Record => ({ coverage: new Map(), dates: new Map(), logs: [], declared: new Map(), trips: new Map() });

const toRecord = (j: RecordJson): Record => ({
  coverage: new Map(Object.entries(j.coverage ?? {})),
  dates: new Map(Object.entries(j.dates ?? {})),
  logs: j.logs ?? [],
  declared: new Map(Object.entries(j.declared ?? {})),
  trips: new Map(Object.entries(j.trips ?? {})),
});
const toJson = (r: Record): RecordJson => ({
  coverage: Object.fromEntries(r.coverage),
  dates: Object.fromEntries(r.dates),
  logs: r.logs,
  declared: Object.fromEntries(r.declared),
  trips: Object.fromEntries(r.trips),
});

/**
 * 走行記録の保存先。MiniPC のサーバー(server/server.mjs)から開いたときはサーバーに保存して
 * 全端末で共有し、サーバーがないとき(npm run dev 単体など)はこのブラウザの中に保存する。
 */
export interface RecordStore {
  readonly shared: boolean;
  load(): Promise<Record>;
  /** 追加分を保存し、ほかの端末の分も含めた最新の記録を返す */
  add(added: Record): Promise<Record>;
  /**
   * 通った区間(coverage・dates)を次の記録で置き換え、ほかのもの(ログの履歴・自己申告・走行距離)は足す。
   * 保存したログで判定し直したとき、前の判定の誤りを消すのに使う
   */
  replaceCoverage(next: Record): Promise<Record>;
  clear(): Promise<void>;
  /** 走行ログそのものを残す(MiniPC のときだけ。あとで判定し直すため)。trip は一覧に出す日付と距離 */
  saveLog(name: string, text: string, trip?: Trip): Promise<void>;
  listLogs(): Promise<SavedLog[]>;
  loadLog(id: string): Promise<string>;
  /** 日付と距離のない(前から保存してある)ログに付ける */
  setLogTrip(id: string, trip: Trip): Promise<void>;
  /** ほかのツール(gbowl-log-formatter など)から自動で送られてきて、まだ判定していないログ */
  pendingLogs(): Promise<SavedLog[]>;
  /** これから判定するログを、まだ判定していない一覧から外す。ほかの端末が先に外していれば false */
  claimLog(id: string): Promise<boolean>;
  /** ログの運転評価(iPhone の走行ロガーのログで、DriveLog が評価を作ったものだけ。なければ null) */
  loadEval(id: string): Promise<DriveEval | null>;
  /** ログの天気。なければ null */
  loadWeather(id: string): Promise<DriveWeather | null>;
  /** 軌跡の点([UNIX秒, 緯度, 経度])を送って、MiniPC に天気を取ってもらう。取れなければ null */
  fetchWeather(id: string, points: [number, number, number][]): Promise<DriveWeather | null>;
  /** MiniPC のサーバーで判定している様子(サーバーがなければ null) */
  judgeStatus(): Promise<JudgeStatus | null>;
  /** 保存したログをすべて MiniPC のサーバーで判定し直す。始められなければ null */
  startRejudge(): Promise<JudgeStatus | null>;
}

/** サーバーでの判定 1 回分(判定し直し、または自動で送られてきたログの判定) */
export interface JudgeRun {
  kind: "rejudge" | "inbox";
  done: number;
  total: number;
  failed: string[];
  /** 通った区間の数 */
  passed: number;
  /** 判定中のログの名前 */
  current?: string;
  /** 判定し直しで、前の記録を置き換えたか(読めないログがあれば足すだけにする) */
  replaced?: boolean;
  startedAt: string;
  finishedAt?: string;
}

export interface JudgeStatus {
  /** サーバーで判定できるか(できなければブラウザで判定する) */
  enabled: boolean;
  /** サーバーの判定で記録が変わるたびに増える */
  rev: number;
  running: JudgeRun | null;
  last: JudgeRun | null;
  pending: number;
  rejudgeQueued: boolean;
}

export interface SavedLog {
  id: string;
  name: string;
  size: number;
  /** ログの日付と走行距離(m)。付ける前に保存したログにはない */
  date?: string;
  m?: number;
  /** 走り始めた時刻(UNIX ミリ秒)。時刻のないログや、まだ調べていないログにはない */
  start?: number;
  /** 運転評価の総合点(評価があるログだけ) */
  score?: number;
  /** 走ったときの天気のまとめ(MiniPC が取ったものだけ) */
  weather?: { icon: string; label: string; tMin: number | null; tMax: number | null };
}

/** 走ったときの天気の1地点(MiniPC が Open-Meteo から取った weather.json) */
export interface WeatherSample {
  /** UNIX 秒 */
  t: number;
  lat: number;
  lon: number;
  code: number | null;
  label: string;
  icon: string;
  temp: number | null;
  feels: number | null;
  humidity: number | null;
  /** その時刻を含む1時間の降水量(mm) */
  precip: number | null;
  snow: number | null;
  cloud: number | null;
  pressure: number | null;
  /** 風速・最大瞬間風速(m/s)と風向(度、北=0) */
  wind: number | null;
  windDir: number | null;
  gust: number | null;
  isDay: boolean | null;
}

export interface DriveWeather {
  source: string;
  api: "forecast" | "archive";
  fetchedAt: string;
  summary: {
    code: number;
    label: string;
    icon: string;
    tMin: number | null;
    tMax: number | null;
    precipMax: number | null;
    windMax: number | null;
    gustMax: number | null;
    rain: boolean;
    night: boolean;
    sunrise?: number;
    sunset?: number;
  };
  samples: WeatherSample[];
}

/** 運転評価の1項目(gbowl-log-formatter の drive_eval.py が作る evaluation.json) */
export interface DriveEvalItem {
  key: string;
  name: string;
  value: number;
  score: number;
  weight: number;
  good: number;
  bad: number;
}

/** 運転評価で点数を下げた出来事(急ブレーキ・急ハンドル・カックンなど) */
export interface DriveEvent {
  kind: string;
  type: string;
  value: number;
  unit: string;
  t_unix: number;
  lat: number;
  lon: number;
  kmh: number;
}

export interface DriveEval {
  score: number;
  items: DriveEvalItem[];
  moving_s: number;
  stops: number;
  events: DriveEvent[];
}

const LOGS_API = `${import.meta.env.BASE_URL}api/logs`;
const INBOX_API = `${import.meta.env.BASE_URL}api/inbox`;
const JUDGE_API = `${import.meta.env.BASE_URL}api/judge`;
const REJUDGE_API = `${import.meta.env.BASE_URL}api/rejudge`;

class ServerStore implements RecordStore {
  readonly shared = true;

  async load() {
    const res = await fetch(API);
    if (!res.ok) throw new Error(`記録を読み込めませんでした(${res.status})`);
    return toRecord(await res.json());
  }

  async add(added: Record) {
    const res = await fetch(API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(toJson(added)),
    });
    if (!res.ok) throw new Error(`記録を保存できませんでした(${res.status})`);
    return toRecord(await res.json());
  }

  async replaceCoverage(next: Record) {
    const res = await fetch(API, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(toJson(next)),
    });
    if (!res.ok) throw new Error(`記録を保存できませんでした(${res.status})`);
    return toRecord(await res.json());
  }

  async clear() {
    await fetch(API, { method: "DELETE" });
  }

  async saveLog(name: string, text: string, trip?: Trip) {
    const q = new URLSearchParams({ name });
    if (trip) {
      q.set("date", trip.date);
      q.set("m", String(trip.m));
      if (trip.start !== undefined) q.set("start", String(trip.start));
    }
    const res = await fetch(`${LOGS_API}?${q}`, { method: "POST", body: text });
    if (!res.ok) throw new Error(`ログを保存できませんでした(${res.status})`);
  }

  async setLogTrip(id: string, trip: Trip) {
    await fetch(`${LOGS_API}/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(trip) });
  }

  async listLogs(): Promise<SavedLog[]> {
    const res = await fetch(LOGS_API);
    return res.ok ? res.json() : [];
  }

  async loadLog(id: string) {
    const res = await fetch(`${LOGS_API}/${encodeURIComponent(id)}`);
    if (!res.ok) throw new Error(`ログを読み込めませんでした(${res.status})`);
    return res.text();
  }

  async pendingLogs(): Promise<SavedLog[]> {
    const res = await fetch(INBOX_API);
    return res.ok ? res.json() : [];
  }

  async loadEval(id: string): Promise<DriveEval | null> {
    const res = await fetch(`${LOGS_API}/${encodeURIComponent(id)}/eval`);
    return res.ok ? res.json() : null;
  }

  async loadWeather(id: string): Promise<DriveWeather | null> {
    const res = await fetch(`${LOGS_API}/${encodeURIComponent(id)}/weather`);
    return res.ok ? res.json() : null;
  }

  async fetchWeather(id: string, points: [number, number, number][]): Promise<DriveWeather | null> {
    const res = await fetch(`${LOGS_API}/${encodeURIComponent(id)}/weather`, { method: "POST", body: JSON.stringify({ points }) });
    return res.ok ? res.json() : null;
  }

  async claimLog(id: string) {
    const res = await fetch(`${INBOX_API}/${encodeURIComponent(id)}`, { method: "DELETE" });
    return res.ok && (await res.json()).claimed === true;
  }

  async judgeStatus(): Promise<JudgeStatus | null> {
    // 前の版のサーバー(判定しないもの)は 404 を返す
    const res = await fetch(JUDGE_API).catch(() => undefined);
    return res?.ok && res.headers.get("content-type")?.includes("json") ? res.json() : null;
  }

  async startRejudge(): Promise<JudgeStatus | null> {
    const res = await fetch(REJUDGE_API, { method: "POST" }).catch(() => undefined);
    return res?.ok && res.headers.get("content-type")?.includes("json") ? res.json() : null;
  }
}

class LocalStore implements RecordStore {
  readonly shared = false;

  async load(): Promise<Record> {
    try {
      return toRecord({
        coverage: JSON.parse(localStorage.getItem(KEY) ?? "{}"),
        dates: JSON.parse(localStorage.getItem(DATES_KEY) ?? "{}"),
        declared: JSON.parse(localStorage.getItem(DECLARED_KEY) ?? "{}"),
        trips: JSON.parse(localStorage.getItem(TRIPS_KEY) ?? "{}"),
        logs: JSON.parse(localStorage.getItem(LOGS_KEY) ?? "[]"),
      });
    } catch {
      return emptyRecord();
    }
  }

  async add(added: Record) {
    return this.save(mergeRecord(await this.load(), added));
  }

  async replaceCoverage(next: Record) {
    const cur = await this.load();
    return this.save(mergeRecord({ ...cur, coverage: new Map(), dates: new Map() }, next));
  }

  private save(merged: Record) {
    try {
      localStorage.setItem(KEY, JSON.stringify(Object.fromEntries(merged.coverage)));
      localStorage.setItem(DATES_KEY, JSON.stringify(Object.fromEntries(merged.dates)));
      localStorage.setItem(DECLARED_KEY, JSON.stringify(Object.fromEntries(merged.declared)));
      localStorage.setItem(TRIPS_KEY, JSON.stringify(Object.fromEntries(merged.trips)));
      localStorage.setItem(LOGS_KEY, JSON.stringify(merged.logs));
    } catch (e) {
      console.warn("走行記録を保存できませんでした", e);
    }
    return merged;
  }

  // ブラウザの保存領域は小さいので、ログそのものは残さない
  async saveLog() {}
  async listLogs(): Promise<SavedLog[]> {
    return [];
  }
  async loadLog(): Promise<string> {
    throw new Error("このブラウザにはログを保存していません");
  }
  async setLogTrip() {}
  async pendingLogs(): Promise<SavedLog[]> {
    return [];
  }
  async claimLog() {
    return false;
  }
  async loadEval() {
    return null;
  }
  async loadWeather() {
    return null;
  }
  async fetchWeather() {
    return null;
  }
  async judgeStatus() {
    return null;
  }
  async startRejudge() {
    return null;
  }

  async clear() {
    try {
      localStorage.removeItem(KEY);
      localStorage.removeItem(DATES_KEY);
      localStorage.removeItem(DECLARED_KEY);
      localStorage.removeItem(TRIPS_KEY);
      localStorage.removeItem(LOGS_KEY);
    } catch {
      /* 消せなくても表示は空にする */
    }
  }
}

/** 前に時刻を読み違えて 1970-01-01 などになった日付。記録には残さない(server/server.mjs と同じ) */
export const isBogusDay = (d: string | undefined) => typeof d === "string" && d < "2000";

export function mergeRecord(base: Record, add: Record): Record {
  const coverage = new Map(base.coverage);
  for (const [id, r] of add.coverage) coverage.set(id, Math.max(coverage.get(id) ?? 0, r));
  const dates = new Map(base.dates);
  for (const [id, d] of add.dates) {
    if (isBogusDay(d[0]) || isBogusDay(d[1])) continue;
    const cur = dates.get(id);
    dates.set(id, mergeDates(cur && !isBogusDay(cur[0]) && !isBogusDay(cur[1]) ? cur : undefined, d));
  }
  const declared = new Map(base.declared);
  for (const [ref, d] of add.declared) {
    const cur = declared.get(ref);
    if (!cur || d.at > cur.at) declared.set(ref, d);
  }
  // 同じログを読み直したら上書きする(二重に数えない)
  // 日付を読み違えていた分は捨てる(判定し直すと正しい日付で入り直す)
  const trips = new Map([...base.trips, ...add.trips].filter(([, t]) => !isBogusDay(t.date)));
  return { coverage, dates, logs: [...base.logs, ...add.logs], declared, trips };
}

/** 初めて通った日は早い方、最後に通った日は遅い方を残す(server/server.mjs と同じ規則) */
export function mergeDates(a: PassDates | undefined, b: PassDates): PassDates {
  if (!a) return b;
  return [a[0] < b[0] ? a[0] : b[0], a[1] > b[1] ? a[1] : b[1]];
}

/** サーバーがあればサーバー、なければブラウザ内の保存先を返す */
export async function openStore(): Promise<RecordStore> {
  try {
    const res = await fetch(API);
    const isJson = res.headers.get("content-type")?.includes("application/json");
    if (res.ok && isJson) {
      const server = new ServerStore();
      // このブラウザだけに残っていた記録があれば、共有の記録に移す
      const local = new LocalStore();
      const old = await local.load();
      if (old.coverage.size > 0) {
        await server.add(old);
        await local.clear();
      }
      return server;
    }
  } catch {
    /* サーバーなし */
  }
  return new LocalStore();
}

export function exportBackup(r: Record): string {
  return JSON.stringify(toJson(r));
}

export function importBackup(text: string): Record {
  return toRecord(JSON.parse(text));
}
