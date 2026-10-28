import "./style.css";
import { addRoutes, createMap, fitRoute, paintCoverage, showTrack } from "./map";
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
  $("categories").innerHTML =
    "<h2>種別ごと</h2>" +
    (Object.keys(CATEGORY_LABELS) as Category[])
      .filter((c) => stats.byCategory[c].total > 0)
      .map((c) => row(CATEGORY_LABELS[c], stats.byCategory[c]))
      .join("");

  const filter = $<HTMLInputElement>("route-filter").value.trim();
  const refs = [...stats.byRoute.keys()]
    .filter((r) => !filter || r.startsWith(filter))
    .sort((a, b) => Number(a) - Number(b) || a.localeCompare(b));
  $("routes").innerHTML = refs
    .map((r) => `<li data-ref="${r}">${row(routeName(r), stats.byRoute.get(r)!.overall)}</li>`)
    .join("");
  paintCoverage(map, record.coverage);
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
    addRoutes(map, data, (id) => record.dates.get(id));
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
  if (data && li?.dataset.ref) fitRoute(map, data, li.dataset.ref);
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
