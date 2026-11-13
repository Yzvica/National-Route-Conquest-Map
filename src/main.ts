import "./style.css";
import { categoryBreakdown, nicknamesOf, overlapsOf, type BreakdownItem } from "./breakdown";
import {
  buildContext,
  computeLevel,
  evaluateAchievements,
  regionTitle,
  summarize,
  type DatasetSummary,
  type GameContext,
} from "./game";
import { achievementsView, esc, levelCard, prefsView, reviewView, suggestionsView } from "./gameView";
import { logDetailPanel, logListPanel, passedRoutes, sessionOfLog, shownLogs, tripDetailPanel, tripStats, weatherPoints, type LogDetail, type LogKind, type PassedRoute } from "./logView";
import {
  addMapControls,
  addRoutes,
  clearRoutes,
  createMap,
  fitPref,
  fitSegments,
  paintCoverage,
  showFocus,
  showPrefFill,
  showSelected,
  showPeriodTracks,
  fitBox,
  showTrack,
  showDriveEvents,
  flyToEvent,
  type PrefShapes,
} from "./map";
import { judgeLog, logDate, matchAll, parseTrackText, type JudgeData } from "./judge";
import { REGIONS, prefName } from "./prefs";
import { comparePrefRefs, mergePrefData, prefFileName, prefRouteLabel, prefsOfTrack, splitPrefRef } from "./prefroads";
import { isSplitIndex, openSplit } from "./splitData";
import { trackLength, trackStart, type Trip } from "./trips";
import { distance } from "./geo";
import { addTravelLayer, changeSessionMode, loadTravelTrips, PANEL_MODES, refreshTravelPanel, setTravelHooks, showOnlyTrips, travelModes, tripBounds, type ShowMode, type TravelTrip } from "./travel";
import { addJourney, deleteJourney, fetchJourneys, includedItems, itemKey, journeyOf, setJourneyExclude, loadPeriod, makePeriod, periodItems, savePeriod, type Journey, type Period, type PeriodItem } from "./period";
import { carColor, composeCard, cardFileName, logCardInfo, mergeRoutes, openCardModal, periodCardInfo, renderRouteMap, tripLines, type CardInfo, type CardLine } from "./shareCard";
import { REFERENCE_CATS, SEPARATE_CATS, applyDeclared, computeStats, effectiveCoverage, percent, type Progress } from "./stats";
import { emptyRecord, exportBackup, importBackup, mergeRecord, openStore, type DriveEval, type DriveEvent, type DriveWeather, type JudgeRun, type Record, type SavedLog } from "./store";
import {
  CATEGORY_LABELS,
  DATASET_LABELS,
  type Category,
  type Coverage,
  type DatasetKind,
  type PrefRoadIndex,
  type RouteData,
  type TrackPoint,
} from "./types";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const status = $("status");

let record: Record = emptyRecord();
const storePromise = openStore();
/** 読み込んだ道路データ(国道・高速道路と、都道府県道は選んだ都道府県の分をまとめたもの) */
const datasets: Partial<{ [K in DatasetKind]: RouteData }> = {};
const DATA_FILES: { [K in DatasetKind]: string } = {
  kokudo: "routes.json",
  expressway: "expressways.json",
  prefroad: "prefroads/index.json",
};
/** 画面に出しているデータ */
let active: DatasetKind = "kokudo";
let data: RouteData | null = null;
/** 選んでいる路線(国道番号か、高速道路の名前) */
let selected: string | null = null;
/** 種別ごとの内訳で開いているもの(描き直しても開いたままにする) */
const openCats = new Set<Category>();
/** 詳細で押した種別(その区間を地図で縁取る) */
let detailCat: Category | null = null;
/** 内訳の行(data-item)から、その区間を引けるようにしておく */
let breakdownItems = new Map<string, BreakdownItem>();
/** 内訳を出す種別。現道は路線一覧と同じになるので出さない */
const BREAKDOWN_CATS: Category[] = (Object.keys(CATEGORY_LABELS) as Category[]).filter((c) => c !== "main");

const map = createMap($("map"));
addMapControls(map, (lines) => toast(lines));
// toLocaleString は呼ぶたびに書式を作り直して遅い(一覧の描き直しで数百回呼ぶ)ので、書式は一度だけ作る
const kmFormat = new Intl.NumberFormat("ja-JP", { maximumFractionDigits: 1 });
const km = (m: number) => kmFormat.format(m / 1000);
const routeName = (ref: string) =>
  active === "prefroad"
    ? prefRouteLabel(ref, data?.routes[ref]?.name, prefName)
    : (data?.routes[ref]?.name ?? (active === "kokudo" ? `国道${ref}号` : ref));
const BASE = import.meta.env.BASE_URL;

/** 上下線のどちらかを走れば両方走ったことにし、点線国道は自己申告に置き換えた記録 */
const coverage = (): Coverage => (data ? coverageFor(data) : record.coverage);

/** 点線国道を走ったと申告している国道 */
const declaredRefs = () => new Set([...record.declared].filter(([, d]) => d.on).map(([ref]) => ref));

/** データごとの、画面で使う記録。記録が変わったときだけ作り直す */
const effectiveCache = new WeakMap<RouteData, { raw: Coverage; declared: Record["declared"]; cov: Coverage }>();
function coverageFor(d: RouteData): Coverage {
  const hit = effectiveCache.get(d);
  if (hit?.raw === record.coverage && hit.declared === record.declared) return hit.cov;
  const cov = applyDeclared(d, effectiveCoverage(d, record.coverage), declaredRefs());
  effectiveCache.set(d, { raw: record.coverage, declared: record.declared, cov });
  return cov;
}

/** 点線国道を走ったかの自己申告を切り替える */
async function declareDotted(ref: string, on: boolean) {
  const store = await storePromise;
  const before = gameState();
  const added = emptyRecord();
  added.declared.set(ref, { on, at: new Date().toISOString() });
  record = await store.add(added);
  render();
  announce(before);
}

/**
 * 中身を作り直すとスクロールしていた一覧が先頭に戻ってしまうので、
 * data-scroll を付けた一覧(と枠そのもの)の位置を覚えておいて戻す
 */
function keepScroll(fn: () => void) {
  const roots = ["panel", "detail", "game-body"].map((id) => $(id));
  const saved = new Map<string, number>();
  for (const el of document.querySelectorAll<HTMLElement>("[data-scroll]")) saved.set(el.dataset.scroll!, el.scrollTop);
  const rootTops = roots.map((el) => el.scrollTop);
  fn();
  for (const el of document.querySelectorAll<HTMLElement>("[data-scroll]")) {
    const top = saved.get(el.dataset.scroll!);
    if (top) el.scrollTop = top;
  }
  roots.forEach((el, i) => (el.scrollTop = rootTops[i]));
}

// ---- ゲーム要素(実績・レベル・おすすめ・振り返り・都道府県) ----

/** 記録が変わったときだけ作り直す */
let gameCache: { cov: Coverage; dates: Record["dates"]; declared: Record["declared"]; n: number; ctx: GameContext } | null = null;
function gameContext(): GameContext {
  const n = Object.keys(datasets).length;
  if (
    gameCache?.cov !== record.coverage ||
    gameCache.dates !== record.dates ||
    gameCache.declared !== record.declared ||
    gameCache.n !== n
  ) {
    gameCache = {
      cov: record.coverage,
      dates: record.dates,
      declared: record.declared,
      n,
      ctx: buildContext(datasets, coverageFor, record.dates),
    };
  }
  return gameCache.ctx;
}

/** 今開いているタブの集計。都道府県道は実績・レベルに入れないので、ここで別に作る */
let prefSummaryCache: { data: RouteData; cov: Coverage; dates: Record["dates"]; s: DatasetSummary } | null = null;
function activeSummary(): DatasetSummary | undefined {
  if (!data) return undefined;
  if (active !== "prefroad") return gameContext()[active];
  const cov = coverage();
  if (prefSummaryCache?.data !== data || prefSummaryCache.cov !== cov || prefSummaryCache.dates !== record.dates) {
    prefSummaryCache = { data, cov, dates: record.dates, s: summarize(data, cov, record.dates) };
  }
  return prefSummaryCache.s;
}

function gameState() {
  const ctx = gameContext();
  const achievements = evaluateAchievements(ctx);
  const unlocked = achievements.filter((a) => a.unlocked);
  return { ctx, achievements, unlocked, level: computeLevel(ctx, unlocked.length) };
}

const today = () => {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

type GameTab = "achievements" | "suggest" | "review" | "prefs";
let gameTab: GameTab = "achievements";
/** ログタブに出す、MiniPC に保存してあるログ。読み込む前は null */
let savedLogs: SavedLog[] | null = null;
/** 「ログ」タブを開いているか */
let logMode = false;
/** ログタブで絞り込んでいる年("all" ならすべて、"range" なら期間を指定) */
let logYear = "all";
/** ログタブの「期間を指定」の期間。はじめは今日までの1週間 */
let logPeriod: Period =
  loadPeriod() ?? (() => {
    const d = new Date(Date.now() - 6 * 86400_000);
    const pad = (n: number) => String(n).padStart(2, "0");
    return { from: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`, to: today() };
  })();
/** 名前を付けて保存した期間(旅行) */
let journeys: Journey[] = [];
/** 期間の一覧に出す旅の記録(電車・飛行機など) */
let periodTrips: TravelTrip[] = [];
/** 期間の地図に出すため読んだ車のログ(ログ ID → 間引いた線と開始時刻) */
const periodTracks = new Map<string, { coords: [number, number][]; start?: number }>();
/** 期間の車のログを読んでいる様子(読み終えたら undefined) */
let periodNote: string | undefined;
/** 期間を変えるたびに増やす(前の期間の読み込みが終わっても、地図を合わせ直さないように) */
let periodSeq = 0;
/** ログタブで選んでいるログの詳細 */
let logDetail: LogDetail | null = null;
/** ログタブで選んでいる旅の記録(電車・飛行機など)。busy は移動手段を直している途中 */
let tripDetail: { id: string; busy?: boolean } | null = null;
/** MiniPC にログを保存しているか(ブラウザだけで使っているときは false) */
let storeShared = false;
/** 読み込んだログの軌跡(いちばん最後に開いたものだけ)と、通った路線 */
const trackCache = new Map<string, TrackPoint[]>();
const passedCache = new Map<string, PassedRoute[]>();
/** 読み込んだ運転評価(ログ ID → 評価。読めなければ null) */
const evals = new Map<string, DriveEval | null>();

async function getEval(id: string): Promise<DriveEval | null> {
  if (!evals.has(id)) {
    const store = await storePromise;
    evals.set(id, await store.loadEval(id).catch(() => null));
  }
  return evals.get(id)!;
}

const eventLabel = (e: DriveEvent) =>
  `${e.kind} ${e.value.toFixed(2)}${e.unit === "G" ? "G" : " m/s³"}(${Math.round(e.kmh)} km/h)`;

async function refreshLogs() {
  const store = await storePromise;
  savedLogs = store.shared ? await store.listLogs().catch(() => []) : [];
  if (store.shared) journeys = await fetchJourneys().catch(() => journeys);
  renderLogs();
  void fillLogStarts();
}

/** ログの日付・距離・走り始めた時刻 */
function logTrip(id: string, name: string, track: TrackPoint[]): Trip {
  const start = trackStart(track);
  return {
    date: logDate(track, name, Number(id.split("-")[0]) || Date.now()),
    m: Math.round(trackLength(track)),
    ...(start !== undefined ? { start } : {}),
  };
}

/** 走り始めた時刻を調べていないログ(前から保存してあるもの)を読んで時刻を付ける。一覧を時刻順に並べるため */
let fillingStarts = false;
async function fillLogStarts() {
  if (fillingStarts || !savedLogs) return;
  // 一度読んで時刻がなかったログは、このあと読み直さない
  const todo = savedLogs.filter((l) => l.start === undefined && !noStart.has(l.id));
  if (!todo.length) return;
  fillingStarts = true;
  const store = await storePromise;
  const next = async (): Promise<void> => {
    const log = todo.shift();
    if (!log) return;
    try {
      const track = parseTrackText(await store.loadLog(log.id), log.name);
      const trip = logTrip(log.id, log.name, track);
      if (trip.start === undefined) noStart.add(log.id);
      else {
        Object.assign(log, trip);
        await store.setLogTrip(log.id, trip).catch(() => undefined);
      }
    } catch {
      noStart.add(log.id);
    }
    return next();
  };
  try {
    await Promise.all([next(), next(), next(), next()]);
  } finally {
    fillingStarts = false;
  }
  renderLogs();
}
const noStart = new Set<string>();
/** 都道府県の形(地図の色分け用)。データがなければ undefined */
let prefShapes: PrefShapes | undefined;
/** 地図を都道府県で色分けしているか */
let prefFill = false;

/** 前回塗ったときの値。同じなら塗り直さない(形のデータが大きいので) */
let paintedPrefs: unknown = undefined;
function paintPrefs() {
  if (!prefShapes) return;
  const byPref = (prefFill && data ? activeSummary()?.byPref : undefined) ?? null;
  if (byPref === paintedPrefs) return;
  paintedPrefs = byPref;
  showPrefFill(map, prefShapes, byPref);
}

function renderGame() {
  if (!datasets.kokudo) return;
  const g = gameState();
  $("level").innerHTML = levelCard(g.level, g.unlocked.length, g.achievements.length, regionTitle(g.ctx));
  paintPrefs();
  const dialog = $<HTMLDialogElement>("game");
  if (!dialog.open) return;
  for (const b of $("game-tabs").querySelectorAll<HTMLButtonElement>("button")) {
    b.setAttribute("aria-selected", String(b.dataset.game === gameTab));
  }
  const body = $("game-body");
  if (gameTab === "achievements") body.innerHTML = achievementsView(g.achievements, g.level);
  else if (data) {
    const summary = activeSummary()!;
    body.innerHTML =
      gameTab === "suggest"
        ? suggestionsView({ kind: active, data, summary, coverage: coverage() }, routeName)
        : gameTab === "prefs"
          ? prefsView(summary, active, prefFill, !!prefShapes)
          : reviewView(summary, record.trips, today(), routeName, active);
  }
}

function openGame(tab: GameTab) {
  gameTab = tab;
  const dialog = $<HTMLDialogElement>("game");
  if (!dialog.open) dialog.showModal();
  renderGame();
  $("game-body").scrollTop = 0;
}

let toastTimer = 0;
function toast(lines: string[]) {
  if (lines.length === 0) return;
  const el = $("toast");
  el.innerHTML = lines.map((l) => `<div>${l}</div>`).join("");
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el.classList.remove("show"), 6000);
}

/** 記録を足す前後で、新しく解除した実績やレベルアップを知らせる */
function announce(before: ReturnType<typeof gameState>) {
  const after = gameState();
  const had = new Set(before.unlocked.map((a) => a.a.id));
  const lines = after.unlocked.filter((a) => !had.has(a.a.id)).map((a) => `${a.a.icon} 実績解除: <b>${a.a.name}</b>`);
  if (after.level.level > before.level.level) lines.unshift(`⬆️ レベルアップ! <b>Lv.${after.level.level} ${after.level.title}</b>`);
  toast(lines.slice(0, 6).concat(lines.length > 6 ? [`ほか ${lines.length - 6} 件`] : []));
}

function row(label: string, p: Progress): string {
  const pct = percent(p);
  return `<div class="row"><span>${label}</span><span>${pct.toFixed(1)}%</span>
    <div class="bar"><span style="width:${pct}%"></span></div>
    <span class="muted">${km(p.done)} / ${km(p.total)} km</span></div>`;
}

/** 高速道路はデータの並び(種別ごと・名前順)で出す */
let routeOrder: { data: RouteData; index: Map<string, number> } | null = null;
function order(ref: string): number {
  if (routeOrder?.data !== data) routeOrder = { data: data!, index: new Map(Object.keys(data!.routes).map((r, i) => [r, i])) };
  return routeOrder.index.get(ref) ?? Infinity;
}

const catLabel = (c: Category) =>
  REFERENCE_CATS.includes(c)
    ? `${CATEGORY_LABELS[c]}(参考・自己申告)`
    : SEPARATE_CATS.includes(c)
      ? `${CATEGORY_LABELS[c]}(別枠)`
      : CATEGORY_LABELS[c];

/** 点線国道を走ったかの申告のチェックボックス */
const declareBox = (ref: string) =>
  `<label class="declare" title="点線国道はログでは判定せず、自己申告で記録します"><input type="checkbox" data-declare="${ref}"${
    record.declared.get(ref)?.on ? " checked" : ""
  }> 点線区間を走った</label>`;

/** 点線国道の内訳に出す、OSM での種類と、OSM の地図へのリンク */
const HW_LABELS: { [hw: string]: string } = {
  path: "小道",
  track: "林道・農道",
  footway: "歩道",
  steps: "階段",
  bridleway: "乗馬道",
  cycleway: "自転車道",
  pedestrian: "歩行者道",
  none: "道路以外",
};
function dottedInfo(segIds: string[]): string {
  if (!data) return "";
  const want = new Set(segIds);
  const kinds = new Set<string>();
  for (const s of data.segments) {
    if (!want.has(s.id)) continue;
    if (s.hw) kinds.add(HW_LABELS[s.hw] ?? s.hw);
    if (s.name && kinds.size < 4) kinds.add(s.name);
  }
  const ways = [...new Set(segIds.map((id) => id.split("-")[0].slice(1)))];
  const links = ways
    .slice(0, 3)
    .map((w, i) => `<a href="https://www.openstreetmap.org/way/${w}" target="_blank" rel="noopener">OSM${ways.length > 1 ? i + 1 : ""}</a>`)
    .join(" ");
  return `<span class="dotted-info muted">${kinds.size ? `${esc([...kinds].join("・"))} / ` : ""}${links}${ways.length > 3 ? " …" : ""}</span>`;
}

function render() {
  keepScroll(renderNow);
}

function renderNow() {
  if (!data) return;
  const stats = computeStats(data, coverage());
  const separate = SEPARATE_CATS.filter((c) => stats.byCategory[c].total > 0).map((c) => CATEGORY_LABELS[c]);
  $("overall").innerHTML = `<h2>総合制覇率</h2><div class="big">${percent(stats.overall).toFixed(2)}%</div>
    <p class="muted">${km(stats.overall.done)} / ${km(stats.overall.total)} km(重複区間は1回だけ数えています${
      active !== "kokudo" ? "。上下線はどちらかを走れば制覇" : ""
    }${separate.length ? `。${separate.join("・")}は別枠で数えています` : ""}${
      active === "prefroad"
        ? `。表示している都道府県(${prefSelection.map(prefName).join("・")})だけの集計で、国道と重なる区間は国道で数えます。実績・レベルには入れていません`
        : ""
    })</p>`;
  breakdownItems = new Map();
  $("categories").innerHTML =
    "<h2>種別ごと</h2>" +
    (Object.keys(CATEGORY_LABELS) as Category[])
      .filter((c) => stats.byCategory[c].total > 0)
      .map((c) => {
        const head = row(catLabel(c), stats.byCategory[c]);
        if (!BREAKDOWN_CATS.includes(c)) return head;
        // 開いているときだけ内訳を作る(バイパスは数百路線ある)
        const items = openCats.has(c) ? categoryBreakdown(data!, coverage(), c) : [];
        const list = items
          .map((item) => {
            const key = `${c}:${item.key}`;
            breakdownItems.set(key, item);
            const declare = REFERENCE_CATS.includes(c)
              ? `<div class="declare-row">${declareBox(item.key)}${dottedInfo(item.segIds)}</div>`
              : c === "old"
                ? `<div class="declare-row">${dottedInfo(item.segIds)}</div>`
                : "";
            return `<li data-item="${key}">${row(item.refs.map(routeName).join("・"), item.progress)}${declare}</li>`;
          })
          .join("");
        return `<details data-cat="${c}"${openCats.has(c) ? " open" : ""}><summary>${head}</summary>
          <ol class="breakdown" data-scroll="cat:${c}">${list}</ol></details>`;
      })
      .join("");

  const filter = $<HTMLInputElement>("route-filter").value.trim();
  const matches = (r: string) =>
    active === "kokudo"
      ? r.startsWith(filter)
      : routeName(r).includes(filter) || (active === "prefroad" && String(splitPrefRef(r)[1]) === filter);
  const refs = [...stats.byRoute.keys()]
    .filter((r) => !filter || matches(r))
    .sort(
      active === "kokudo"
        ? (a, b) => Number(a) - Number(b) || a.localeCompare(b)
        : active === "prefroad"
          ? comparePrefRefs
          : (a, b) => order(a) - order(b),
    );
  $("routes").innerHTML = refs
    .map((r) => `<li data-ref="${r}"${r === selected ? ' class="selected"' : ""}>${row(routeName(r), stats.byRoute.get(r)!.overall)}</li>`)
    .join("");
  paintCoverage(map, data, coverage());
  renderDetail(stats);
  renderGame();
}

/** 選んだ国道の詳細を地図の上に出す */
function renderDetail(stats: ReturnType<typeof computeStats>) {
  if (!data) return;
  const box = $("detail");
  const route = selected ? stats.byRoute.get(selected) : undefined;
  showSelected(map, data, route ? selected : null, coverage());
  // ログタブでは、同じ枠に選んだログの詳細を出す
  if (logMode) {
    renderLogDetail();
    return;
  }
  box.classList.remove("log-detail");
  if (!selected || !route) {
    box.hidden = true;
    return;
  }
  const segs = data.segments.filter((s) => s.routes.includes(selected!));
  const passed = segs.filter((s) => (coverage().get(s.id) ?? 0) > 0).length;
  const dates = segs.flatMap((s) => record.dates.get(s.id) ?? []).sort();
  const p = route.overall;
  box.innerHTML = `<div class="detail-head"><h2>${routeName(selected)}</h2>
      <button id="detail-fold" type="button" aria-label="${mapOnly() ? "詳細を開く" : "地図を広く表示"}">${mapOnly() ? "▾" : "▴"}</button>
      <button id="detail-close" type="button" aria-label="閉じる">×</button></div>
    <div class="big">${percent(p).toFixed(1)}%</div>
    <div class="bar"><span style="width:${percent(p)}%"></span></div>
    <p class="muted">走行済み ${km(p.done)} km / 全長 ${km(p.total)} km(未踏破 ${km(p.total - p.done)} km)</p>
    ${(Object.keys(CATEGORY_LABELS) as Category[])
      .filter((c) => route.byCategory[c])
      .map(
        (c) =>
          `<button type="button" class="detail-cat${c === detailCat ? " active" : ""}" data-detail-cat="${c}"
            title="地図でこの区間を縁取る">${row(catLabel(c), route.byCategory[c]!)}</button>${
            REFERENCE_CATS.includes(c) ? declareBox(selected!) : ""
          }`,
      )
      .join("")}
    <p class="muted">通過した区間 ${passed.toLocaleString("ja-JP")} / ${segs.length.toLocaleString("ja-JP")}<br>
      ${dates.length ? `初めて ${dates[0]} / 最後 ${dates[dates.length - 1]}` : "まだ通過していません"}</p>
    ${nicknameList(selected)}
    ${overlapList(selected)}
    <p class="legend"><span class="sw done"></span>走行済み <span class="sw part"></span>一部 <span class="sw todo"></span>未踏破</p>
    <button id="detail-fit" type="button">全体を表示</button>`;
  box.hidden = false;
}

/** 選んだ路線の区間の通称(「三宿通り」「青梅街道」など)。「場所」でその区間を映す */
function nicknameList(ref: string): string {
  const items = nicknamesOf(data!, coverage(), ref);
  if (items.length === 0) return "";
  return `<details class="overlaps" open><summary>区間の通称(${items.length})</summary><ul data-scroll="nicknames">
    ${items
      .map(
        (o) => `<li>${esc(o.key)}
          <span class="muted">${km(o.progress.total)} km・${percent(o.progress).toFixed(0)}%</span>
          <button type="button" class="link" data-nick="${esc(o.key)}">場所</button></li>`,
      )
      .join("")}</ul></details>`;
}

/** 選んだ国道と重なっているほかの国道。名前を押すとその国道へ、「場所」で重なっている区間を映す */
function overlapList(ref: string): string {
  const items = overlapsOf(data!, coverage(), ref);
  if (items.length === 0) return "";
  return `<details class="overlaps" open><summary>重複している${active === "kokudo" ? "国道" : "路線"}(${items.length})</summary><ul data-scroll="overlaps">
    ${items
      .map(
        (o) => `<li><a href="#" data-jump="${o.key}">${routeName(o.key)}</a>
          <span class="muted">${km(o.progress.total)} km・${percent(o.progress).toFixed(0)}%</span>
          <button type="button" class="link" data-show="${o.key}">場所</button></li>`,
      )
      .join("")}</ul></details>`;
}

/** 地図を映すときの余白。右の詳細の枠に隠れないよう、その分を足す */
function detailPadding() {
  const box = $("detail");
  const pad = { top: 40, bottom: 40, left: 40, right: 40 };
  // スマホでは枠が地図の外にあるので余白は要らない
  if (!box.hidden && getComputedStyle(box).position === "absolute") pad.right += Math.min(box.offsetWidth, $("map").clientWidth / 2);
  map.resize(); // スマホでは枠が出た分だけ地図が縮むので、先に大きさを合わせる
  return pad;
}

/** 詳細の枠に路線が隠れないよう、その分の余白をとって全体(または ids の区間)を映す */
function fitSelected(ids?: string[]) {
  if (!data || !selected) return;
  const pad = detailPadding();
  const want = ids ? new Set(ids) : null;
  const ref = selected;
  fitSegments(map, data.segments.filter((s) => (want ? want.has(s.id) : s.routes.includes(ref))), pad);
}

function select(ref: string | null, fit: boolean | string[]) {
  selected = ref;
  detailCat = null;
  render();
  if (data) showFocus(map, data, Array.isArray(fit) ? fit : []);
  if (fit) fitSelected(Array.isArray(fit) ? fit : undefined);
}

async function loadData(kind: "kokudo" | "expressway") {
  // 分けたデータ(npm run build で作る)があれば、一覧だけ読む。区間の形は地図を拡大したときやログの判定のときに読む
  const dir = `${BASE}data/split/${kind}/`;
  const index = await fetch(`${dir}index.json`)
    .then((r) => (r.ok && r.headers.get("content-type")?.includes("json") ? r.json() : null))
    .catch(() => null);
  if (isSplitIndex(index)) return openSplit(index, dir);
  const res = await fetch(`${BASE}data/${DATA_FILES[kind]}`);
  if (!res.ok) throw new Error(`${DATASET_LABELS[kind]}のデータ(data/${DATA_FILES[kind]})がありません。README の手順で作成してください。`);
  return (await res.json()) as RouteData;
}

// ---- 都道府県道 ----

/** 都道府県道の一覧(prefroads/index.json)。読み込み前は undefined、データがなければ null */
let prefIndex: PrefRoadIndex | null | undefined;
let prefIndexReady: Promise<void> | null = null;
/** 読み込んだ都道府県ごとのファイル(画面の表示とログの判定で使い回す) */
const prefFiles = new Map<number, Promise<RouteData | undefined>>();
const PREF_SELECTION_KEY = "kokudo-map:prefroad-selection";

function loadPrefSelection(): number[] | null {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(PREF_SELECTION_KEY) ?? "null");
    return Array.isArray(v) ? v.filter((c): c is number => Number.isInteger(c) && c >= 1 && c <= 47) : null;
  } catch {
    return null;
  }
}
function savePrefSelection() {
  try {
    localStorage.setItem(PREF_SELECTION_KEY, JSON.stringify(prefSelection));
  } catch {
    // 保存できなくても、このページを開いている間は選んだものを使う
  }
}

/** 都道府県道のタブに出す(読み込む)都道府県。この端末のブラウザに覚えておく */
let prefSelection: number[] = loadPrefSelection() ?? [];
/** 都道府県道のデータを、どの都道府県の組み合わせで作ったか(同じなら作り直さない) */
let prefLoadedKey: string | null = null;
let prefLoading = false;

function loadPrefFile(code: number): Promise<RouteData | undefined> {
  let p = prefFiles.get(code);
  if (!p) {
    p = fetch(`${BASE}data/${prefFileName(code)}`)
      .then((r) => (r.ok && r.headers.get("content-type")?.includes("json") ? (r.json() as Promise<RouteData>) : undefined))
      .catch(() => undefined);
    prefFiles.set(code, p);
    void p.then((d) => {
      if (!d) prefFiles.delete(code);
    });
  }
  return p;
}

/** 判定のために読んだ、表示していない都道府県のファイルを手放す(メモリを空けるため) */
function dropUnselectedPrefFiles() {
  for (const code of [...prefFiles.keys()]) if (!prefSelection.includes(code)) prefFiles.delete(code);
}

async function loadPrefIndex() {
  const idx = await fetch(`${BASE}data/${DATA_FILES.prefroad}`)
    .then((r) => (r.ok && r.headers.get("content-type")?.includes("json") ? (r.json() as Promise<PrefRoadIndex>) : null))
    .catch(() => null);
  prefIndex = idx;
  if (!idx) return;
  if (loadPrefSelection() === null) {
    // 初めて開いたときは、国道をいちばん走っている都道府県を選んでおく
    const byPref = gameContext().kokudo?.byPref;
    prefSelection = byPref
      ? [...byPref]
          .filter(([code, p]) => p.done > 0 && idx.prefs[code])
          .sort((a, b) => b[1].done - a[1].done)
          .slice(0, 1)
          .map(([code]) => code)
      : [];
  }
  prefSelection = prefSelection.filter((code) => idx.prefs[code]).slice(0, 1);
}

/** 選んだ都道府県のファイルを読んで、都道府県道のデータを作り直す */
async function reloadPrefRoads() {
  if (!prefIndex) return;
  const codes = [...prefSelection];
  const key = codes.join(",");
  prefLoadedKey = key;
  prefLoading = codes.length > 0;
  if (active === "prefroad") {
    status.textContent = prefroadStatus();
    renderPrefPicker();
  }
  const files = (await Promise.all(codes.map(loadPrefFile))).filter((d): d is RouteData => !!d);
  if (prefLoadedKey !== key) return; // 読んでいる間に選び直した
  prefLoading = false;
  const merged = files.length ? mergePrefData(files) : undefined;
  datasets.prefroad = merged;
  if (active !== "prefroad") return;
  showDataset("prefroad");
  if (merged) {
    const missing = codes.length - files.length;
    status.textContent =
      `都道府県道: ${Object.keys(merged.routes).length} 路線(${merged.generatedAt.slice(0, 10)} 時点)` +
      (missing ? ` / ${missing} 件の都道府県のデータを読めませんでした` : "");
  }
}

function prefroadStatus(): string {
  if (prefIndex === undefined) return "都道府県道の一覧を読み込み中です…";
  if (prefIndex === null)
    return `都道府県道のデータ(data/${DATA_FILES.prefroad})がまだありません。GitHub の Actions で「国道・高速道路・都道府県道のデータを更新」を target = prefroad で実行し、MiniPC で update.bat を実行してください`;
  if (prefLoading) return `都道府県道のデータを読み込み中です…(${prefSelection.map(prefName).join("・")})`;
  if (prefSelection.length === 0) return "表示する都道府県を選んでください";
  return "都道府県道のデータを読めませんでした";
}

/** 都道府県道のタブで、表示する都道府県を選ぶ欄(1つずつ選ぶ。データが多いので一度に1都道府県だけ読む) */
function renderPrefPicker() {
  const box = $("pref-picker");
  box.hidden = logMode || active !== "prefroad" || !prefIndex;
  const idx = prefIndex;
  if (box.hidden || !idx) return;
  const current = prefSelection[0];
  const groups = REGIONS.map((r) => {
    const opts: string[] = [];
    for (let code = r.from; code <= r.to; code++) {
      const info = idx.prefs[code];
      if (!info) continue;
      opts.push(
        `<option value="${code}"${code === current ? " selected" : ""}>${prefName(code)}(${Math.round(info.km).toLocaleString("ja-JP")} km)</option>`,
      );
    }
    return opts.length ? `<optgroup label="${r.name}">${opts.join("")}</optgroup>` : "";
  }).join("");
  const mb = current ? (idx.prefs[current]?.bytes ?? 0) / 1e6 : 0;
  box.innerHTML = `<label class="pref-select">表示する都道府県
      <select id="pref-select">${current ? "" : '<option value="" selected>選んでください</option>'}${groups}</select></label>
    <p class="muted">${current ? `約 ${mb.toFixed(0)}MB${prefLoading ? "を読み込み中…" : ""}。` : ""}走行ログの判定は、表示していない都道府県の分も行います。</p>`;
}

$("pref-picker").addEventListener("change", (e) => {
  const sel = e.target as HTMLSelectElement;
  if (sel.id !== "pref-select" || !sel.value) return;
  prefSelection = [Number(sel.value)];
  savePrefSelection();
  dropUnselectedPrefFiles();
  void reloadPrefRoads();
});

/** 国道・高速道路・都道府県道を切り替える */
function showDataset(kind: DatasetKind) {
  active = kind;
  if (logMode) clearPeriod();
  logMode = false;
  for (const b of $("tabs").querySelectorAll<HTMLButtonElement>("button")) {
    b.setAttribute("aria-selected", String(b.dataset.kind === kind));
  }
  for (const id of ["overall", "categories", "routes-section"]) $(id).hidden = false;
  $("log-view").hidden = true;
  $("routes-title").textContent = kind === "kokudo" ? "国道別" : "路線別";
  $<HTMLInputElement>("route-filter").placeholder =
    kind === "kokudo" ? "番号で絞り込み(例: 1)" : kind === "prefroad" ? "名前か番号で絞り込み(例: 413)" : "名前で絞り込み(例: 東名)";
  renderPrefPicker();
  $<HTMLInputElement>("route-filter").value = "";
  selected = null;
  openCats.clear();
  // 都道府県道は、タブを開いたときに選んである都道府県の分を読む
  if (kind === "prefroad" && prefIndex && prefLoadedKey !== prefSelection.join(",")) void reloadPrefRoads();
  data = datasets[kind] ?? null;
  if (!data) {
    clearRoutes(map);
    for (const id of ["overall", "categories", "routes"]) $(id).innerHTML = "";
    $("detail").hidden = true;
    status.textContent =
      kind === "prefroad"
        ? prefroadStatus()
        : expresswayReady && kind === "expressway" && !(kind in datasets)
          ? `${DATASET_LABELS[kind]}のデータを読み込み中です。少しお待ちください`
          : `${DATASET_LABELS[kind]}のデータ(data/${DATA_FILES[kind]})がまだありません`;
    return;
  }
  addRoutes(map, data, (id) => record.dates.get(id), (ref) => select(ref, false));
  render();
}

/** 高速道路のデータを読み終わるまで待つ(ログの判定は両方のデータがそろってから行う) */
let expresswayReady: Promise<void> | null = null;

map.on("load", async () => {
  // 電車・飛行機などの移動の線(制覇の判定には使わない)。道路のデータとは別に読む
  addTravelLayer(map);
  try {
    const store = await storePromise;
    // 高速道路のデータ(約27MB)は国道を表示してから読む。最初に地図が出るまでを短くするため
    const [kokudo, rec, shapes] = await Promise.all([
      loadData("kokudo"),
      store.load(),
      fetch(`${import.meta.env.BASE_URL}data/prefectures.json`)
        .then((r) => (r.ok && r.headers.get("content-type")?.includes("json") ? (r.json() as Promise<PrefShapes>) : undefined))
        .catch(() => undefined),
    ]);
    prefShapes = shapes;
    datasets.kokudo = kokudo;
    record = rec;
    $("rematch").hidden = !store.shared;
    storeShared = store.shared;
    const statusText = (expressway?: RouteData) =>
      `国道データ: ${Object.keys(kokudo.routes).length} 路線` +
      (expressway ? ` / 高速道路: ${Object.keys(expressway.routes).length} 路線` : " / 高速道路のデータを読み込み中…") +
      `(${kokudo.generatedAt.slice(0, 10)} 時点)` +
      (store.shared ? " / 記録は MiniPC に保存されます" : " / 記録はこのブラウザに保存されます");
    if (active === "kokudo" && !logMode) showDataset(active);
    else renderLogs();
    status.textContent = statusText();
    // 都道府県道の一覧(小さい)。都道府県ごとのファイルは、タブを開いたときやログの判定のときに読む
    prefIndexReady = loadPrefIndex().then(() => {
      if (active === "prefroad" && !logMode) showDataset(active);
    });
    let done = () => {};
    expresswayReady = new Promise((ok) => (done = ok));
    const expressway = await loadData("expressway").catch(() => undefined);
    datasets.expressway = expressway;
    done();
    if (active === "expressway" && !logMode) showDataset(active);
    else render(); // 実績やレベルに高速道路の分を足す
    status.textContent = statusText(expressway).replace(" / 高速道路のデータを読み込み中…", "");
    await checkJudge();
    await importPending();
  } catch (e) {
    status.textContent = (e as Error).message;
  }
});

$("tabs").addEventListener("click", (e) => {
  const button = (e.target as HTMLElement).closest<HTMLElement>("button");
  if (button?.dataset.view === "logs") {
    if (!logMode) showLogs();
    return;
  }
  const kind = button?.dataset.kind as DatasetKind | undefined;
  if (kind && (kind !== active || logMode)) showDataset(kind);
});

const isTrackFile = (f: File) => /\.(csv|gpx)$/i.test(f.name);

/** 判定に使う道路データ(画面で読んだものを使い回す) */
const judgeData = (): JudgeData => ({
  kokudo: datasets.kokudo,
  expressway: datasets.expressway,
  prefIndex,
  loadPref: loadPrefFile,
});

/**
 * ログを判定して記録に足す。save なら MiniPC にログも残す(あとで判定し直せるように)。
 * logEntry が false のときは読み込み履歴を増やさない(判定し直し用)。
 * replace なら、今の通った区間の記録を、これらのログで判定した結果で置き換える(前の判定の誤りを消す)。
 */
async function importFiles(
  files: File[],
  opts: { save: boolean; logEntry: boolean; replace?: boolean; saved?: SavedLog[] } = { save: true, logEntry: true },
) {
  if (!datasets.kokudo) return;
  if (expresswayReady) {
    status.textContent = "高速道路のデータを読み込み中です。読み終わったら判定します…";
    await expresswayReady;
  }
  if (prefIndexReady) await prefIndexReady;
  const store = await storePromise;
  const before = gameState();
  const passed = new Set<string>();
  const failed: string[] = [];
  // 置き換えるときは、全部のログを判定し終えてからまとめて保存する
  let pending = emptyRecord();
  for (const [i, file] of files.entries()) {
    status.textContent = `${file.name} を判定中…(${i + 1} / ${files.length})`;
    try {
      const { track, day, trip, tripKey: key, coverage: result } = await judgeLog(await file.text(), file.name, file.lastModified, judgeData());
      if (opts.save) await store.saveLog(file.name, await file.text(), trip).catch(() => undefined);
      // 保存してあるログには、ログ一覧に出す日付と距離をここで付ける(前に時刻を読み違えて 1970年になっていたものも直す)
      const saved = opts.saved?.[i];
      if (saved && (saved.date !== trip.date || saved.m !== trip.m || saved.start !== trip.start)) await store.setLogTrip(saved.id, trip).catch(() => undefined);
      const dates = new Map([...result.keys()].map((id) => [id, [day, day] as [string, string]]));
      const logs = opts.logEntry ? [{ name: file.name, importedAt: new Date().toISOString(), points: track.length }] : [];
      const trips = new Map([[key, trip]]);
      const added = { coverage: result, dates, logs, declared: new Map(), trips };
      if (opts.replace) pending = mergeRecord(pending, added);
      else record = await store.add(added);
      for (const id of result.keys()) passed.add(id);
      showTrack(map, track);
      showDriveEvents(map, []);
    } catch (e) {
      failed.push(`${file.name}: ${(e as Error).message}`);
    }
  }
  let note = "";
  if (opts.replace) {
    // 読めなかったログがあると、その分の記録が消えてしまうので、置き換えずに足すだけにする
    if (failed.length === 0) record = await store.replaceCoverage(pending);
    else {
      record = await store.add(pending);
      note = "(読めないログがあったので、前の記録は消さずに足しました)";
    }
  }
  dropUnselectedPrefFiles();
  const ok = files.length - failed.length;
  status.textContent =
    `${ok} ファイルを読み込み、${passed.size} 区間を通過しました` +
    note +
    (failed.length ? `(読めなかったもの: ${failed.join(" / ")})` : "");
  render();
  announce(before);
  if (store.shared) void refreshLogs();
}

/**
 * ほかのツール(gbowl-log-formatter の RunAll.bat など)から MiniPC に自動で送られてきたログを判定して記録に足す。
 * 地図を開いたときと、ほかのアプリから戻ってきたときに確かめる
 */
let importingPending = false;
async function importPending() {
  const store = await storePromise;
  // MiniPC のサーバーで判定するときは、サーバーに任せる
  if (!store.shared || !datasets.kokudo || importingPending || serverJudge) return;
  importingPending = true;
  try {
    const pending = await store.pendingLogs().catch(() => []);
    const files: File[] = [];
    const saved: SavedLog[] = [];
    for (const l of pending) {
      // 2台で同時に開いていても、二重に判定しないよう先に一覧から外す
      if (!(await store.claimLog(l.id).catch(() => false))) continue;
      try {
        files.push(new File([await store.loadLog(l.id)], l.name, { lastModified: Number(l.id.split("-")[0]) || Date.now() }));
        saved.push(l);
      } catch {
        /* 読めなかったログは飛ばす(「保存したログで判定し直す」で読み直せる) */
      }
    }
    if (files.length === 0) return;
    await importFiles(files, { save: false, logEntry: true, saved });
    status.textContent = `自動で送られてきたログ ${files.length} 件を判定しました: ` + status.textContent;
  } finally {
    importingPending = false;
  }
}

// ---- MiniPC のサーバーでの判定 ----

/** サーバーで判定するか(MiniPC のサーバーが新しい版で、npm run build 済みなら true) */
let serverJudge = false;
/** 最後に見た、サーバーの判定の番号。変わっていたら記録を読み直す */
let judgeRev: number | null = null;
let judgeTimer = 0;
/** 判定中の様子をこの画面で見ていたもの(終わったときに結果を出す) */
let watchedRun: string | null = null;

const runLabel = (r: JudgeRun) => (r.kind === "rejudge" ? "保存したログの判定し直し" : "自動で送られてきたログの判定");

function runText(r: JudgeRun): string {
  if (r.finishedAt) {
    const failed = r.failed.length ? `(読めなかったもの: ${r.failed.join(" / ")})` : "";
    const note = r.kind === "rejudge" && r.replaced === false ? "(読めないログがあったので、前の記録は消さずに足しました)" : "";
    return `MiniPC で${runLabel(r)}が終わりました: ${r.done - r.failed.length} 件を判定し、${r.passed} 区間を通過しました${note}${failed}`;
  }
  const cur = r.current ? `(${r.current})` : "";
  return `MiniPC で${runLabel(r)}をしています… ${r.done} / ${r.total}${cur}。この画面を閉じても続きます`;
}

/** サーバーでの判定の様子を確かめ、判定で記録が変わっていれば読み直す。判定中は 2 秒ごとに確かめる */
async function checkJudge() {
  const store = await storePromise;
  if (!store.shared) return;
  clearTimeout(judgeTimer);
  const st = await store.judgeStatus().catch(() => null);
  serverJudge = !!st?.enabled;
  if (!st) return;
  if (judgeRev !== null && st.rev !== judgeRev && data) {
    const before = gameState();
    record = await store.load();
    render();
    announce(before);
    void refreshLogs();
  }
  judgeRev = st.rev;
  const run = st.running;
  if (run) {
    watchedRun = run.startedAt;
    status.textContent = runText(run);
  } else if (watchedRun && (st.last?.startedAt === watchedRun || (watchedRun === "rejudge" && st.last?.kind === "rejudge" && !st.rejudgeQueued))) {
    status.textContent = runText(st.last);
    watchedRun = null;
  } else if (st.rejudgeQueued) status.textContent = "MiniPC で判定し直す準備をしています…";
  if (run || st.rejudgeQueued) judgeTimer = window.setTimeout(() => void checkJudge(), 2000);
}

// 地図を開いたままのときも、1分ごとに送られてきたログがないか(サーバーで判定した結果がないか)確かめる
setInterval(() => {
  if (document.visibilityState === "visible") void checkJudge().then(importPending);
}, 60_000);

// MiniPC に保存してあるログをすべて判定し直す(高速道路のデータを足したあと・判定の方法を直したあとなど)
$("rematch").addEventListener("click", async () => {
  const store = await storePromise;
  const saved = await store.listLogs();
  if (saved.length === 0) {
    status.textContent = "保存してあるログがまだありません(これから読み込むログは保存されます)";
    return;
  }
  const unsaved = record.logs.length > saved.length ? `\n記録上は ${record.logs.length} 回読み込んでいるので、保存していないログがあるかもしれません。` : "";
  if (
    !confirm(
      `保存してある ${saved.length} 件のログで判定し直し、通った区間の記録を作り直します。` +
        `前の判定の誤り(交差した道路を走ったことにしていたなど)は消えますが、` +
        `保存していないログ(ログを残す前に読み込んだものなど)で付いた記録も消えます。${unsaved}\n` +
        `今の記録は MiniPC の data/backup に控えを残します。` +
        (serverJudge ? "判定は MiniPC で行うので、始めたあとはこの画面を閉じてもかまいません。" : "判定し終わるまでこの画面を開いておいてください。") +
        `\nよろしいですか?`,
    )
  )
    return;
  if (serverJudge) {
    const st = await store.startRejudge();
    if (st) {
      status.textContent = "MiniPC で判定し直します…";
      // すぐ終わって判定中の様子を見られなくても、結果は出す
      watchedRun = st.running?.kind === "rejudge" ? st.running.startedAt : "rejudge";
      await checkJudge();
      return;
    }
    // サーバーで始められなければ、この画面で判定する
  }
  const files: File[] = [];
  for (const l of saved) files.push(new File([await store.loadLog(l.id)], l.name, { lastModified: Number(l.id.split("-")[0]) || Date.now() }));
  await importFiles(files, { save: false, logEntry: false, replace: true, saved });
});

$<HTMLInputElement>("file").addEventListener("change", async (ev) => {
  const input = ev.target as HTMLInputElement;
  const files = Array.from(input.files ?? []);
  input.value = "";
  await importFiles(files);
});

// 画面のどこにでもファイルをドロップして読み込める
let dragDepth = 0;
const hasFiles = (e: DragEvent) => e.dataTransfer?.types.includes("Files") ?? false;
document.addEventListener("dragenter", (e) => {
  if (!hasFiles(e)) return;
  dragDepth++;
  document.body.classList.add("dragging");
});
document.addEventListener("dragleave", () => {
  if (dragDepth > 0 && --dragDepth === 0) document.body.classList.remove("dragging");
});
document.addEventListener("dragover", (e) => {
  if (hasFiles(e)) e.preventDefault();
});
document.addEventListener("drop", async (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove("dragging");
  const files = Array.from(e.dataTransfer?.files ?? []);
  const tracks = files.filter(isTrackFile);
  if (tracks.length === 0) {
    status.textContent = "CSV か GPX のファイルをドロップしてください";
    return;
  }
  await importFiles(tracks);
});

// ほかの端末で追加した記録を、このページに戻ってきたときに取り込む
document.addEventListener("visibilitychange", async () => {
  const store = await storePromise;
  if (document.visibilityState !== "visible" || !store.shared || !data) return;
  record = await store.load();
  render();
  await checkJudge();
  await importPending();
});

// スマホ: 地図の何もないところを押すと、一覧と詳細をたたんで地図を広く見せる(もう一度押すと戻す)
const mobile = window.matchMedia("(max-width: 720px)");
const mapOnly = () => document.body.classList.contains("map-only");
function setMapOnly(on: boolean) {
  document.body.classList.toggle("map-only", on);
  const fold = document.getElementById("detail-fold");
  if (fold) {
    fold.textContent = on ? "▾" : "▴";
    fold.setAttribute("aria-label", on ? "詳細を開く" : "地図を広く表示");
  }
  map.resize();
}
map.on("click", (e) => {
  if (!mobile.matches) return;
  const roads = map.getStyle().layers.filter((l) => /^(overview|routes)-|^selected$/.test(l.id)).map((l) => l.id);
  if (roads.length && map.queryRenderedFeatures(e.point, { layers: roads }).length) return;
  setMapOnly(!mapOnly());
});
$("map-restore").addEventListener("click", (e) => {
  e.stopPropagation();
  setMapOnly(false);
});
mobile.addEventListener("change", () => {
  if (!mobile.matches && mapOnly()) setMapOnly(false);
});
// スマホでは地図が狭いので、出典の文字は最初からたたんでおく(右下の i で開ける。地図を動かしてもたたまれる)
map.once("idle", () => {
  if (mobile.matches) document.querySelector(".maplibregl-ctrl-attrib.maplibregl-compact-show")?.classList.remove("maplibregl-compact-show");
});

$("route-filter").addEventListener("input", render);
$("routes").addEventListener("click", (e) => {
  const li = (e.target as HTMLElement).closest("li");
  if (li?.dataset.ref) select(li.dataset.ref, true);
});
$("detail").addEventListener("click", (e) => {
  if (onLogClick(e)) return;
  const el = e.target as HTMLElement;
  if (el.id === "detail-close") select(null, false);
  if (el.id === "detail-fold") setMapOnly(!mapOnly());
  if (el.id === "detail-fit") fitSelected();
  // 種別の行: その種別の区間を黄色く縁取って映す。もう一度押すと戻す
  const catBtn = el.closest<HTMLElement>("[data-detail-cat]");
  if (catBtn && data && selected) {
    const cat = catBtn.dataset.detailCat as Category;
    detailCat = detailCat === cat ? null : cat;
    const ref = selected;
    const ids = detailCat ? data.segments.filter((s) => s.routes.includes(ref) && s.cats.includes(cat)).map((s) => s.id) : [];
    render();
    showFocus(map, data, ids);
    fitSelected(ids.length ? ids : undefined);
  }
  if (el.dataset.jump) {
    e.preventDefault();
    select(el.dataset.jump, true);
  }
  if (el.dataset.nick && data && selected) {
    const item = nicknamesOf(data, coverage(), selected).find((o) => o.key === el.dataset.nick);
    if (item) {
      showFocus(map, data, item.segIds);
      fitSelected(item.segIds);
    }
  }
  if (el.dataset.show && data && selected) {
    const shared = overlapsOf(data, coverage(), selected).find((o) => o.key === el.dataset.show);
    if (shared) {
      showFocus(map, data, shared.segIds);
      fitSelected(shared.segIds);
    }
  }
});
// 種別ごとの内訳: 開いたら中身を作り、行を押したらその国道を選んでその種別の区間を映す
$("categories").addEventListener(
  "toggle",
  (e) => {
    const d = e.target as HTMLDetailsElement;
    const cat = d.dataset.cat as Category | undefined;
    if (!cat || d.open === openCats.has(cat)) return;
    if (d.open) openCats.add(cat);
    else openCats.delete(cat);
    if (d.open) render();
  },
  true,
);
// 点線国道の自己申告(内訳と国道詳細のチェックボックス)
for (const id of ["categories", "detail"]) {
  $(id).addEventListener("change", (e) => {
    const box = e.target as HTMLInputElement;
    if (box.dataset.declare) declareDotted(box.dataset.declare, box.checked);
  });
}
$("categories").addEventListener("click", (e) => {
  if ((e.target as HTMLElement).closest(".declare, .dotted-info")) return;
  const li = (e.target as HTMLElement).closest<HTMLElement>("li[data-item]");
  const item = li && breakdownItems.get(li.dataset.item!);
  if (item) select(item.refs[0], item.segIds);
});

$("export").addEventListener("click", () => {
  const blob = new Blob([exportBackup(record)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `kokudo-record-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
});

$<HTMLInputElement>("import").addEventListener("change", async (ev) => {
  const file = (ev.target as HTMLInputElement).files?.[0];
  if (!file) return;
  const store = await storePromise;
  const before = gameState();
  record = await store.add(importBackup(await file.text()));
  render();
  announce(before);
});

$("reset").addEventListener("click", async () => {
  const store = await storePromise;
  const where = store.shared ? "すべての端末の" : "";
  if (!confirm(`${where}走行記録をすべて消します。よろしいですか?`)) return;
  await store.clear();
  record = emptyRecord();
  render();
});

// ゲーム要素の画面
$("level").addEventListener("click", (e) => {
  const tab = (e.target as HTMLElement).closest<HTMLElement>("[data-game]")?.dataset.game as GameTab | undefined;
  if (tab) openGame(tab);
});
$("game-tabs").addEventListener("click", (e) => {
  const tab = (e.target as HTMLElement).closest<HTMLElement>("[data-game]")?.dataset.game as GameTab | undefined;
  if (tab) openGame(tab);
});
$("game-close").addEventListener("click", () => $<HTMLDialogElement>("game").close());
// 枠の外(背景)を押しても閉じる
$("game").addEventListener("click", (e) => {
  if (e.target === e.currentTarget) $<HTMLDialogElement>("game").close();
});
// ---- ログタブ ----

/** 「ログ」タブを開く。左の一覧が、路線の代わりに保存してあるログになる */
function showLogs() {
  logMode = true;
  for (const b of $("tabs").querySelectorAll<HTMLButtonElement>("button")) {
    b.setAttribute("aria-selected", String(b.dataset.view === "logs"));
  }
  for (const id of ["pref-picker", "overall", "categories", "routes-section"]) $(id).hidden = true;
  $("log-view").hidden = false;
  select(null, false);
  renderLogs();
  void refreshLogs().then(() => {
    if (logMode) void drawSelection(logYear === "range");
  });
}

function renderLogs() {
  if (!logMode) return;
  keepScroll(() => {
    $("log-view").innerHTML = logListPanel(savedLogs, logYear, storeShared, logDetail?.log.id, logYear === "range" ? periodView() : undefined, journeys, { shown: shownKeys(), trips: periodTrips, kind: logKind });
    renderLogDetail();
  });
}

/** 期間の一覧(車のログと旅の記録を古い順に) */
function currentPeriodItems() {
  const starts = new Map<string, number>();
  for (const [id, t] of periodTracks) if (t.start !== undefined) starts.set(id, t.start);
  return periodItems(savedLogs ?? [], periodTrips, logPeriod, starts);
}

/** 期間の一覧から、開いている旅行で外したものを除いたもの */
function shownPeriodItems() {
  return includedItems(currentPeriodItems(), journeyOf(journeys, logPeriod)?.exclude);
}

function periodView() {
  const items = currentPeriodItems();
  const known = new Set([...periodTracks].filter(([, t]) => t.start !== undefined).map(([id]) => id));
  for (const l of savedLogs ?? []) if (l.start !== undefined) known.add(l.id);
  return { period: logPeriod, items, known, note: periodNote };
}

/** 軌跡を地図用に間引く(前に残した点から 15m 以上離れた点だけ残す) */
function thinTrack(track: TrackPoint[]): [number, number][] {
  const out: [number, number][] = [];
  let last: TrackPoint | undefined;
  for (const p of track) {
    if (last && distance([last.lon, last.lat], [p.lon, p.lat]) < 15) continue;
    out.push([p.lon, p.lat]);
    last = p;
  }
  const end = track[track.length - 1];
  if (end && end !== last) out.push([end.lon, end.lat]);
  return out;
}

// ---- 地図に出すログ(一覧の左のチェック) ----
// 期間を指定しているときは、「旅」パネルで選んだ手段のものを出し、一覧のチェックで1本ずつ変えられる(期間ごとに覚える)。
// 期間を指定していないときは、何も出さず、一覧でチェックしたものだけを出す。どちらもこの端末だけに覚える

const SHOWN_KEY = "kokudo-log-shown";
const PERIOD_SHOWN_KEY = "kokudo-period-shown";
const readJson = <T,>(key: string, fallback: T): T => {
  try {
    return (JSON.parse(localStorage.getItem(key) ?? "null") as T) ?? fallback;
  } catch {
    return fallback;
  }
};
const writeJson = (key: string, v: unknown) => {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {
    // 保存できなくても今の画面では切り替えられる
  }
};
/** 期間を指定していないときにチェックしたもの */
let shownAll = new Set<string>(readJson<string[]>(SHOWN_KEY, []));
/** ログタブで選んでいる乗り物のタブ */
const LOG_KIND_KEY = "kokudo-log-kind";
let logKind: LogKind = readJson<LogKind>(LOG_KIND_KEY, "all");
/** 期間ごとに、手段の設定から変えたもの(期間 → itemKey → 出すか) */
let periodShown = readJson<{ [period: string]: { [key: string]: boolean } }>(PERIOD_SHOWN_KEY, {});
const periodKey = () => `${logPeriod.from}_${logPeriod.to}`;
const modeOfItem = (it: PeriodItem): ShowMode => (it.kind === "log" ? "car" : it.trip.mode);

/** 期間を指定していない一覧のすべて(車のログと旅の記録) */
function allItems(): PeriodItem[] {
  const items = periodItems(savedLogs ?? [], periodTrips, { from: "0000-01-01", to: "9999-12-31" });
  for (const log of savedLogs ?? []) if (!log.date) items.push({ kind: "log", log, day: "", start: 0 });
  return items;
}

/** いま地図に出すもの */
function visibleItems(): PeriodItem[] {
  if (!logMode) return [];
  if (logYear === "range") {
    const modes = new Set(travelModes());
    const over = periodShown[periodKey()] ?? {};
    return shownPeriodItems().filter((it) => over[itemKey(it)] ?? modes.has(modeOfItem(it)));
  }
  return allItems().filter((it) => shownAll.has(itemKey(it)));
}

/** 一覧のチェックを入れるもの */
const shownKeys = () => new Set(visibleItems().map(itemKey));

/** 一覧のチェックを変えた */
function setShown(key: string, on: boolean) {
  if (logYear === "range") {
    const over = { ...(periodShown[periodKey()] ?? {}), [key]: on };
    periodShown = { ...periodShown, [periodKey()]: over };
    writeJson(PERIOD_SHOWN_KEY, periodShown);
  } else {
    if (on) shownAll.add(key);
    else shownAll.delete(key);
    writeJson(SHOWN_KEY, [...shownAll]);
  }
  void drawSelection(false);
}

setTravelHooks({
  counts() {
    if (!logMode || logYear !== "range") return null;
    const c = new Map<ShowMode, { n: number; m: number }>();
    for (const it of shownPeriodItems()) {
      const k = modeOfItem(it);
      const cur = c.get(k) ?? { n: 0, m: 0 };
      c.set(k, { n: cur.n + 1, m: cur.m + (it.kind === "log" ? (it.log.m ?? 0) : it.trip.m) });
    }
    return c;
  },
  // 手段のチェックを変えたら、その手段で1本ずつ変えていたものは手段の設定に戻す
  onModes(changed) {
    const over = { ...(periodShown[periodKey()] ?? {}) };
    for (const it of currentPeriodItems()) if (modeOfItem(it) === changed) delete over[itemKey(it)];
    periodShown = { ...periodShown, [periodKey()]: over };
    writeJson(PERIOD_SHOWN_KEY, periodShown);
    void drawSelection(false);
  },
  fit: () => fitPeriod(),
});

/** 地図に出すもの(一覧でチェックしたもの)を出す。車のログは読んでから出す。fit なら読み終えてから全体に合わせる */
async function drawSelection(fit: boolean) {
  const seq = ++periodSeq;
  const store = await storePromise;
  periodTrips = await loadTravelTrips().catch(() => []);
  if (seq !== periodSeq) return;
  const items = visibleItems();
  showOnlyTrips(items.flatMap((i) => (i.kind === "trip" ? [i.trip.id] : [])));
  const logs = items.flatMap((i) => (i.kind === "log" ? [i.log] : []));
  const draw = () =>
    showPeriodTracks(
      map,
      logs.flatMap((l) => (periodTracks.has(l.id) ? [{ id: l.id, coords: periodTracks.get(l.id)!.coords }] : [])),
      (id) => void openLog(id),
    );
  draw();
  renderLogs();
  refreshTravelPanel();
  const todo = logs.filter((l) => !periodTracks.has(l.id));
  let done = 0;
  const next = async (): Promise<void> => {
    const l = todo.shift();
    if (!l || seq !== periodSeq) return;
    try {
      const track = parseTrackText(await store.loadLog(l.id), l.name);
      periodTracks.set(l.id, { coords: thinTrack(track), start: track.find((p) => p.time !== undefined)?.time });
    } catch {
      periodTracks.set(l.id, { coords: [] });
    }
    done++;
    if (seq === periodSeq) {
      periodNote = `車のログを読んでいます(${done} / ${done + todo.length})…`;
      draw();
      renderLogs();
    }
    return next();
  };
  if (todo.length) {
    periodNote = `車のログを読んでいます(0 / ${todo.length})…`;
    renderLogs();
    // 一度に読みすぎないよう4本ずつ
    await Promise.all([next(), next(), next(), next()]);
  }
  if (seq !== periodSeq) return;
  periodNote = undefined;
  draw();
  renderLogs();
  if (fit) fitPeriod();
}

/** 地図に出している車のログと旅の記録が全部入るように地図を合わせる */
function fitPeriod() {
  const items = visibleItems();
  const trips = items.flatMap((i) => (i.kind === "trip" ? [i.trip] : []));
  const cars: TravelTrip[] = items.flatMap((i) =>
    i.kind === "log" && periodTracks.get(i.log.id)?.coords.length
      ? [{ id: i.log.id, mode: "other" as const, start: null, end: null, m: 0, maxAltM: null, lines: [periodTracks.get(i.log.id)!.coords], gaps: [] }]
      : [],
  );
  const box = tripBounds([...trips, ...cars]);
  if (box) fitBox(map, box, detailPadding());
}

/** ログタブを離れたとき: 地図に出しているログの線を消す */
function clearPeriod() {
  periodSeq++;
  periodNote = undefined;
  showPeriodTracks(map, [], () => {});
  showOnlyTrips([]);
  refreshTravelPanel();
}

/** 一覧での前後のログ(一覧に出ている順) */
function logNeighbors(id: string) {
  const list = !savedLogs || (logKind !== "all" && logKind !== "car")
    ? []
    : logYear === "range"
      ? shownPeriodItems().flatMap((i) => (i.kind === "log" ? [i.log] : []))
      : shownLogs(savedLogs, logYear);
  const i = list.findIndex((l) => l.id === id);
  return {
    prev: i > 0 ? list[i - 1].id : undefined,
    next: i >= 0 && i < list.length - 1 ? list[i + 1].id : undefined,
    index: i >= 0 ? i + 1 : undefined,
    count: list.length,
  };
}

/** 選んだログの詳細を、地図の右(スマホでは地図の上)の枠に出す */
function renderLogDetail() {
  const box = $("detail");
  box.classList.add("log-detail");
  const trip = tripDetail && periodTrips.find((t) => t.id === tripDetail!.id);
  if (!logDetail && trip) {
    box.innerHTML = tripDetailPanel(trip, tripDetail!.busy);
    box.hidden = false;
    return;
  }
  if (!logDetail) {
    box.hidden = true;
    return;
  }
  box.innerHTML = logDetailPanel(logDetail, { ...logNeighbors(logDetail.log.id), folded: mapOnly() });
  box.hidden = false;
}

/** 開いているログの詳細を更新する(ほかのログに切り替わっていたら何もしない) */
function updateDetail(id: string, part: Partial<LogDetail>) {
  if (logDetail?.log.id !== id) return false;
  logDetail = { ...logDetail, ...part };
  renderLogs();
  return true;
}

const datasetRouteName = (kind: DatasetKind, ref: string, d: RouteData) =>
  kind === "prefroad"
    ? prefRouteLabel(ref, d.routes[ref]?.name, prefName)
    : (d.routes[ref]?.name ?? (kind === "kokudo" ? `国道${ref}号` : ref));

/** ログで通った路線を調べる(国道・高速道路と、通った都道府県の都道府県道)。道路データがなければ null */
async function logRoutes(id: string, track: TrackPoint[]): Promise<PassedRoute[] | null> {
  const hit = passedCache.get(id);
  if (hit) return hit;
  if (!datasets.kokudo) return null;
  if (expresswayReady) await expresswayReady;
  if (prefIndexReady) await prefIndexReady;
  const cov = await matchAll(track, judgeData());
  const sets: [DatasetKind, RouteData][] = [["kokudo", datasets.kokudo]];
  if (datasets.expressway) sets.push(["expressway", datasets.expressway]);
  if (prefIndex) {
    for (const code of prefsOfTrack(prefIndex, track)) {
      const d = await loadPrefFile(code);
      if (d) sets.push(["prefroad", d]);
    }
  }
  const list = passedRoutes(cov, sets, datasetRouteName);
  dropUnselectedPrefFiles();
  passedCache.set(id, list);
  return list;
}

/** 読み込んだ天気(ログ ID → 天気。取れなければ null) */
const weathers = new Map<string, DriveWeather | null>();

/** ログの天気。MiniPC になければ、軌跡の点を送って取ってもらう */
async function logWeather(id: string, track: TrackPoint[]): Promise<DriveWeather | null> {
  if (!weathers.has(id)) {
    const store = await storePromise;
    let w = await store.loadWeather(id).catch(() => null);
    const points = weatherPoints(track);
    if (!w && points.length) w = await store.fetchWeather(id, points).catch(() => null);
    weathers.set(id, w);
  }
  return weathers.get(id)!;
}

/** 保存してあるログを開く: 地図に軌跡と出来事を出し、左に詳細を出す */
async function openLog(id: string) {
  const store = await storePromise;
  const log = savedLogs?.find((l) => l.id === id) ?? { id, name: id, size: 0 };
  tripDetail = null;
  logDetail = { log };
  renderLogs();
  $("detail").scrollTop = 0;
  // 前後のボタンで移ったときも、一覧の選んだ行が見えるようにする
  $("log-view").querySelector(".log-list li.selected")?.scrollIntoView({ block: "nearest" });
  try {
    let track = trackCache.get(id);
    if (!track) {
      track = parseTrackText(await store.loadLog(id), log.name);
      trackCache.clear();
      trackCache.set(id, track);
    }
    if (track.length === 0) throw new Error("位置の記録がありません");
    if (logDetail?.log.id !== id) return;
    showTrack(map, track, detailPadding());
    showDriveEvents(map, []);
    const trip = logTrip(id, log.name, track);
    if (log.date !== trip.date || log.m !== trip.m || log.start !== trip.start) {
      Object.assign(log, trip);
      await store.setLogTrip(id, trip).catch(() => undefined);
    }
    if (!updateDetail(id, { stats: tripStats(track) })) return;
    void logWeather(id, track).then((weather) => {
      updateDetail(id, { weather });
      if (weather && log.weather === undefined) {
        const w = weather.summary;
        log.weather = { icon: w.icon, label: w.label, tMin: w.tMin, tMax: w.tMax };
      }
    });
    if (log.score !== undefined) {
      const ev = await getEval(id);
      if (!updateDetail(id, { ev })) return;
      showDriveEvents(map, (ev?.events ?? []).map((e) => ({ lat: e.lat, lon: e.lon, label: eventLabel(e) })));
    }
    updateDetail(id, { routes: await logRoutes(id, track) });
  } catch (e) {
    updateDetail(id, { error: (e as Error).message });
  }
}

/** ログの詳細を閉じて一覧に戻る(地図の軌跡も消す) */
function closeLog() {
  logDetail = null;
  tripDetail = null;
  showTrack(map, []);
  showDriveEvents(map, []);
  renderLogs();
}

// ---- まとめ画像(経路の地図とサマリー) ----

/** いまの国道の総合制覇率(道路データがなければ undefined) */
const kokudoOverall = () => (datasets.kokudo ? percent(computeStats(datasets.kokudo, coverageFor(datasets.kokudo)).overall) : undefined);

/** 地図と文字をまとめて画像にして、枠に出す */
async function finishCard(modal: ReturnType<typeof openCardModal>, lines: CardLine[], info: CardInfo, markers?: { at: [number, number]; color: string }[]) {
  modal.status("地図を描いています…");
  const img = await renderRouteMap(lines, { width: 540, height: 560, markers });
  if (modal.closed) return;
  modal.show(composeCard(img, info), cardFileName(info.title));
}

/** 1本の車のログのまとめ画像 */
async function makeLogCard(id: string) {
  const modal = openCardModal();
  try {
    const store = await storePromise;
    const log = savedLogs?.find((l) => l.id === id) ?? logDetail?.log;
    if (!log) throw new Error("ログが見つかりません");
    const track = trackCache.get(id) ?? parseTrackText(await store.loadLog(id), log.name);
    if (track.length === 0) throw new Error("位置の記録がありません");
    if (modal.closed) return;
    modal.status("通った道路を調べています…");
    const routes = await logRoutes(id, track);
    if (modal.closed) return;
    const stats = logDetail?.log.id === id && logDetail.stats ? logDetail.stats : tripStats(track);
    const coords = thinTrack(track);
    await finishCard(modal, [{ coords, color: carColor() }], logCardInfo(log, stats, routes, kokudoOverall()), [
      { at: coords[0], color: "#2e7d32" },
      { at: coords[coords.length - 1], color: "#d32f2f" },
    ]);
  } catch (e) {
    modal.status(`画像を作れませんでした: ${(e as Error).message}`);
  }
}

/** 地図に出しているもの(期間・旅行、またはチェックしたログ)のまとめ画像 */
async function makeListCard() {
  const items = visibleItems();
  if (items.length === 1 && items[0].kind === "log") return makeLogCard(items[0].log.id);
  const modal = openCardModal();
  if (!items.length) return modal.status("地図に出しているものがありません。一覧の左のチェックを入れてから作ってください。");
  try {
    const store = await storePromise;
    const cars = items.flatMap((i) => (i.kind === "log" ? [i.log] : []));
    const lists: PassedRoute[][] = [];
    let known = true;
    for (const [n, l] of cars.entries()) {
      if (modal.closed) return;
      modal.status(`通った道路を調べています(${n} / ${cars.length})…`);
      let routes = passedCache.get(l.id) ?? null;
      if (!routes || !periodTracks.get(l.id)?.coords.length) {
        try {
          const track = parseTrackText(await store.loadLog(l.id), l.name);
          if (!periodTracks.get(l.id)?.coords.length) periodTracks.set(l.id, { coords: thinTrack(track), start: track.find((p) => p.time !== undefined)?.time });
          routes ??= await logRoutes(l.id, track);
        } catch {
          // 読めないログは線も道路も入れない
        }
      }
      if (routes) lists.push(routes);
      else known = false;
    }
    if (modal.closed) return;
    const lines: CardLine[] = items.flatMap((i) =>
      i.kind === "log" ? [{ coords: periodTracks.get(i.log.id)?.coords ?? [], color: carColor() }] : tripLines(i.trip),
    );
    const journey = logYear === "range" ? journeyOf(journeys, logPeriod) : undefined;
    const only = items.length === 1 ? items[0] : undefined;
    const single = only?.kind === "trip" ? PANEL_MODES.find((m) => m.id === only.trip.mode) : undefined;
    const title = journey ? `🧳 ${journey.name}` : single ? `${single.icon} ${single.label}の記録` : logYear === "range" ? "🧳 旅の記録" : "走った記録";
    const info = periodCardInfo({
      title,
      ...(logYear === "range" ? { from: logPeriod.from, to: logPeriod.to } : {}),
      items,
      // 道路データがないなど、1本も調べられなかったときは欄を出さない
      routes: lists.length || !cars.length ? mergeRoutes(lists) : known ? [] : null,
      overall: kokudoOverall(),
    });
    await finishCard(modal, lines, info);
  } catch (e) {
    modal.status(`画像を作れませんでした: ${(e as Error).message}`);
  }
}

/** ログの一覧と詳細の枠のクリック。ログタブでなければ false(国道の詳細として扱う) */
function onLogClick(e: MouseEvent) {
  if (!logMode) return false;
  const el = e.target as HTMLElement;
  const tripOpen = el.closest<HTMLElement>("[data-trip-open]");
  if (tripOpen) {
    e.preventDefault();
    // 右に旅の記録の詳細(移動手段を直す欄)を出す。開いていたログの軌跡は消す
    if (logDetail) {
      logDetail = null;
      showTrack(map, []);
      showDriveEvents(map, []);
    }
    tripDetail = { id: tripOpen.dataset.tripOpen! };
    renderLogs();
    const box = tripBounds(periodTrips.filter((t) => t.id === tripOpen.dataset.tripOpen));
    if (box) fitBox(map, box, detailPadding());
    return true;
  }
  const toggle = el.closest<HTMLElement>("[data-exclude], [data-include]");
  if (toggle) {
    e.preventDefault();
    const j = journeyOf(journeys, logPeriod);
    if (!j) return true;
    const key = toggle.dataset.exclude ?? toggle.dataset.include!;
    const next = new Set(j.exclude ?? []);
    if (toggle.dataset.exclude) next.add(key);
    else next.delete(key);
    // すぐ画面に反映し、MiniPC に保存する
    j.exclude = [...next];
    void drawSelection(false);
    void setJourneyExclude(j.id, j.exclude).then(
      (list) => (journeys = list),
      (err: Error) => toast([err.message]),
    );
    return true;
  }
  const del = el.closest<HTMLElement>("#journey-delete");
  if (del) {
    const j = journeys.find((x) => x.id === del.dataset.journey);
    if (j && confirm(`旅行「${j.name}」を消しますか?(ログは消えません)`)) {
      void deleteJourney(j.id).then(
        (list) => ((journeys = list), renderLogs()),
        (err: Error) => toast([err.message]),
      );
    }
    return true;
  }
  if (el.closest("#journey-rename")) {
    const j = journeyOf(journeys, logPeriod);
    const name = j && prompt("旅行の名前", j.name)?.trim();
    if (j && name) void saveJourney(name);
    return true;
  }
  const kindTab = el.closest<HTMLElement>("[data-log-kind]");
  if (kindTab) {
    logKind = kindTab.dataset.logKind as LogKind;
    writeJson(LOG_KIND_KEY, logKind);
    renderLogs();
    return true;
  }
  if (el.closest("#show-clear")) {
    shownAll = new Set();
    writeJson(SHOWN_KEY, []);
    void drawSelection(false);
    return true;
  }
  if (el.closest("#period-fit")) {
    fitPeriod();
    return true;
  }
  if (el.closest("#share-card")) {
    void makeListCard();
    return true;
  }
  if (el.closest("#log-share") && logDetail) {
    void makeLogCard(logDetail.log.id);
    return true;
  }
  const open = el.closest<HTMLElement>("[data-log-open]");
  if (open) {
    e.preventDefault();
    void openLog(open.dataset.logOpen!);
    return true;
  }
  if (el.closest("#detail-close")) {
    closeLog();
    return true;
  }
  if (el.closest("#detail-fold")) {
    setMapOnly(!mapOnly());
    return true;
  }
  const evLink = el.closest<HTMLElement>("[data-ev]");
  if (evLink) {
    e.preventDefault();
    const ev = evals.get(evLink.dataset.logId!)?.events[Number(evLink.dataset.ev)];
    if (ev) flyToEvent(map, ev.lat, ev.lon, eventLabel(ev));
    return true;
  }
  const route = el.closest<HTMLElement>("[data-route]");
  if (route) {
    e.preventDefault();
    // 路線のタブに移ってその路線を出す。ログの軌跡は地図に残す
    showDataset(route.dataset.kind as DatasetKind);
    select(route.dataset.route!, true);
  }
  return true;
}
$("log-view").addEventListener("click", onLogClick);

// ログタブ: ↑↓(または J/K)で前後のログへ。文字を打っているときと地図を操作しているときは除く
document.addEventListener("keydown", (e) => {
  if (!logMode || !logDetail || e.altKey || e.ctrlKey || e.metaKey) return;
  const t = e.target as HTMLElement;
  if (t.closest("input, select, textarea, dialog[open], #map")) return;
  const dir = e.key === "ArrowUp" || e.key === "k" ? "prev" : e.key === "ArrowDown" || e.key === "j" ? "next" : null;
  if (!dir) return;
  const to = logNeighbors(logDetail.log.id)[dir];
  e.preventDefault();
  if (to) void openLog(to);
});
/** 地図に出すもののチェック("log:<ID>" / "trip:<走行ID>")を、移動手段を変えたあとの名前に付け替える */
function renameShownKey(from: string, to: string) {
  if (shownAll.delete(from)) {
    shownAll.add(to);
    writeJson(SHOWN_KEY, [...shownAll]);
  }
  let changed = false;
  for (const [p, over] of Object.entries(periodShown)) {
    if (!(from in over)) continue;
    const { [from]: v, ...rest } = over;
    periodShown = { ...periodShown, [p]: { ...rest, [to]: v } };
    changed = true;
  }
  if (changed) writeJson(PERIOD_SHOWN_KEY, periodShown);
}

const modeLabel = (m: ShowMode) => PANEL_MODES.find((x) => x.id === m)?.label ?? m;

/** ログ・旅の記録の詳細で選び直した移動手段を MiniPC に送って直す */
async function fixSessionMode(sel: HTMLSelectElement) {
  const session = sel.dataset.session!;
  const from = sel.dataset.mode as ShowMode;
  const mode = sel.value as ShowMode;
  if (mode === from) return;
  const note =
    mode === "car"
      ? "\n国道の制覇に入れて判定します。"
      : from === "car"
        ? `\n国道の制覇から外し、保存したログで判定し直します${serverJudge ? "(MiniPC で数分かかります)" : ""}。`
        : "";
  if (!confirm(`この記録の移動手段を「${modeLabel(from)}」から「${modeLabel(mode)}」に直しますか?${note}`)) {
    sel.value = from;
    return;
  }
  const oldLog = logDetail?.log.id;
  if (logDetail) logDetail = { ...logDetail, modeBusy: true };
  if (tripDetail) tripDetail = { ...tripDetail, busy: true };
  renderLogDetail();
  try {
    const r = await changeSessionMode(session, mode);
    periodTrips = await loadTravelTrips(true).catch(() => periodTrips);
    const store = await storePromise;
    savedLogs = store.shared ? await store.listLogs().catch(() => savedLogs) : savedLogs;
    const newLog = savedLogs?.find((l) => sessionOfLog(l.name) === session);
    // 直したあとの形(車のログか旅の記録か)で開き直す
    if (mode === "car" && newLog) {
      if (from !== "car") renameShownKey(`trip:${session}`, `log:${newLog.id}`);
      void openLog(newLog.id);
    } else {
      if (oldLog && from === "car") renameShownKey(`log:${oldLog}`, `trip:${session}`);
      logDetail = null;
      showTrack(map, []);
      showDriveEvents(map, []);
      tripDetail = periodTrips.some((t) => t.id === session) ? { id: session } : null;
    }
    void drawSelection(false);
    const lines = [`移動手段を「${modeLabel(r.from)}」から「${modeLabel(r.mode)}」に直しました`];
    if (r.removed) lines.push("国道の制覇から外しました");
    if (mode === "car" && r.gpx && from !== "car") lines.push("国道の制覇に入れて判定します");
    if (mode === "car" && !r.gpx) lines.push("位置の記録がまだ届いていないので、届いたら判定します");
    toast(lines);
    if (r.rejudge === "server") {
      watchedRun = "rejudge";
      await checkJudge();
    } else if (r.rejudge === "browser") {
      // MiniPC で判定する準備がないときは、この画面で判定し直す(確かめてから)
      $("rematch").click();
    } else if (mode === "car") void checkJudge().then(importPending);
  } catch (err) {
    toast([(err as Error).message]);
    if (logDetail) logDetail = { ...logDetail, modeBusy: false };
    if (tripDetail) tripDetail = { ...tripDetail, busy: false };
    renderLogs();
  }
}
$("detail").addEventListener("change", (e) => {
  const el = e.target as HTMLElement;
  if (el instanceof HTMLSelectElement && el.id === "session-mode") void fixSessionMode(el);
});

/** いまの期間を旅行として保存する(同じ期間なら名前を変える) */
async function saveJourney(name: string) {
  try {
    journeys = await addJourney(name, logPeriod);
    renderLogs();
    toast([`🧳 旅行「${name}」を保存しました`]);
  } catch (err) {
    toast([(err as Error).message]);
  }
}
$("log-view").addEventListener("submit", (e) => {
  if ((e.target as HTMLElement).id !== "journey-save") return;
  e.preventDefault();
  const name = $<HTMLInputElement>("journey-name").value.trim();
  if (name) void saveJourney(name);
});
$("log-view").addEventListener("change", (e) => {
  const el = e.target as HTMLInputElement | HTMLSelectElement;
  if (el instanceof HTMLInputElement && el.dataset.show) {
    setShown(el.dataset.show, el.checked);
    return;
  }
  if (el.id === "log-from" || el.id === "log-to") {
    const p = makePeriod($<HTMLInputElement>("log-from").value, $<HTMLInputElement>("log-to").value);
    if (!p) return;
    logPeriod = p;
    savePeriod(p);
    void drawSelection(true);
    return;
  }
  if (el.id !== "log-year") return;
  // 保存した旅行を選んだら、その期間を出す
  const j = el.value.startsWith("journey:") ? journeys.find((x) => `journey:${x.id}` === el.value) : undefined;
  if (j) {
    logPeriod = { from: j.from, to: j.to };
    savePeriod(logPeriod);
    logYear = "range";
    void drawSelection(true);
    renderLogs();
    return;
  }
  logYear = el.value;
  void drawSelection(logYear === "range");
  renderLogs();
});

// 路線名を押したら、その路線を地図で表示する
$("game-body").addEventListener("click", (e) => {
  const el = e.target as HTMLElement;
  if (el.closest("#open-logs")) {
    $<HTMLDialogElement>("game").close();
    showLogs();
    return;
  }
  if (el.closest("#pref-fill")) {
    prefFill = !prefFill;
    renderGame();
    return;
  }
  const pref = el.closest<HTMLElement>("[data-pref]");
  if (pref && prefShapes) {
    $<HTMLDialogElement>("game").close();
    prefFill = true;
    select(null, false);
    fitPref(map, prefShapes, Number(pref.dataset.pref));
    return;
  }
  const a = el.closest<HTMLElement>("[data-route]");
  if (!a) return;
  e.preventDefault();
  $<HTMLDialogElement>("game").close();
  const kind = a.dataset.kind as DatasetKind;
  if (kind !== active) showDataset(kind);
  select(a.dataset.route!, true);
});
$("toast").addEventListener("click", () => $("toast").classList.remove("show"));
