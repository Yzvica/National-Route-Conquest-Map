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
import {
  addRoutes,
  clearRoutes,
  createMap,
  fitPref,
  fitSegments,
  paintCoverage,
  showFocus,
  showPrefFill,
  showSelected,
  showTrack,
  type PrefShapes,
} from "./map";
import { matchTrack } from "./matcher";
import { parseTrackFile } from "./parsers";
import { REGIONS, prefName } from "./prefs";
import { comparePrefRefs, mergePrefData, prefFileName, prefsOfTrack, splitPrefRef } from "./prefroads";
import { trackLength, tripKey } from "./trips";
import { REFERENCE_CATS, SEPARATE_CATS, applyDeclared, computeStats, effectiveCoverage, percent, type Progress } from "./stats";
import { emptyRecord, exportBackup, importBackup, mergeRecord, openStore, type Record } from "./store";
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
// toLocaleString は呼ぶたびに書式を作り直して遅い(一覧の描き直しで数百回呼ぶ)ので、書式は一度だけ作る
const kmFormat = new Intl.NumberFormat("ja-JP", { maximumFractionDigits: 1 });
const km = (m: number) => kmFormat.format(m / 1000);
const routeName = (ref: string) => data?.routes[ref]?.name ?? (active === "kokudo" ? `国道${ref}号` : ref);
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

/** 選んだ路線の区間の通称(都道府県道の「三宿通り」など)。「場所」でその区間を映す */
function nicknameList(ref: string): string {
  if (active !== "prefroad") return "";
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

/** 詳細の枠に路線が隠れないよう、その分の余白をとって全体(または ids の区間)を映す */
function fitSelected(ids?: string[]) {
  if (!data || !selected) return;
  const box = $("detail");
  const pad = { top: 40, bottom: 40, left: 40, right: 40 };
  // スマホでは枠が地図の外にあるので余白は要らない
  if (getComputedStyle(box).position === "absolute") pad.right += Math.min(box.offsetWidth, $("map").clientWidth / 2);
  map.resize(); // スマホでは枠が出た分だけ地図が縮むので、先に大きさを合わせる
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
  const res = await fetch(`${import.meta.env.BASE_URL}data/${DATA_FILES[kind]}`);
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
  box.hidden = active !== "prefroad" || !prefIndex;
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
  for (const b of $("tabs").querySelectorAll<HTMLButtonElement>("button")) {
    b.setAttribute("aria-selected", String(b.dataset.kind === kind));
  }
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
    const statusText = (expressway?: RouteData) =>
      `国道データ: ${Object.keys(kokudo.routes).length} 路線` +
      (expressway ? ` / 高速道路: ${Object.keys(expressway.routes).length} 路線` : " / 高速道路のデータを読み込み中…") +
      `(${kokudo.generatedAt.slice(0, 10)} 時点)` +
      (store.shared ? " / 記録は MiniPC に保存されます" : " / 記録はこのブラウザに保存されます");
    if (active === "kokudo") showDataset(active);
    status.textContent = statusText();
    // 都道府県道の一覧(小さい)。都道府県ごとのファイルは、タブを開いたときやログの判定のときに読む
    prefIndexReady = loadPrefIndex().then(() => {
      if (active === "prefroad") showDataset(active);
    });
    let done = () => {};
    expresswayReady = new Promise((ok) => (done = ok));
    const expressway = await loadData("expressway").catch(() => undefined);
    datasets.expressway = expressway;
    done();
    if (active === "expressway") showDataset(active);
    else render(); // 実績やレベルに高速道路の分を足す
    status.textContent = statusText(expressway).replace(" / 高速道路のデータを読み込み中…", "");
  } catch (e) {
    status.textContent = (e as Error).message;
  }
});

$("tabs").addEventListener("click", (e) => {
  const kind = (e.target as HTMLElement).closest<HTMLElement>("button")?.dataset.kind as DatasetKind | undefined;
  if (kind && kind !== active) showDataset(kind);
});

/** ログの日付(YYYY-MM-DD、端末の時刻帯)。ログに時刻がなければファイルの更新日を使う */
function logDate(track: TrackPoint[], file: File): string {
  const d = new Date(track.find((p) => p.time !== undefined)?.time ?? file.lastModified);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const isTrackFile = (f: File) => /\.(csv|gpx)$/i.test(f.name);

/**
 * 国道・高速道路と、ログが通った都道府県の都道府県道で判定し、区間ごとに大きいほうをとる。
 * 都道府県道は画面に出していない都道府県の分も判定する(あとでその都道府県を選んだときに記録があるように)
 */
async function matchAll(track: TrackPoint[]): Promise<Coverage> {
  const out: Coverage = new Map();
  const add = (d: RouteData) => {
    for (const [id, r] of matchTrack(d, track)) out.set(id, Math.max(out.get(id) ?? 0, r));
  };
  for (const kind of ["kokudo", "expressway"] as const) {
    const d = datasets[kind];
    if (d) add(d);
  }
  if (prefIndex) {
    for (const code of prefsOfTrack(prefIndex, track)) {
      const d = await loadPrefFile(code);
      if (d) add(d);
    }
  }
  return out;
}

/**
 * ログを判定して記録に足す。save なら MiniPC にログも残す(あとで判定し直せるように)。
 * logEntry が false のときは読み込み履歴を増やさない(判定し直し用)。
 * replace なら、今の通った区間の記録を、これらのログで判定した結果で置き換える(前の判定の誤りを消す)。
 */
async function importFiles(
  files: File[],
  opts: { save: boolean; logEntry: boolean; replace?: boolean } = { save: true, logEntry: true },
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
      const track = await parseTrackFile(file);
      if (opts.save) await store.saveLog(file.name, await file.text()).catch(() => undefined);
      const result = await matchAll(track);
      const day = logDate(track, file);
      const dates = new Map([...result.keys()].map((id) => [id, [day, day] as [string, string]]));
      const logs = opts.logEntry ? [{ name: file.name, importedAt: new Date().toISOString(), points: track.length }] : [];
      const trips = new Map([[tripKey(track, day), { date: day, m: Math.round(trackLength(track)) }]]);
      const added = { coverage: result, dates, logs, declared: new Map(), trips };
      if (opts.replace) pending = mergeRecord(pending, added);
      else record = await store.add(added);
      for (const id of result.keys()) passed.add(id);
      showTrack(map, track);
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
}

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
        `今の記録は MiniPC の data/backup に控えを残します。よろしいですか?`,
    )
  )
    return;
  const files: File[] = [];
  for (const l of saved) files.push(new File([await store.loadLog(l.id)], l.name, { lastModified: Number(l.id.split("-")[0]) || Date.now() }));
  await importFiles(files, { save: false, logEntry: false, replace: true });
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

$("route-filter").addEventListener("input", render);
$("routes").addEventListener("click", (e) => {
  const li = (e.target as HTMLElement).closest("li");
  if (li?.dataset.ref) select(li.dataset.ref, true);
});
$("detail").addEventListener("click", (e) => {
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
// 路線名を押したら、その路線を地図で表示する
$("game-body").addEventListener("click", (e) => {
  const el = e.target as HTMLElement;
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
