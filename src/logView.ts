// 「ログ」タブ: 保存してある走行ログの一覧と、選んだログの詳細(時間・速度・運転評価・通った道路)。
// HTML の文字列を作るだけで、イベントは main.ts で扱う
import { distance } from "./geo";
import { driveEvalView, esc, km, num, sortLogs } from "./gameView";
import type { DriveEval, DriveWeather, SavedLog } from "./store";
import { includedItems, journeyOf, periodList, showBox, tripRow, periodSummary, shortPeriod, type Journey, type Period, type PeriodItem } from "./period";
import { trackLength } from "./trips";
import { describeTrip, PANEL_MODES, tripDay, type ShowMode, type TravelTrip } from "./travel";
import { DATASET_LABELS, type Coverage, type DatasetKind, type RouteData, type TrackPoint } from "./types";

/** 速度はこの秒数ぶん離れた点どうしで求める(GPS の細かい揺れで速く見えないように) */
const SPEED_WINDOW_S = 5;
/** これより遅い間は止まっているとみなす(走行時間・平均速度に入れない) */
const MOVING_KMH = 5;
/** 時速これを超える値は GPS の飛びとして捨てる */
const MAX_KMH = 200;

export interface SpeedPoint {
  /** UNIX ミリ秒 */
  t: number;
  kmh: number;
}

export interface TripStats {
  start?: number;
  end?: number;
  /** 最初の点から最後の点まで(ミリ秒) */
  totalMs?: number;
  /** 走っていた時間(ミリ秒) */
  movingMs?: number;
  m: number;
  avgKmh?: number;
  maxKmh?: number;
  speeds: SpeedPoint[];
}

/** ログの時間・距離・速度。時刻のないログは距離だけ */
export function tripStats(track: TrackPoint[]): TripStats {
  const m = trackLength(track);
  const timed = track.filter((p): p is TrackPoint & { time: number } => p.time !== undefined);
  if (timed.length < 2) return { m, speeds: [] };
  const speeds: SpeedPoint[] = [];
  let j = 0;
  for (let i = 0; i < timed.length; i++) {
    while (j < i && timed[i].time - timed[j].time > SPEED_WINDOW_S * 1000) j++;
    const a = timed[j > 0 ? j - 1 : 0];
    const b = timed[i];
    const dt = (b.time - a.time) / 3_600_000;
    if (dt <= 0) continue;
    const kmh = distance([a.lon, a.lat], [b.lon, b.lat]) / 1000 / dt;
    if (kmh <= MAX_KMH) speeds.push({ t: b.time, kmh });
  }
  let movingMs = 0;
  for (let i = 1; i < speeds.length; i++) {
    const dt = speeds[i].t - speeds[i - 1].t;
    // 記録が途切れた間(トンネルなど)は、前後どちらかが走っていれば走っていたことにする
    if (speeds[i].kmh > MOVING_KMH || speeds[i - 1].kmh > MOVING_KMH) movingMs += dt;
  }
  const start = timed[0].time;
  const end = timed[timed.length - 1].time;
  return {
    start,
    end,
    totalMs: end - start,
    movingMs,
    m,
    avgKmh: movingMs > 0 ? m / 1000 / (movingMs / 3_600_000) : undefined,
    maxKmh: speeds.length ? Math.max(...speeds.map((s) => s.kmh)) : undefined,
    speeds,
  };
}

/** そのログで通った路線と距離(m)。距離は区間の長さ × 通った割合 */
export interface PassedRoute {
  kind: DatasetKind;
  ref: string;
  name: string;
  m: number;
}

/** datasets: 調べる道路データ(都道府県道は都道府県ごとのファイルを並べる) */
export function passedRoutes(
  coverage: Coverage,
  datasets: [DatasetKind, RouteData][],
  name: (kind: DatasetKind, ref: string, d: RouteData) => string,
): PassedRoute[] {
  const out: PassedRoute[] = [];
  for (const [kind, d] of datasets) {
    const byRef = new Map<string, number>();
    for (const s of d.segments) {
      const r = coverage.get(s.id);
      if (!r) continue;
      for (const ref of s.routes) byRef.set(ref, (byRef.get(ref) ?? 0) + s.len * r);
    }
    for (const [ref, m] of byRef) if (m >= 100) out.push({ kind, ref, name: name(kind, ref, d), m });
  }
  return out.sort((a, b) => b.m - a.m);
}

const pad = (n: number) => String(n).padStart(2, "0");
const hm = (t: number) => {
  const d = new Date(t);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const duration = (ms: number) => {
  const min = Math.round(ms / 60_000);
  return min >= 60 ? `${Math.floor(min / 60)}時間${pad(min % 60)}分` : `${min}分`;
};

/** 天気を取ってもらうために MiniPC に送る軌跡の点(時刻のある点を1分おきに)。[UNIX秒, 緯度, 経度] */
export function weatherPoints(track: TrackPoint[]): [number, number, number][] {
  const out: [number, number, number][] = [];
  let last = -Infinity;
  for (const p of track) {
    if (p.time === undefined || p.time - last < 60_000) continue;
    out.push([Math.round(p.time / 1000), Math.round(p.lat * 1e5) / 1e5, Math.round(p.lon * 1e5) / 1e5]);
    last = p.time;
  }
  const end = track.at(-1);
  if (end?.time !== undefined && end.time !== last) out.push([Math.round(end.time / 1000), end.lat, end.lon]);
  return out;
}

const temp = (v: number | null) => (v === null ? "—" : `${num(v, 1)}℃`);
const tempRange = (a: number | null, b: number | null) =>
  a === null || b === null ? "" : Math.round(a) === Math.round(b) ? `${Math.round(a)}℃` : `${Math.round(a)}〜${Math.round(b)}℃`;
const DIRS = ["北", "北東", "東", "南東", "南", "南西", "西", "北西"];
/** 風向(風が吹いてくる方角) */
const windDir = (deg: number | null) => (deg === null ? "" : `${DIRS[Math.round(deg / 45) % 8]}の風 `);

/** 一覧の行に出す天気(アイコンと気温) */
export const weatherBadge = (w: SavedLog["weather"]) =>
  w ? `<span class="wx-badge" title="${esc(w.label)}">${w.icon}${tempRange(w.tMin, w.tMax) ? ` ${tempRange(w.tMin, w.tMax)}` : ""}</span>` : "";

/** ログの詳細に出す天気 */
export function weatherView(w: DriveWeather | null | undefined): string {
  if (w === undefined) return `<p class="muted">天気を調べています…</p>`;
  if (w === null) return `<p class="muted">天気を取れませんでした(時刻のないログや、MiniPC がインターネットにつながっていないときなど)。</p>`;
  const s = w.summary;
  const facts = [
    `${s.icon} ${esc(s.label)}`,
    tempRange(s.tMin, s.tMax),
    s.precipMax ? `雨 最大 ${num(s.precipMax, 1)} mm/時` : "",
    s.windMax !== null ? `風 最大 ${num(s.windMax, 0)} m/s${s.gustMax ? `(瞬間 ${num(s.gustMax, 0)})` : ""}` : "",
  ].filter(Boolean);
  const sun = s.sunrise !== undefined && s.sunset !== undefined ? `<p class="muted">日の出 ${hm(s.sunrise * 1000)}・日の入り ${hm(s.sunset * 1000)}</p>` : "";
  const rows = w.samples
    .map(
      (x) => `<tr><td>${hm(x.t * 1000)}</td><td title="${esc(x.label)}">${x.icon} ${esc(x.label)}</td><td>${temp(x.temp)}</td>
        <td>${x.precip ? `${num(x.precip, 1)} mm` : "—"}</td><td>${x.wind === null ? "—" : `${windDir(x.windDir)}${num(x.wind, 0)} m/s`}</td></tr>`,
    )
    .join("");
  return `<p class="wx-summary">${facts.join("・")}</p>${sun}
    <details class="wx-detail"><summary>${w.samples.length} 地点の天気</summary>
    <table class="wx-table"><thead><tr><th>時刻</th><th>天気</th><th>気温</th><th>雨</th><th>風</th></tr></thead><tbody>${rows}</tbody></table></details>
    <p class="muted wx-note">${esc(w.source)} の${w.api === "archive" ? "過去データ(再解析)" : "気象モデルの値"}です(観測所の実測ではありません)。</p>`;
}

const W = 360;
const H = 140;
const PAD = { l: 36, r: 8, t: 8, b: 20 };

/** 速度のグラフ。出来事(急ブレーキなど)の時刻に印を付ける */
export function speedChart(speeds: SpeedPoint[], events: { t: number; label: string }[] = []): string {
  if (speeds.length < 2) return "";
  const t0 = speeds[0].t;
  const t1 = speeds[speeds.length - 1].t;
  if (t1 <= t0) return "";
  // 点が多いと重いので、横幅の2倍くらいまで間引く(区切りごとの最大をとって、速いところを潰さない)
  const n = W * 2;
  const bins: number[] = new Array(n).fill(-1);
  for (const s of speeds) {
    const i = Math.min(n - 1, Math.floor(((s.t - t0) / (t1 - t0)) * n));
    bins[i] = Math.max(bins[i], s.kmh);
  }
  const max = Math.max(60, Math.ceil(Math.max(...bins) / 20) * 20);
  const plotW = W - PAD.l - PAD.r;
  const plotH = H - PAD.t - PAD.b;
  const x = (t: number) => PAD.l + ((t - t0) / (t1 - t0)) * plotW;
  const y = (v: number) => PAD.t + plotH * (1 - v / max);
  let d = "";
  let pen = false;
  bins.forEach((v, i) => {
    if (v < 0) return;
    const px = PAD.l + ((i + 0.5) / n) * plotW;
    d += `${pen ? "L" : "M"}${px.toFixed(1)},${y(v).toFixed(1)}`;
    pen = true;
  });
  const grid = [];
  for (let v = 0; v <= max; v += max > 100 ? 40 : 20) {
    grid.push(`<line class="grid" x1="${PAD.l}" x2="${W - PAD.r}" y1="${y(v)}" y2="${y(v)}"/>
      <text class="tick" x="${PAD.l - 4}" y="${y(v) + 4}" text-anchor="end">${v}</text>`);
  }
  const marks = events
    .filter((e) => e.t >= t0 && e.t <= t1)
    .map(
      (e) => `<g class="hit"><line class="event-mark" x1="${x(e.t)}" x2="${x(e.t)}" y1="${PAD.t}" y2="${H - PAD.b}"/>
        <title>${hm(e.t)} ${esc(e.label)}</title></g>`,
    )
    .join("");
  return `<svg viewBox="0 0 ${W} ${H}" class="chart" role="img" aria-label="速度の変化">${grid.join("")}
    <path class="line" d="${d}"/>${marks}
    <text class="tick" x="${PAD.l}" y="${H - 5}">${hm(t0)}</text>
    <text class="tick" x="${W - PAD.r}" y="${H - 5}" text-anchor="end">${hm(t1)}</text></svg>`;
}

/** 選んだログの詳細。読み込み中の部分は undefined */
export interface LogDetail {
  log: SavedLog;
  stats?: TripStats;
  /** 読めなかったときの理由 */
  error?: string;
  ev?: DriveEval | null;
  /** 走ったときの天気。調べている間は undefined、取れなければ null */
  weather?: DriveWeather | null;
  /** 通った路線。調べている間は undefined、道路データがなければ null */
  routes?: PassedRoute[] | null;
  /** 移動手段を直している途中 */
  modeBusy?: boolean;
}

/** ログが何年のものか(日付のないものは "") */
const yearOf = (l: SavedLog) => l.date?.slice(0, 4) ?? "";

export function logYears(logs: SavedLog[]): string[] {
  return [...new Set(logs.map(yearOf))].sort((a, b) => (a === "" ? 1 : b === "" ? -1 : b.localeCompare(a)));
}

/** 一覧に出す順(新しい順・年で絞り込み)。前後のログへ移るときもこの順 */
export function shownLogs(logs: SavedLog[], year: string): SavedLog[] {
  return sortLogs(logs).filter((l) => year === "all" || yearOf(l) === year);
}

/** 「期間を指定」のときの一覧の中身(year が "range" のとき) */
export interface PeriodView {
  period: Period;
  items: PeriodItem[];
  /** 開始時刻が分かったログ */
  known: Set<string>;
  /** 地図に出している途中なら、その様子 */
  note?: string;
}

/** 一覧のチェック(地図に出すもの)と、期間を指定していない一覧に並べる旅の記録 */
export interface ShowView {
  /** 地図に出すもの(itemKey の値) */
  shown: Set<string>;
  /** 旅の記録(年で絞り込む前のすべて) */
  trips: TravelTrip[];
  /** 乗り物のタブ("all" ならすべて) */
  kind?: LogKind;
}

/** ログタブで選ぶ乗り物("all" ならすべて、"car" は自分の運転) */
export type LogKind = "all" | ShowMode;

/** 一覧の行(車のログ・旅の記録)の乗り物 */
const kindOfItem = (it: PeriodItem): ShowMode => (it.kind === "log" ? "car" : it.trip.mode);

/** 選んだ乗り物のものだけにする */
export const itemsOfKind = (items: PeriodItem[], kind: LogKind) => (kind === "all" ? items : items.filter((it) => kindOfItem(it) === kind));

/** 年の欄の下に出す乗り物のタブ。記録のない乗り物は出さない(選んでいるものは出す) */
export function kindTabs(items: PeriodItem[], kind: LogKind): string {
  const count = (k: ShowMode) => items.filter((it) => kindOfItem(it) === k).length;
  const tabs = [
    { id: "all" as LogKind, label: "すべて", n: items.length },
    ...PANEL_MODES.map((m) => ({ id: m.id as LogKind, label: `${m.icon} ${m.label}`, n: count(m.id) })),
  ].filter((t) => t.id === "all" || t.n > 0 || t.id === kind);
  return `<div class="kind-tabs" role="tablist" aria-label="乗り物">${tabs
    .map((t) => `<button type="button" role="tab" data-log-kind="${t.id}" aria-selected="${t.id === kind}">${t.label}<span class="n">${t.n}</span></button>`)
    .join("")}</div>`;
}

/** 年の欄で、保存した旅行を選んだときの値 */
export const journeyValue = (id: string) => `journey:${id}`;

/** ログタブの一覧。selectedId: 右に詳細を出しているログ */
export function logListPanel(
  logs: SavedLog[] | null,
  year: string,
  shared: boolean,
  selectedId?: string,
  period?: PeriodView,
  journeys: Journey[] = [],
  show: ShowView = { shown: new Set(), trips: [] },
): string {
  if (logs === null) return `<p class="muted">読み込み中…</p>`;
  if (!shared) {
    return `<p class="muted">ログを残せるのは、MiniPC のサーバーで開いたときだけです(このブラウザだけで使っているときは、読み込んだログを保存しません)。</p>`;
  }
  if (logs.length === 0) return `<p class="muted">保存してあるログはまだありません。読み込んだログや、iPhone のロガーから送られたログがここに並びます。</p>`;
  const years = logYears(logs);
  const journey = year === "range" && period ? journeyOf(journeys, period.period) : undefined;
  const select = `<label class="pref-select">年
      <select id="log-year"><option value="all"${year === "all" ? " selected" : ""}>すべて</option>${years
        .map((y) => `<option value="${y}"${y === year ? " selected" : ""}>${y === "" ? "日付なし" : `${y}年`}</option>`)
        .join("")}<option value="range"${year === "range" && !journey ? " selected" : ""}>期間を指定(旅行など)</option>${
        journeys.length
          ? `<optgroup label="保存した旅行">${journeys
              .map((j) => `<option value="${esc(journeyValue(j.id))}"${j === journey ? " selected" : ""}>🧳 ${esc(j.name)}(${shortPeriod(j)})</option>`)
              .join("")}</optgroup>`
          : ""
      }</select></label>`;
  const kind = show.kind ?? "all";
  if (year === "range" && period) {
    const p = period.period;
    const items = itemsOfKind(period.items, kind);
    const save = journey
      ? `<div class="journey-row"><span class="journey-name">🧳 ${esc(journey.name)}</span>
          <button id="journey-rename" type="button" class="secondary">名前を変える</button>
          <button id="journey-delete" type="button" class="secondary" data-journey="${esc(journey.id)}">消す</button></div>`
      : `<form id="journey-save" class="journey-row">
          <input id="journey-name" type="text" maxlength="60" placeholder="旅行の名前(例: 九州旅行)" aria-label="旅行の名前" />
          <button type="submit" class="secondary">この期間を保存</button></form>`;
    return `${select}
      <div class="period-pick">
        <input id="log-from" type="date" value="${esc(p.from)}" aria-label="いつから" /> 〜
        <input id="log-to" type="date" value="${esc(p.to)}" aria-label="いつまで" />
      </div>
      ${save}
      ${kindTabs(includedItems(period.items, journey?.exclude), kind)}
      <p class="muted">${periodSummary(includedItems(items, journey?.exclude))}</p>
      <p class="muted">左のチェックを入れたものを地図に出します。地図右下の「旅」で、運転・電車などの手段ごとにまとめて切り替えられます(はじめは運転だけ)。${period.note ? ` ${esc(period.note)}` : ""}</p>
      ${period.items.length ? `<div class="period-buttons"><button id="period-fit" type="button" class="secondary">この期間の全体を表示</button>
        <button id="share-card" type="button" class="secondary" title="地図に出している経路とまとめを1枚の画像にする">📷 まとめ画像</button></div>` : ""}
      ${journey ? `<p class="muted">× で、この旅行から外せます(ログは消えません)。</p>` : ""}
      ${periodList(items, period.known, selectedId, journey ? new Set(journey.exclude ?? []) : null, show.shown)}`;
  }
  // 年で絞り込んだ車のログと旅の記録
  const yearLogs = shownLogs(logs, year);
  const yearTrips = show.trips.filter((t) => year === "all" || tripDay(t).slice(0, 4) === year);
  const all: PeriodItem[] = [
    ...yearLogs.map((log): PeriodItem => ({ kind: "log", log, day: log.date ?? "", start: log.start ?? -1 })),
    ...yearTrips.map((trip): PeriodItem => ({ kind: "trip", trip, day: tripDay(trip), start: trip.start ? Date.parse(trip.start) : -1 })),
  ];
  const items = itemsOfKind(all, kind);
  const shown = items.flatMap((it) => (it.kind === "log" ? [it.log] : []));
  const trips = items.flatMap((it) => (it.kind === "trip" ? [it.trip] : []));
  const total = shown.reduce((s, l) => s + (l.m ?? 0), 0);
  const scored = shown.filter((l) => l.score !== undefined);
  const avg = scored.length ? scored.reduce((s, l) => s + l.score!, 0) / scored.length : undefined;
  const avgText = avg !== undefined ? `・運転の平均 ${num(avg, 0)} 点(${scored.length} 本)` : "";
  // すべて: 乗り物ごとの本数と距離。運転: 本数・距離・点数。ほかの乗り物: 回数と距離
  const summary =
    kind === "all"
      ? `${periodSummary(items).replace("この期間の記録はありません", "記録はありません")}${avgText}`
      : kind === "car"
        ? `${shown.length} 本・${km(total, 0)} km${avgText}`
        : `${trips.length} 回・${km(trips.reduce((s, t) => s + t.m, 0), 0)} km`;
  // 車のログと旅の記録を、日付・時刻の新しい順に混ぜて並べる(車のログどうしは sortLogs の順のまま)
  const rows: { day: string; start: number; html: string }[] = shown.map((l) => ({
    day: l.date ?? "",
    start: l.start ?? -1,
    html: `<li${l.id === selectedId ? ` class="selected" aria-current="true"` : ""}>${showBox(`log:${l.id}`, show.shown.has(`log:${l.id}`))}<a href="#" data-log-open="${esc(l.id)}">
          <span class="muted">${l.date ?? "日付なし"}${l.start !== undefined ? ` ${hm(l.start)}` : ""}</span>
          <span class="log-name">🚗 ${esc(l.name)}</span>
          <span class="muted">${l.m !== undefined ? `${km(l.m)} km` : ""}</span>
          ${weatherBadge(l.weather)}
          ${l.score !== undefined ? `<span class="eval-badge ${grade(l.score)}">${Math.round(l.score)} 点</span>` : ""}</a></li>`,
  }));
  for (const t of trips) {
    rows.push({ day: tripDay(t), start: t.start ? Date.parse(t.start) : -1, html: tripRow(t, show.shown.has(`trip:${t.id}`)) });
  }
  rows.sort((a, b) => (a.day === b.day ? b.start - a.start : a.day === "" ? 1 : b.day === "" ? -1 : b.day.localeCompare(a.day)));
  const checked = show.shown.size;
  return `${select}
    ${kindTabs(all, kind)}
    <p class="muted">${summary}</p>
    <p class="muted">左のチェックを入れたログだけを地図に出します。${checked ? `(${checked} 本を表示中 <button id="show-clear" type="button" class="link">すべて外す</button>・<button id="share-card" type="button" class="link">📷 まとめ画像</button>)` : ""}</p>
    <ol class="log-list" data-scroll="logs">${rows.map((r) => r.html).join("")}</ol>`;
}

const grade = (score: number) => (score >= 80 ? "good" : score >= 50 ? "fair" : "poor");

/** 詳細の上に出す、前後のログへ移るボタンのための情報 */
export interface LogNav {
  /** 一覧で上(新しい方)・下(古い方)のログ */
  prev?: string;
  next?: string;
  /** 一覧の何番目か(1から)。一覧にないときは undefined */
  index?: number;
  count: number;
  /** スマホで地図を広く表示しているか(たたむボタンの向き) */
  folded: boolean;
}

/** 選んだログの詳細(地図の右の枠に出す) */
export function logDetailPanel(d: LogDetail, nav: LogNav = { count: 0, folded: false }): string {
  const s = d.stats;
  const navBtn = (id: string, to: string | undefined, label: string, text: string) =>
    `<button type="button" id="${id}" class="nav" aria-label="${label}"${to ? ` data-log-open="${esc(to)}"` : " disabled"}>${text}</button>`;
  const head = `<div class="detail-head">
      ${navBtn("log-prev", nav.prev, "新しいログへ", "‹")}
      <span class="muted log-pos">${nav.index !== undefined ? `${nav.index} / ${nav.count}` : ""}</span>
      ${navBtn("log-next", nav.next, "古いログへ", "›")}
      <span class="spacer"></span>
      <button id="log-share" type="button" aria-label="まとめ画像" title="経路とまとめを1枚の画像にする">📷</button>
      <button id="detail-fold" type="button" aria-label="${nav.folded ? "詳細を開く" : "地図を広く表示"}">${nav.folded ? "▾" : "▴"}</button>
      <button id="detail-close" type="button" aria-label="閉じる">×</button></div>
    <h2 class="log-title">${esc(d.log.name)}</h2>`;
  if (d.error) return `${head}<p class="muted">読み込めませんでした: ${esc(d.error)}</p>`;
  if (!s) return `${head}<p class="muted">読み込み中…</p>`;
  const session = sessionOfLog(d.log.name);
  const facts: [string, string][] = [];
  facts.push(["日付", d.log.date ?? "日付なし"]);
  if (s.start !== undefined && s.end !== undefined) facts.push(["時刻", `${hm(s.start)}〜${hm(s.end)}`]);
  facts.push(["距離", `${km(s.m)} km`]);
  if (s.totalMs !== undefined) facts.push(["かかった時間", duration(s.totalMs)]);
  if (s.movingMs !== undefined) facts.push(["走っていた時間", duration(s.movingMs)]);
  if (s.avgKmh !== undefined) facts.push(["平均速度", `${num(s.avgKmh, 0)} km/h`]);
  if (s.maxKmh !== undefined) facts.push(["最高速度", `${num(s.maxKmh, 0)} km/h`]);
  const events = d.ev?.events.map((e) => ({ t: e.t_unix * 1000, label: e.kind })) ?? [];
  const chart = speedChart(s.speeds, events);
  const evalPart =
    d.log.score === undefined
      ? ""
      : `<h3>運転評価</h3>${driveEvalView({ id: d.log.id, ev: d.ev })}`;
  const routes = routesView(d.routes);
  return `${head}
    <dl class="facts">${facts.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("")}</dl>
    ${session ? modePicker(session, "car", d.modeBusy) : ""}
    ${chart ? `<h3>速度 <span class="muted">(km/h${events.length ? "・縦線は出来事" : ""})</span></h3>${chart}` : ""}
    ${s.start !== undefined ? `<h3>天気</h3>${weatherView(d.weather)}` : ""}
    ${evalPart}
    <h3>通った道路</h3>${routes}`;
}

/** 通った道路の一覧。調べている間は undefined、道路データがなければ null */
function routesView(routes: PassedRoute[] | null | undefined): string {
  return (
    routes === undefined
      ? `<p class="muted">通った道路を調べています…</p>`
      : routes === null
        ? `<p class="muted">道路データを読み込んでから調べます。</p>`
        : routes.length === 0
          ? `<p class="muted">国道・高速道路・都道府県道は通っていません。</p>`
          : (["kokudo", "expressway", "prefroad"] as DatasetKind[])
              .map((kind) => {
                const list = routes.filter((r) => r.kind === kind);
                if (!list.length) return "";
                return `<h4>${DATASET_LABELS[kind]} <span class="muted">${list.length} 路線</span></h4>
                  <ul class="passed">${list
                    .map(
                      (r) => `<li>${
                        // 都道府県道は、表示している都道府県が違うと地図に出せないので、名前だけにする
                        kind === "prefroad" ? esc(r.name) : `<a href="#" data-route="${esc(r.ref)}" data-kind="${kind}">${esc(r.name)}</a>`
                      }
                        <span class="muted">${km(r.m)} km</span></li>`,
                    )
                    .join("")}</ul>`;
              })
              .join("")
  );
}

/** iPhone のロガーのログ(名前が「<走行ID>.gpx」)なら走行 ID。それ以外(GBowl・GoPro など)は undefined */
export const sessionOfLog = (name: string) => /^(\d{8}-\d{6})\.gpx$/i.exec(name)?.[1];

/**
 * 移動手段を直す欄(iPhone のロガーの記録だけ)。変えると MiniPC が走行フォルダを移し、
 * 車にしたら国道の判定に足し、車でなくしたら判定から外す
 */
export function modePicker(session: string, mode: ShowMode, busy = false): string {
  return `<div class="mode-fix">
      <label>移動手段
        <select id="session-mode" data-session="${esc(session)}" data-mode="${mode}"${busy ? " disabled" : ""}>${PANEL_MODES.map(
          (m) => `<option value="${m.id}"${m.id === mode ? " selected" : ""}>${m.icon} ${m.label}</option>`,
        ).join("")}</select></label>
      ${busy ? `<span class="muted">直しています…</span>` : ""}
      <p class="muted">間違えていたら選び直してください。運転にすると国道の制覇に入り、ほかにすると制覇から外します。</p></div>`;
}

/** 旅の記録の詳細のうち、MiniPC から読むもの。読み込み中の部分は undefined */
export interface TripDetailData {
  stats?: TripStats;
  error?: string;
  /** 同乗の運転評価(なければ null) */
  ev?: (DriveEval & { mount?: string; usable_ratio?: number; axes_quality?: number }) | null;
  weather?: DriveWeather | null;
  /** 通った道路(同乗だけ調べる) */
  routes?: PassedRoute[] | null;
}

/** 同乗の評価の端末の置き方の説明(アプリの表示と同じ) */
function mountNote(ev: { mount?: string; usable_ratio?: number; axes_quality?: number }): string {
  if (ev.mount === "hand") {
    const r = ev.usable_ratio ?? 0;
    return `<p class="mount-note${r < 0.5 ? " warn" : ""}">✋ 手持ちで記録(参考値)・採点に使えた時間 ${Math.round(r * 100)}%${
      r < 0.5 ? "<br><span class=\"muted\">端末を動かした時間が長く、躍度・急な操作・止まり際・カーブの確かさが下がります</span>" : ""
    }</p>`;
  }
  const fixed = ev.mount === "fixed" ? `<p class="mount-note">📱 端末を固定して記録(同乗)</p>` : "";
  const loose =
    typeof ev.axes_quality === "number" && ev.axes_quality < 0.5
      ? `<p class="mount-note warn">⚠ 端末の固定が甘かったかもしれません(点数の確かさが下がります)</p>`
      : "";
  return fixed + loose;
}

/** 旅の記録(電車・飛行機・同乗など)を選んだときの詳細。同乗は運転と同じように評価・通った道路も出す */
export function tripDetailPanel(t: TravelTrip, busy = false, d: TripDetailData = {}): string {
  const [title, ...lines] = describeTrip(t);
  const head = `<div class="detail-head">
      <span class="spacer"></span>
      <button id="detail-fold" type="button" aria-label="地図を広く表示">▴</button>
      <button id="detail-close" type="button" aria-label="閉じる">×</button></div>
    <h2 class="log-title">${esc(title)}</h2>`;
  const s = d.stats;
  const facts: [string, string][] = [];
  if (s) {
    if (s.movingMs !== undefined) facts.push(["動いていた時間", duration(s.movingMs)]);
    if (s.avgKmh !== undefined) facts.push(["平均速度", `${num(s.avgKmh, 0)} km/h`]);
    if (s.maxKmh !== undefined) facts.push(["最高速度", `${num(s.maxKmh, 0)} km/h`]);
  }
  const ride = t.mode === "ride";
  const events = d.ev?.events.map((e) => ({ t: e.t_unix * 1000, label: e.kind })) ?? [];
  const chart = s ? speedChart(s.speeds, events) : "";
  const evalPart =
    ride && (t.score !== undefined || d.ev)
      ? `<h3>運転評価 <span class="muted">(同乗)</span></h3>${driveEvalView({ id: `trip:${t.id}`, ev: d.ev })}${d.ev ? mountNote(d.ev) : ""}`
      : "";
  const loading = !s && !d.error ? `<p class="muted">読み込み中…</p>` : "";
  return `${head}
    ${lines.map((l) => `<p>${esc(l)}</p>`).join("")}
    ${facts.length ? `<dl class="facts">${facts.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("")}</dl>` : ""}
    <p class="muted">走行 ID: ${esc(t.id)}</p>
    ${modePicker(t.id, t.mode, busy)}
    ${d.error ? `<p class="muted">詳しい記録を読み込めませんでした: ${esc(d.error)}</p>` : loading}
    ${chart ? `<h3>速度 <span class="muted">(km/h${events.length ? "・縦線は出来事" : ""})</span></h3>${chart}` : ""}
    ${s?.start !== undefined && t.mode !== "plane" ? `<h3>天気</h3>${weatherView(d.weather)}` : ""}
    ${evalPart}
    ${ride && s ? `<h3>通った道路</h3>${routesView(d.routes)}` : ""}`;
}
