// 国道ナビの画面。地図を押して点を並べると、国道だけを通る道筋と Google マップのリンクを作る(計算は navi.ts)。
import * as maplibregl from "maplibre-gl";
import type { GeoJSONSource } from "maplibre-gl";
import { muteRoadClicks } from "./map";
import { RoadGraph, bboxOf, linksText, planNavi, segmentsIn, type NaviPlan, type NaviPoint } from "./navi";
import { splitLoaderOf } from "./splitData";
import type { RouteData } from "./types";

export interface NaviContext {
  map: maplibregl.Map;
  /** 国道のデータ(まだ読んでいなければ undefined) */
  kokudo: () => RouteData | undefined;
  routeName: (ref: string) => string;
  toast: (lines: string[]) => void;
}

const POINTS_KEY = "kokudo-navi-points";
const PER_LINK_KEY = "kokudo-navi-per-link";
/** リンクごとの経由地の色 */
const COLORS = ["#1a73e8", "#e8710a", "#188038", "#a142f4", "#d01884", "#12b5cb"];

let ctx: NaviContext | null = null;
let panel: HTMLElement | null = null;
let points: NaviPoint[] = [];
let labels: string[] = [];
let markers: maplibregl.Marker[] = [];
let plan: NaviPlan | null = null;
let message = "";
let busy = false;
/** 開いたときに、道筋が見えるよう地図を動かす */
let fitNext = false;
let timer = 0;
let graphCache: { data: RouteData; box: string; graph: RoadGraph } | null = null;

const readJson = <T,>(key: string, fallback: T): T => {
  try {
    const v = localStorage.getItem(key);
    return v ? (JSON.parse(v) as T) : fallback;
  } catch {
    return fallback;
  }
};
const writeJson = (key: string, v: unknown) => {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {
    // 保存できなくても使える
  }
};
const perLink = () => readJson<number>(PER_LINK_KEY, 9);

export const naviOpen = () => !!panel && !panel.hidden;

export function openNavi(c: NaviContext) {
  ctx = c;
  if (!panel) {
    panel = document.createElement("section");
    panel.id = "navi";
    panel.className = "navi";
    c.map.getContainer().append(panel);
    panel.addEventListener("click", onPanelClick);
    // 地図の操作(押す・ドラッグ・ズーム)として扱わない
    for (const t of ["mousedown", "touchstart", "dblclick", "wheel", "pointerdown"]) panel.addEventListener(t, (e) => e.stopPropagation());
    panel.addEventListener("change", onPanelChange);
    c.map.on("click", onMapClick);
    c.map.on("styledata", keepOnTop);
    points = readJson<NaviPoint[]>(POINTS_KEY, []);
  }
  panel.hidden = false;
  fitNext = true;
  muteRoadClicks(true);
  drawMarkers();
  render();
  schedule();
}

export function closeNavi() {
  if (!panel || !ctx) return;
  panel.hidden = true;
  muteRoadClicks(false);
  for (const m of markers) m.remove();
  markers = [];
  drawPlan(null);
}

function onMapClick(e: maplibregl.MapMouseEvent) {
  if (!naviOpen() || !ctx) return;
  // 経由地の丸を押したときは、その説明を出すだけ
  if (ctx.map.getLayer("navi-wp") && ctx.map.queryRenderedFeatures(e.point, { layers: ["navi-wp"] }).length) return;
  points.push({ lon: round5(e.lngLat.lng), lat: round5(e.lngLat.lat) });
  changed();
}

const round5 = (v: number) => Math.round(v * 1e5) / 1e5;

function changed() {
  writeJson(POINTS_KEY, points);
  drawMarkers();
  render();
  schedule();
}

function schedule() {
  clearTimeout(timer);
  timer = window.setTimeout(() => void compute(), 250);
}

function pointLabel(i: number) {
  if (i === 0) return "出発";
  if (i === points.length - 1 && points.length > 1) return "到着";
  return `${i}`;
}

function drawMarkers() {
  if (!ctx) return;
  for (const m of markers) m.remove();
  markers = points.map((p, i) => {
    const el = document.createElement("div");
    el.className = "navi-pin";
    el.textContent = i === 0 ? "S" : i === points.length - 1 && points.length > 1 ? "G" : String(i);
    const m = new maplibregl.Marker({ element: el, draggable: true }).setLngLat([p.lon, p.lat]).addTo(ctx!.map);
    m.on("dragend", () => {
      const ll = m.getLngLat();
      points[i] = { lon: round5(ll.lng), lat: round5(ll.lat) };
      changed();
    });
    // 地図の押下として扱わない(点が増えないように)
    el.addEventListener("click", (e) => e.stopPropagation());
    return m;
  });
}

async function graphFor(data: RouteData): Promise<RoadGraph> {
  const box = bboxOf(points);
  const key = box.map((v) => v.toFixed(2)).join(",");
  // 前に作った範囲に収まっていれば作り直さない
  if (graphCache?.data === data) {
    const [w, s, e, n] = graphCache.box.split(",").map(Number);
    if (box[0] >= w && box[1] >= s && box[2] <= e && box[3] <= n) return graphCache.graph;
  }
  const loader = splitLoaderOf(data);
  if (loader) await loader.load(loader.cellsIn(...box));
  // 点線国道(歩道・山道のことがある)・海上区間・旧道は通らない
  const segs = segmentsIn(data.segments, box).filter((s) => !s.cats.some((c) => c === "dotted" || c === "ferry" || c === "old"));
  const graph = new RoadGraph(segs);
  graphCache = { data, box: key, graph };
  return graph;
}

async function compute() {
  if (!ctx || !naviOpen()) return;
  const data = ctx.kokudo();
  if (!data) {
    message = "国道のデータを読み込み中です。少しお待ちください";
    render();
    return;
  }
  if (points.length < 2) {
    plan = null;
    message = "";
    labels = [];
    drawPlan(null);
    render();
    return;
  }
  busy = true;
  render();
  try {
    const graph = await graphFor(data);
    labels = points.map((p) => graph.routesNear(p).map(ctx!.routeName).join(" / "));
    const r = planNavi(graph, points, { perLink: perLink() });
    if ("error" in r) {
      plan = null;
      message = r.error;
    } else {
      plan = r;
      message = "";
    }
  } catch (e) {
    plan = null;
    message = (e as Error).message;
  }
  busy = false;
  drawPlan(plan);
  render();
  if (plan && fitNext) {
    fitNext = false;
    fitPlan(plan);
  }
}

function fitPlan(p: NaviPlan) {
  if (!ctx || !panel) return;
  const lons = p.path.map((c) => c[0]);
  const lats = p.path.map((c) => c[1]);
  const mobile = window.matchMedia("(max-width: 720px)").matches;
  const pad = mobile
    ? { top: 30, right: 30, left: 30, bottom: panel.offsetHeight + 30 }
    : { top: 40, right: 40, bottom: 40, left: panel.offsetWidth + 40 };
  ctx.map.fitBounds(
    [
      [Math.min(...lons), Math.min(...lats)],
      [Math.max(...lons), Math.max(...lats)],
    ],
    { padding: pad, duration: 0 },
  );
}

function drawPlan(p: NaviPlan | null) {
  if (!ctx) return;
  const map = ctx.map;
  const path = {
    type: "FeatureCollection" as const,
    features: p ? [{ type: "Feature" as const, properties: {}, geometry: { type: "LineString" as const, coordinates: p.path } }] : [],
  };
  const wps = {
    type: "FeatureCollection" as const,
    features: p
      ? p.links.flatMap((l, li) =>
          [...l.waypoints, l.dest].map((w, wi) => ({
            type: "Feature" as const,
            properties: { color: COLORS[li % COLORS.length], label: wi === l.waypoints.length ? `リンク${li + 1} の目的地` : `リンク${li + 1} の経由地${wi + 1}`, dest: wi === l.waypoints.length ? 1 : 0 },
            geometry: { type: "Point" as const, coordinates: [w.lon, w.lat] },
          })),
        )
      : [],
  };
  const pathSrc = map.getSource("navi-path") as GeoJSONSource | undefined;
  if (pathSrc) {
    pathSrc.setData(path);
    (map.getSource("navi-wp") as GeoJSONSource).setData(wps);
    keepOnTop();
    return;
  }
  map.addSource("navi-path", { type: "geojson", data: path });
  map.addSource("navi-wp", { type: "geojson", data: wps });
  map.addLayer({
    id: "navi-path",
    type: "line",
    source: "navi-path",
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": "#7b1fa2", "line-width": ["interpolate", ["linear"], ["zoom"], 6, 3, 14, 8], "line-opacity": 0.75 },
  });
  map.addLayer({
    id: "navi-wp",
    type: "circle",
    source: "navi-wp",
    paint: {
      "circle-radius": ["case", ["==", ["get", "dest"], 1], 8, 5],
      "circle-color": ["get", "color"],
      "circle-stroke-color": "#fff",
      "circle-stroke-width": 2,
    },
  });
  map.on("click", "navi-wp", (e) => {
    const f = e.features?.[0];
    if (f) new maplibregl.Popup().setLngLat(e.lngLat).setText(String(f.properties.label)).addTo(map);
  });
}

/** 道路の線を描き直しても、ナビの線が上に来るように */
function keepOnTop() {
  if (!ctx) return;
  const map = ctx.map;
  const layers = map.getStyle()?.layers ?? [];
  if (!map.getLayer("navi-wp") || layers[layers.length - 1]?.id === "navi-wp") return;
  map.moveLayer("navi-path");
  map.moveLayer("navi-wp");
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const kmText = (m: number) => (m / 1000).toFixed(1);

function render() {
  if (!panel || !ctx) return;
  const name = ctx.routeName;
  const pts = points
    .map(
      (_, i) =>
        `<li><span class="navi-no">${pointLabel(i)}</span><span class="navi-road">${esc(labels[i] || "")}</span>` +
        `<button type="button" data-remove="${i}" aria-label="この点を消す">×</button></li>`,
    )
    .join("");
  const per = perLink();
  let result = "";
  if (busy) result = `<p class="muted">道筋を計算中…</p>`;
  else if (message) result = `<p class="navi-error">${esc(message)}</p>`;
  else if (plan) {
    result =
      `<p class="navi-summary">${plan.routes.map((r) => esc(name(r))).join(" → ")}<br>` +
      `約${kmText(plan.length)}km・経由地 ${plan.waypoints.length - 1} 個・リンク ${plan.links.length} 本</p>` +
      `<ol class="navi-links">` +
      plan.links
        .map(
          (l, i) =>
            `<li><span class="navi-dot" style="background:${COLORS[i % COLORS.length]}"></span>` +
            `<span class="navi-link-text">${l.routes.map((r) => esc(name(r))).join(" → ")}<br><span class="muted">${kmText(l.from)}〜${kmText(l.to)}km・経由地 ${l.waypoints.length} 個</span></span>` +
            `<a class="button" href="${esc(l.url)}" target="_blank" rel="noopener">開く</a>` +
            `<button type="button" data-copy="${i}">コピー</button></li>`,
        )
        .join("") +
      `</ol>` +
      `<div class="navi-row"><button type="button" data-act="copy-all">まとめてコピー</button>` +
      (typeof navigator.share === "function" ? `<button type="button" data-act="share">共有</button>` : "") +
      `</div>` +
      `<p class="muted">どのリンクも出発地は現在地です。前のリンクの目的地に着いたら次のリンクを開いてください。` +
      `経由地に着くたびに「到着」と出ることがありますが、そのまま進めば大丈夫です。` +
      `有料道路を避けたいときは、Google マップの経路オプションで「有料道路を使用しない」にしてください。</p>`;
  }
  panel.innerHTML =
    `<div class="navi-head"><h2>🧭 国道ナビ</h2><button type="button" data-act="close" aria-label="閉じる">×</button></div>` +
    `<details class="navi-help"${points.length >= 2 ? "" : " open"}><summary>使い方</summary><p class="muted">地図を押して、出発 → 通りたい国道の上 → … → 到着 の順に点を置きます(点はドラッグで動かせます)。` +
    `国道を乗り換えるところでは、乗り換えた先の国道の上に点を置くと確実です。国道だけをつないだ道筋を作り、Google マップのナビ用リンクにします。</p></details>` +
    (pts ? `<ol class="navi-points">${pts}</ol>` : "") +
    `<div class="navi-row">` +
    `<button type="button" data-act="undo"${points.length ? "" : " disabled"}>最後の点を消す</button>` +
    `<button type="button" data-act="back"${points.length >= 2 ? "" : " disabled"}>出発に戻る</button>` +
    `<button type="button" data-act="clear" class="danger"${points.length ? "" : " disabled"}>全部消す</button>` +
    `</div>` +
    `<label class="navi-per">1本のリンクの経由地 <select data-act="per">` +
    `<option value="9"${per === 9 ? " selected" : ""}>9 個(Google マップのアプリ)</option>` +
    `<option value="3"${per === 3 ? " selected" : ""}>3 個(スマホのブラウザ)</option>` +
    `</select></label>` +
    result;
}

async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    ctx?.toast(["コピーしました"]);
  } catch {
    window.prompt("コピーしてください", text);
  }
}

function onPanelClick(e: MouseEvent) {
  e.stopPropagation();
  const el = (e.target as HTMLElement).closest<HTMLElement>("button, a");
  if (!el || !ctx) return;
  if (el.dataset.remove) {
    points.splice(Number(el.dataset.remove), 1);
    changed();
    return;
  }
  if (el.dataset.copy && plan) {
    void copy(plan.links[Number(el.dataset.copy)].url);
    return;
  }
  switch (el.dataset.act) {
    case "close":
      closeNavi();
      break;
    case "undo":
      points.pop();
      changed();
      break;
    case "back":
      points.push({ ...points[0] });
      changed();
      break;
    case "clear":
      points = [];
      changed();
      break;
    case "copy-all":
      if (plan) void copy(linksText(plan, ctx.routeName));
      break;
    case "share":
      if (plan) void navigator.share({ title: "国道ナビ", text: linksText(plan, ctx.routeName) }).catch(() => undefined);
      break;
  }
}

function onPanelChange(e: Event) {
  const el = e.target as HTMLSelectElement;
  if (el.dataset.act === "per") {
    writeJson(PER_LINK_KEY, Number(el.value));
    schedule();
  }
}
