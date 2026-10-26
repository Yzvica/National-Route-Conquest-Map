import "./style.css";
import { addRoutes, createMap, fitRoute, paintCoverage, showTrack } from "./map";
import { matchTrack, mergeCoverage } from "./matcher";
import { parseTrackFile } from "./parsers";
import { computeStats, percent, type Progress } from "./stats";
import { exportBackup, importBackup, loadCoverage, loadLogs, saveCoverage, saveLogs } from "./store";
import { CATEGORY_LABELS, type Category, type RouteData } from "./types";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const status = $("status");

let coverage = loadCoverage();
let logs = loadLogs();
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
  const stats = computeStats(data, coverage);
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
  paintCoverage(map, coverage);
}

async function loadData() {
  const res = await fetch(`${import.meta.env.BASE_URL}data/routes.json`);
  if (!res.ok) throw new Error("国道データ(data/routes.json)がありません。README の手順で作成してください。");
  return (await res.json()) as RouteData;
}

map.on("load", async () => {
  try {
    data = await loadData();
    addRoutes(map, data);
    status.textContent = `国道データ: ${Object.keys(data.routes).length} 路線(${data.generatedAt.slice(0, 10)} 時点)`;
    render();
  } catch (e) {
    status.textContent = (e as Error).message;
  }
});

$<HTMLInputElement>("file").addEventListener("change", async (ev) => {
  const input = ev.target as HTMLInputElement;
  if (!data || !input.files) return;
  for (const file of Array.from(input.files)) {
    status.textContent = `${file.name} を判定中…`;
    try {
      const track = await parseTrackFile(file);
      const result = matchTrack(data, track);
      coverage = mergeCoverage(coverage, result);
      logs = [...logs, { name: file.name, importedAt: new Date().toISOString(), points: track.length }];
      showTrack(map, track);
      status.textContent = `${file.name}: ${track.length} 点を読み込み、${result.size} 区間を通過しました`;
    } catch (e) {
      status.textContent = `${file.name}: ${(e as Error).message}`;
    }
  }
  saveCoverage(coverage);
  saveLogs(logs);
  input.value = "";
  render();
});

$("route-filter").addEventListener("input", render);
$("routes").addEventListener("click", (e) => {
  const li = (e.target as HTMLElement).closest("li");
  if (data && li?.dataset.ref) fitRoute(map, data, li.dataset.ref);
});

$("export").addEventListener("click", () => {
  const blob = new Blob([exportBackup(coverage, logs)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `kokudo-record-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
});

$<HTMLInputElement>("import").addEventListener("change", async (ev) => {
  const file = (ev.target as HTMLInputElement).files?.[0];
  if (!file) return;
  const b = importBackup(await file.text());
  coverage = mergeCoverage(coverage, b.coverage);
  logs = [...logs, ...b.logs];
  saveCoverage(coverage);
  saveLogs(logs);
  render();
});

$("reset").addEventListener("click", () => {
  if (!confirm("走行記録をすべて消します。よろしいですか?")) return;
  coverage = new Map();
  logs = [];
  saveCoverage(coverage);
  saveLogs(logs);
  render();
});
