// ログタブの「期間を指定」: 旅行などの期間に入る車のログと旅の記録(電車・飛行機など)をまとめて一覧にする。
// HTML の文字列を作るだけで、イベントは main.ts で扱う
import { esc, km } from "./gameView";
import type { SavedLog } from "./store";
import { TRIP_MODES, tripDay, type TravelTrip } from "./travel";

export interface Period {
  /** YYYY-MM-DD(両端を含む) */
  from: string;
  to: string;
}

const KEY = "kokudo-log-period";
const DAY = /^\d{4}-\d{2}-\d{2}$/;

export function loadPeriod(): Period | null {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "null");
    if (v && DAY.test(v.from) && DAY.test(v.to)) return { from: v.from, to: v.to };
  } catch {
    // 保存できないブラウザでは毎回指定する
  }
  return null;
}

export function savePeriod(p: Period) {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    // 保存できなくても絞り込みはできる
  }
}

/** 入力された2つの日付から期間を作る。逆に入れられたら入れ替える。どちらかが空なら、もう一方の1日だけ */
export function makePeriod(a: string, b: string): Period | null {
  const x = DAY.test(a) ? a : DAY.test(b) ? b : null;
  const y = DAY.test(b) ? b : x;
  if (!x || !y) return null;
  return x <= y ? { from: x, to: y } : { from: y, to: x };
}

/** 名前を付けて保存した期間(旅行)。MiniPC の data/journeys.json にある */
export interface Journey extends Period {
  id: string;
  name: string;
  /** この旅行から外したもの(itemKey の値) */
  exclude?: string[];
}

const API = `${import.meta.env.BASE_URL}api/journeys`;

export async function fetchJourneys(): Promise<Journey[]> {
  const r = await fetch(API);
  return r.ok && r.headers.get("content-type")?.includes("json") ? r.json() : [];
}

export async function addJourney(name: string, p: Period): Promise<Journey[]> {
  const r = await fetch(API, { method: "POST", body: JSON.stringify({ name, ...p }) });
  if (!r.ok) throw new Error(((await r.json().catch(() => ({}))) as { error?: string }).error ?? `保存できませんでした(${r.status})`);
  return r.json();
}

export async function deleteJourney(id: string): Promise<Journey[]> {
  const r = await fetch(`${API}/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!r.ok) throw new Error(`消せませんでした(${r.status})`);
  return r.json();
}

/** 旅行から外すものを変える */
export async function setJourneyExclude(id: string, exclude: string[]): Promise<Journey[]> {
  const r = await fetch(`${API}/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ exclude }) });
  if (!r.ok) throw new Error(`保存できませんでした(${r.status})`);
  return r.json();
}

/** いまの期間と同じ旅行 */
export const journeyOf = (list: Journey[], p: Period) => list.find((j) => j.from === p.from && j.to === p.to);

/** 「11/7〜11/10」の形(年が今年でなければ年も) */
export function shortPeriod(p: Period, thisYear = String(new Date().getFullYear())): string {
  const f = (d: string) => (d.slice(0, 4) === thisYear ? `${Number(d.slice(5, 7))}/${Number(d.slice(8))}` : `${d.slice(0, 4)}/${Number(d.slice(5, 7))}/${Number(d.slice(8))}`);
  return p.from === p.to ? f(p.from) : `${f(p.from)}〜${f(p.to)}`;
}

export const inPeriod = (day: string | undefined, p: Period) => !!day && day >= p.from && day <= p.to;

/** 一覧の1行。start: 並べる順(UNIX ミリ秒。分からなければ日付の0時) */
export type PeriodItem = { kind: "log"; log: SavedLog; day: string; start: number } | { kind: "trip"; trip: TravelTrip; day: string; start: number };

const dayStart = (day: string) => Date.parse(`${day}T00:00:00+09:00`);

/**
 * 期間に入るログと移動を、古い順(旅行の順)に並べる。
 * starts: 軌跡を読んで分かったログの開始時刻(UNIX ミリ秒)。分からないログはその日の0時として並べる
 */
export function periodItems(logs: SavedLog[], trips: TravelTrip[], p: Period, starts: Map<string, number> = new Map()): PeriodItem[] {
  const items: PeriodItem[] = [];
  for (const log of logs) {
    if (!inPeriod(log.date, p)) continue;
    items.push({ kind: "log", log, day: log.date!, start: log.start ?? starts.get(log.id) ?? dayStart(log.date!) });
  }
  for (const trip of trips) {
    const day = tripDay(trip);
    if (!inPeriod(day, p)) continue;
    items.push({ kind: "trip", trip, day, start: trip.start ? Date.parse(trip.start) : dayStart(day) });
  }
  return items.sort((a, b) => a.start - b.start || (a.kind === "log" ? a.log.id : a.trip.id).localeCompare(b.kind === "log" ? b.log.id : b.trip.id));
}

const hm = (ms: number) => {
  const d = new Date(ms + 9 * 3600_000);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
};

/** 期間の合計(車・手段ごとの本数と距離) */
export function periodSummary(items: PeriodItem[]): string {
  const parts: string[] = [];
  const cars = items.filter((i) => i.kind === "log");
  if (cars.length) parts.push(`🚗 車 ${cars.length}本 ${km(cars.reduce((s, i) => s + (i.kind === "log" ? (i.log.m ?? 0) : 0), 0), 0)} km`);
  for (const m of TRIP_MODES) {
    const list = items.filter((i) => i.kind === "trip" && i.trip.mode === m.id);
    if (list.length) parts.push(`${m.icon} ${m.label} ${list.length}回 ${km(list.reduce((s, i) => s + (i.kind === "trip" ? i.trip.m : 0), 0), 0)} km`);
  }
  const total = items.reduce((s, i) => s + (i.kind === "log" ? (i.log.m ?? 0) : i.trip.m), 0);
  return parts.length ? `${parts.join("・")}(合計 ${km(total, 0)} km)` : "この期間の記録はありません";
}

/** 旅行から外すときに覚えておく名前(車のログは "log:<ログ ID>"、旅の記録は "trip:<走行 ID>") */
export const itemKey = (it: PeriodItem) => (it.kind === "log" ? `log:${it.log.id}` : `trip:${it.trip.id}`);

/** 外したものを除いた一覧(地図・合計・前後の移動に使う) */
export const includedItems = (items: PeriodItem[], exclude: Iterable<string> | undefined) => {
  const out = new Set(exclude ?? []);
  return out.size ? items.filter((it) => !out.has(itemKey(it))) : items;
};

/**
 * 期間の一覧。日ごとに見出しを付ける。
 * known: 開始時刻が分かったログ(時刻を出す)。selectedId: 右に詳細を出しているログ。
 * exclude: 保存した旅行を開いているときの、外したもの。null なら外すボタンを出さない(名前を付けていない期間)
 */
export function periodList(items: PeriodItem[], known: Set<string>, selectedId?: string, exclude: Set<string> | null = null): string {
  const row = (it: PeriodItem, out: boolean) => {
    const key = itemKey(it);
    const btn =
      exclude === null
        ? ""
        : out
          ? `<button type="button" class="exclude" data-include="${esc(key)}" title="旅行に戻す" aria-label="旅行に戻す">↩</button>`
          : `<button type="button" class="exclude" data-exclude="${esc(key)}" title="この旅行から外す" aria-label="この旅行から外す">×</button>`;
    if (it.kind === "log") {
      const l = it.log;
      const cls = [l.id === selectedId ? "selected" : "", out ? "excluded" : ""].filter(Boolean).join(" ");
      return `<li${cls ? ` class="${cls}"` : ""}${l.id === selectedId ? ` aria-current="true"` : ""}><a href="#" data-log-open="${esc(l.id)}">
        <span class="muted">${out ? esc(it.day.slice(5)) + " " : ""}${known.has(l.id) ? hm(it.start) : ""}</span>
        <span class="log-name">🚗 ${esc(l.name)}</span>
        <span class="muted">${l.m !== undefined ? `${km(l.m)} km` : ""}</span></a>${btn}</li>`;
    }
    const t = it.trip;
    const m = TRIP_MODES.find((x) => x.id === t.mode) ?? TRIP_MODES[3];
    return `<li class="period-trip${out ? " excluded" : ""}"><a href="#" data-trip-open="${esc(t.id)}">
        <span class="muted">${out ? esc(it.day.slice(5)) + " " : ""}${t.start ? hm(it.start) : ""}</span>
        <span class="log-name"><span class="travel-swatch" style="background:${m.color}"></span> ${m.icon} ${m.label}</span>
        <span class="muted">${km(t.m)} km</span></a>${btn}</li>`;
  };
  let day = "";
  const rows: string[] = [];
  const outs: PeriodItem[] = [];
  for (const it of items) {
    if (exclude?.has(itemKey(it))) {
      outs.push(it);
      continue;
    }
    if (it.day !== day) {
      day = it.day;
      const wd = "日月火水木金土"[new Date(`${day}T00:00:00Z`).getUTCDay()];
      rows.push(`<li class="period-day">${esc(day)}(${wd})</li>`);
    }
    rows.push(row(it, false));
  }
  const list = `<ol class="log-list period-list" data-scroll="logs">${rows.join("")}</ol>`;
  if (!outs.length) return list;
  return `${list}<details class="period-excluded"><summary>この旅行から外したもの(${outs.length})</summary>
    <ol class="log-list period-list">${outs.map((it) => row(it, true)).join("")}</ol></details>`;
}
