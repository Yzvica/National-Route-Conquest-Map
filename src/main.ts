import "./style.css";
import { categoryBreakdown, overlapsOf, type BreakdownItem } from "./breakdown";
import { buildContext, computeLevel, evaluateAchievements, type GameContext } from "./game";
import { achievementsView, challengesView, levelCard, reviewView } from "./gameView";
import { addRoutes, clearRoutes, createMap, fitSegments, paintCoverage, showFocus, showSelected, showTrack } from "./map";
import { matchTrack } from "./matcher";
import { parseTrackFile } from "./parsers";
import { computeStats, effectiveCoverage, percent, type Progress } from "./stats";
import { emptyRecord, exportBackup, importBackup, openStore, type Record } from "./store";
import {
  CATEGORY_LABELS,
  DATASET_LABELS,
  type Category,
  type Coverage,
  type DatasetKind,
  type RouteData,
  type TrackPoint,
} from "./types";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const status = $("status");

let record: Record = emptyRecord();
const storePromise = openStore();
/** 読み込んだ道路データ(国道・高速道路) */
const datasets: Partial<{ [K in DatasetKind]: RouteData }> = {};
const DATA_FILES: { [K in DatasetKind]: string } = { kokudo: "routes.json", expressway: "expressways.json" };
/** 画面に出しているデータ */
let active: DatasetKind = "kokudo";
let data: RouteData | null = null;
/** 選んでいる路線(国道番号か、高速道路の名前) */
let selected: string | null = null;
/** 種別ごとの内訳で開いているもの(描き直しても開いたままにする) */
const openCats = new Set<Category>();
/** 内訳の行(data-item)から、その区間を引けるようにしておく */
let breakdownItems = new Map<string, BreakdownItem>();
/** 内訳を出す種別。現道は路線一覧と同じになるので出さない */
const BREAKDOWN_CATS: Category[] = (Object.keys(CATEGORY_LABELS) as Category[]).filter((c) => c !== "main");

const map = createMap($("map"));
const km = (m: number) => (m / 1000).toLocaleString("ja-JP", { maximumFractionDigits: 1 });
const routeName = (ref: string) => data?.routes[ref]?.name ?? (active === "kokudo" ? `国道${ref}号` : ref);

/** 上下線のどちらかを走れば両方走ったことにした記録 */
const coverage = (): Coverage => (data ? coverageFor(data) : record.coverage);

/** データごとの、上下線をならした記録 */
const effectiveCache = new WeakMap<RouteData, { raw: Coverage; cov: Coverage }>();
function coverageFor(d: RouteData): Coverage {
  const hit = effectiveCache.get(d);
  if (hit?.raw === record.coverage) return hit.cov;
  const cov = effectiveCoverage(d, record.coverage);
  effectiveCache.set(d, { raw: record.coverage, cov });
  return cov;
}

// ---- ゲーム要素(実績・レベル・チャレンジ・振り返り) ----

/** 記録が変わったときだけ作り直す */
let gameCache: { cov: Coverage; dates: Record["dates"]; n: number; ctx: GameContext } | null = null;
function gameContext(): GameContext {
  const n = Object.keys(datasets).length;
  if (gameCache?.cov !== record.coverage || gameCache.dates !== record.dates || gameCache.n !== n) {
    gameCache = { cov: record.coverage, dates: record.dates, n, ctx: buildContext(datasets, coverageFor, record.dates) };
  }
  return gameCache.ctx;
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

type GameTab = "achievements" | "challenges" | "review";
let gameTab: GameTab = "achievements";

function renderGame() {
  if (!datasets.kokudo) return;
  const g = gameState();
  $("level").innerHTML = levelCard(g.level, g.unlocked.length, g.achievements.length);
  const dialog = $<HTMLDialogElement>("game");
  if (!dialog.open) return;
  for (const b of $("game-tabs").querySelectorAll<HTMLButtonElement>("button")) {
    b.setAttribute("aria-selected", String(b.dataset.game === gameTab));
  }
  const body = $("game-body");
  if (gameTab === "achievements") body.innerHTML = achievementsView(g.achievements, g.level);
  else if (data) {
    const summary = g.ctx[active]!;
    body.innerHTML =
      gameTab === "challenges"
        ? challengesView(g.ctx, today(), { kind: active, data, summary, coverage: coverage() }, routeName)
        : reviewView(summary, today(), routeName, active);
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

function render() {
  if (!data) return;
  const stats = computeStats(data, coverage());
  $("overall").innerHTML = `<h2>総合制覇率</h2><div class="big">${percent(stats.overall).toFixed(2)}%</div>
    <p class="muted">${km(stats.overall.done)} / ${km(stats.overall.total)} km(重複区間は1回だけ数えています${
      active === "expressway" ? "。上下線はどちらかを走れば制覇" : ""
    })</p>`;
  breakdownItems = new Map();
  $("categories").innerHTML =
    "<h2>種別ごと</h2>" +
    (Object.keys(CATEGORY_LABELS) as Category[])
      .filter((c) => stats.byCategory[c].total > 0)
      .map((c) => {
        const head = row(CATEGORY_LABELS[c], stats.byCategory[c]);
        if (!BREAKDOWN_CATS.includes(c)) return head;
        // 開いているときだけ内訳を作る(バイパスは数百路線ある)
        const items = openCats.has(c) ? categoryBreakdown(data!, coverage(), c) : [];
        const list = items
          .map((item) => {
            const key = `${c}:${item.key}`;
            breakdownItems.set(key, item);
            return `<li data-item="${key}">${row(item.refs.map(routeName).join("・"), item.progress)}</li>`;
          })
          .join("");
        return `<details data-cat="${c}"${openCats.has(c) ? " open" : ""}><summary>${head}</summary>
          <ol class="breakdown">${list}</ol></details>`;
      })
      .join("");

  const filter = $<HTMLInputElement>("route-filter").value.trim();
  const refs = [...stats.byRoute.keys()]
    .filter((r) => !filter || (active === "kokudo" ? r.startsWith(filter) : routeName(r).includes(filter)))
    .sort(active === "kokudo" ? (a, b) => Number(a) - Number(b) || a.localeCompare(b) : (a, b) => order(a) - order(b));
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
      <button id="detail-close" type="button" aria-label="閉じる">×</button></div>
    <div class="big">${percent(p).toFixed(1)}%</div>
    <div class="bar"><span style="width:${percent(p)}%"></span></div>
    <p class="muted">走行済み ${km(p.done)} km / 全長 ${km(p.total)} km(未踏破 ${km(p.total - p.done)} km)</p>
    ${(Object.keys(CATEGORY_LABELS) as Category[])
      .filter((c) => route.byCategory[c])
      .map((c) => row(CATEGORY_LABELS[c], route.byCategory[c]!))
      .join("")}
    <p class="muted">通過した区間 ${passed.toLocaleString("ja-JP")} / ${segs.length.toLocaleString("ja-JP")}<br>
      ${dates.length ? `初めて ${dates[0]} / 最後 ${dates[dates.length - 1]}` : "まだ通過していません"}</p>
    ${overlapList(selected)}
    <p class="legend"><span class="sw done"></span>走行済み <span class="sw part"></span>一部 <span class="sw todo"></span>未踏破</p>
    <button id="detail-fit" type="button">全体を表示</button>`;
  box.hidden = false;
}

/** 選んだ国道と重なっているほかの国道。名前を押すとその国道へ、「場所」で重なっている区間を映す */
function overlapList(ref: string): string {
  const items = overlapsOf(data!, coverage(), ref);
  if (items.length === 0) return "";
  return `<details class="overlaps" open><summary>重複している国道(${items.length})</summary><ul>
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
  render();
  if (data) showFocus(map, data, Array.isArray(fit) ? fit : []);
  if (fit) fitSelected(Array.isArray(fit) ? fit : undefined);
}

async function loadData(kind: DatasetKind) {
  const res = await fetch(`${import.meta.env.BASE_URL}data/${DATA_FILES[kind]}`);
  if (!res.ok) throw new Error(`${DATASET_LABELS[kind]}のデータ(data/${DATA_FILES[kind]})がありません。README の手順で作成してください。`);
  return (await res.json()) as RouteData;
}

/** 国道と高速道路を切り替える */
function showDataset(kind: DatasetKind) {
  active = kind;
  for (const b of $("tabs").querySelectorAll<HTMLButtonElement>("button")) {
    b.setAttribute("aria-selected", String(b.dataset.kind === kind));
  }
  $("routes-title").textContent = kind === "kokudo" ? "国道別" : "路線別";
  $<HTMLInputElement>("route-filter").placeholder = kind === "kokudo" ? "番号で絞り込み(例: 1)" : "名前で絞り込み(例: 東名)";
  $<HTMLInputElement>("route-filter").value = "";
  selected = null;
  openCats.clear();
  data = datasets[kind] ?? null;
  if (!data) {
    clearRoutes(map);
    for (const id of ["overall", "categories", "routes"]) $(id).innerHTML = "";
    $("detail").hidden = true;
    status.textContent = `${DATASET_LABELS[kind]}のデータ(data/${DATA_FILES[kind]})がまだありません`;
    return;
  }
  addRoutes(map, data, (id) => record.dates.get(id), (ref) => select(ref, false));
  render();
}

map.on("load", async () => {
  try {
    const store = await storePromise;
    const [kokudo, expressway, rec] = await Promise.all([
      loadData("kokudo"),
      loadData("expressway").catch(() => undefined),
      store.load(),
    ]);
    datasets.kokudo = kokudo;
    datasets.expressway = expressway;
    record = rec;
    $("rematch").hidden = !store.shared;
    showDataset(active);
    status.textContent =
      `国道データ: ${Object.keys(kokudo.routes).length} 路線` +
      (expressway ? ` / 高速道路: ${Object.keys(expressway.routes).length} 路線` : "") +
      `(${kokudo.generatedAt.slice(0, 10)} 時点)` +
      (store.shared ? " / 記録は MiniPC に保存されます" : " / 記録はこのブラウザに保存されます");
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

/** 読み込んだすべてのデータ(国道・高速道路)で判定し、区間ごとに大きいほうをとる */
function matchAll(track: TrackPoint[]): Coverage {
  const out: Coverage = new Map();
  for (const d of Object.values(datasets)) {
    if (!d) continue;
    for (const [id, r] of matchTrack(d, track)) out.set(id, Math.max(out.get(id) ?? 0, r));
  }
  return out;
}

/**
 * ログを判定して記録に足す。save なら MiniPC にログも残す(あとで判定し直せるように)。
 * logEntry が false のときは読み込み履歴を増やさない(判定し直し用)。
 */
async function importFiles(files: File[], opts: { save: boolean; logEntry: boolean } = { save: true, logEntry: true }) {
  if (!data) return;
  const store = await storePromise;
  const before = gameState();
  const passed = new Set<string>();
  const failed: string[] = [];
  for (const [i, file] of files.entries()) {
    status.textContent = `${file.name} を判定中…(${i + 1} / ${files.length})`;
    try {
      const track = await parseTrackFile(file);
      if (opts.save) await store.saveLog(file.name, await file.text()).catch(() => undefined);
      const result = matchAll(track);
      const day = logDate(track, file);
      const dates = new Map([...result.keys()].map((id) => [id, [day, day] as [string, string]]));
      const logs = opts.logEntry ? [{ name: file.name, importedAt: new Date().toISOString(), points: track.length }] : [];
      record = await store.add({ coverage: result, dates, logs });
      for (const id of result.keys()) passed.add(id);
      showTrack(map, track);
    } catch (e) {
      failed.push(`${file.name}: ${(e as Error).message}`);
    }
  }
  const ok = files.length - failed.length;
  status.textContent =
    `${ok} ファイルを読み込み、${passed.size} 区間を通過しました` + (failed.length ? `(読めなかったもの: ${failed.join(" / ")})` : "");
  render();
  announce(before);
}

// MiniPC に保存してあるログをすべて判定し直す(高速道路のデータを足したあとなど)
$("rematch").addEventListener("click", async () => {
  const store = await storePromise;
  const saved = await store.listLogs();
  if (saved.length === 0) {
    status.textContent = "保存してあるログがまだありません(これから読み込むログは保存されます)";
    return;
  }
  if (!confirm(`保存してある ${saved.length} 件のログで判定し直します。少し時間がかかります。よろしいですか?`)) return;
  const files: File[] = [];
  for (const l of saved) files.push(new File([await store.loadLog(l.id)], l.name, { lastModified: Number(l.id.split("-")[0]) || Date.now() }));
  await importFiles(files, { save: false, logEntry: false });
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

$("route-filter").addEventListener("input", render);
$("routes").addEventListener("click", (e) => {
  const li = (e.target as HTMLElement).closest("li");
  if (li?.dataset.ref) select(li.dataset.ref, true);
});
$("detail").addEventListener("click", (e) => {
  const el = e.target as HTMLElement;
  if (el.id === "detail-close") select(null, false);
  if (el.id === "detail-fit") fitSelected();
  if (el.dataset.jump) {
    e.preventDefault();
    select(el.dataset.jump, true);
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
$("categories").addEventListener("click", (e) => {
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
  const a = (e.target as HTMLElement).closest<HTMLElement>("[data-route]");
  if (!a) return;
  e.preventDefault();
  $<HTMLDialogElement>("game").close();
  const kind = a.dataset.kind as DatasetKind;
  if (kind !== active) showDataset(kind);
  select(a.dataset.route!, true);
});
$("toast").addEventListener("click", () => $("toast").classList.remove("show"));
