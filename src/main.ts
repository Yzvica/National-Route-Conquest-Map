import "./style.css";
import { categoryBreakdown, overlapsOf, type BreakdownItem } from "./breakdown";
import { addRoutes, createMap, fitSegments, paintCoverage, showFocus, showSelected, showTrack } from "./map";
import { matchTrack } from "./matcher";
import { parseTrackFile } from "./parsers";
import { computeStats, percent, type Progress } from "./stats";
import { emptyRecord, exportBackup, importBackup, openStore, type Record } from "./store";
import { CATEGORY_LABELS, type Category, type RouteData, type TrackPoint } from "./types";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const status = $("status");

let record: Record = emptyRecord();
const storePromise = openStore();
let data: RouteData | null = null;
/** 選んでいる国道番号 */
let selected: string | null = null;
/** 種別ごとの内訳で開いているもの(描き直しても開いたままにする) */
const openCats = new Set<Category>();
/** 内訳の行(data-item)から、その区間を引けるようにしておく */
let breakdownItems = new Map<string, BreakdownItem>();
/** 内訳を出す種別。現道は路線一覧と同じになるので出さない */
const BREAKDOWN_CATS: Category[] = ["bypass", "dotted", "ferry", "overlap"];

const map = createMap($("map"));
const km = (m: number) => (m / 1000).toLocaleString("ja-JP", { maximumFractionDigits: 1 });
const routeName = (ref: string) => data?.routes[ref]?.name ?? `国道${ref}号`;

function row(label: string, p: Progress): string {
  const pct = percent(p);
  return `<div class="row"><span>${label}</span><span>${pct.toFixed(1)}%</span>
    <div class="bar"><span style="width:${pct}%"></span></div>
    <span class="muted">${km(p.done)} / ${km(p.total)} km</span></div>`;
}

function render() {
  if (!data) return;
  const stats = computeStats(data, record.coverage);
  $("overall").innerHTML = `<h2>総合制覇率</h2><div class="big">${percent(stats.overall).toFixed(2)}%</div>
    <p class="muted">${km(stats.overall.done)} / ${km(stats.overall.total)} km(重複区間は1回だけ数えています)</p>`;
  breakdownItems = new Map();
  $("categories").innerHTML =
    "<h2>種別ごと</h2>" +
    (Object.keys(CATEGORY_LABELS) as Category[])
      .filter((c) => stats.byCategory[c].total > 0)
      .map((c) => {
        const head = row(CATEGORY_LABELS[c], stats.byCategory[c]);
        if (!BREAKDOWN_CATS.includes(c)) return head;
        // 開いているときだけ内訳を作る(バイパスは数百路線ある)
        const items = openCats.has(c) ? categoryBreakdown(data!, record.coverage, c) : [];
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
    .filter((r) => !filter || r.startsWith(filter))
    .sort((a, b) => Number(a) - Number(b) || a.localeCompare(b));
  $("routes").innerHTML = refs
    .map((r) => `<li data-ref="${r}"${r === selected ? ' class="selected"' : ""}>${row(routeName(r), stats.byRoute.get(r)!.overall)}</li>`)
    .join("");
  paintCoverage(map, data, record.coverage);
  renderDetail(stats);
}

/** 選んだ国道の詳細を地図の上に出す */
function renderDetail(stats: ReturnType<typeof computeStats>) {
  if (!data) return;
  const box = $("detail");
  const route = selected ? stats.byRoute.get(selected) : undefined;
  showSelected(map, data, route ? selected : null, record.coverage);
  if (!selected || !route) {
    box.hidden = true;
    return;
  }
  const segs = data.segments.filter((s) => s.routes.includes(selected!));
  const passed = segs.filter((s) => (record.coverage.get(s.id) ?? 0) > 0).length;
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
  const items = overlapsOf(data!, record.coverage, ref);
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

async function loadData() {
  const res = await fetch(`${import.meta.env.BASE_URL}data/routes.json`);
  if (!res.ok) throw new Error("国道データ(data/routes.json)がありません。README の手順で作成してください。");
  return (await res.json()) as RouteData;
}

map.on("load", async () => {
  try {
    const store = await storePromise;
    [data, record] = await Promise.all([loadData(), store.load()]);
    addRoutes(map, data, (id) => record.dates.get(id), (ref) => select(ref, false));
    status.textContent =
      `国道データ: ${Object.keys(data.routes).length} 路線(${data.generatedAt.slice(0, 10)} 時点)` +
      (store.shared ? " / 記録は MiniPC に保存されます" : " / 記録はこのブラウザに保存されます");
    render();
  } catch (e) {
    status.textContent = (e as Error).message;
  }
});

/** ログの日付(YYYY-MM-DD、端末の時刻帯)。ログに時刻がなければファイルの更新日を使う */
function logDate(track: TrackPoint[], file: File): string {
  const d = new Date(track.find((p) => p.time !== undefined)?.time ?? file.lastModified);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const isTrackFile = (f: File) => /\.(csv|gpx)$/i.test(f.name);

async function importFiles(files: File[]) {
  if (!data) return;
  const store = await storePromise;
  const passed = new Set<string>();
  const failed: string[] = [];
  for (const [i, file] of files.entries()) {
    status.textContent = `${file.name} を判定中…(${i + 1} / ${files.length})`;
    try {
      const track = await parseTrackFile(file);
      const result = matchTrack(data, track);
      const day = logDate(track, file);
      const dates = new Map([...result.keys()].map((id) => [id, [day, day] as [string, string]]));
      const log = { name: file.name, importedAt: new Date().toISOString(), points: track.length };
      record = await store.add({ coverage: result, dates, logs: [log] });
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
}

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
    const shared = overlapsOf(data, record.coverage, selected).find((o) => o.key === el.dataset.show);
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
  record = await store.add(importBackup(await file.text()));
  render();
});

$("reset").addEventListener("click", async () => {
  const store = await storePromise;
  const where = store.shared ? "すべての端末の" : "";
  if (!confirm(`${where}走行記録をすべて消します。よろしいですか?`)) return;
  await store.clear();
  record = emptyRecord();
  render();
});
