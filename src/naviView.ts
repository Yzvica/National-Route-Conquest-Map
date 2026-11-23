// ナビの画面。地図を押して点を並べると、国道(と都道府県道・一般道)を通る道筋と Google マップのリンクを作る(計算は navi.ts)。
// 作ったリンクは Google(Routes API。MiniPC が中継)で確かめられ、Google が道筋から外れる所に経由地を足して直せる(naviCheck.ts)。
// 点の並びは名前を付けて「コース」として MiniPC に保存できる(iPhone からも呼び出せる)。
import * as maplibregl from "maplibre-gl";
import type { GeoJSONSource } from "maplibre-gl";
import { muteRoadClicks } from "./map";
import { EXP_PREFIX, FREE_REF, RoadGraph, bboxOf, expBboxOf, isExpRef, linksText, planNavi, segmentsIn, type ExpresswayExtras, type NaviPlan, type NaviPoint } from "./navi";
import { buildGuide } from "./naviGuide";
import { compareRoute, decodePolyline, fixPoint, originOf, type RouteCheck } from "./naviCheck";
import { prefRouteLabel } from "./prefroads";
import { splitLoaderOf } from "./splitData";
import type { LonLat, PrefRoadIndex, RouteData, Segment } from "./types";

export interface NaviContext {
  map: maplibregl.Map;
  /** 国道のデータ(まだ読んでいなければ undefined) */
  kokudo: () => RouteData | undefined;
  /** 高速道路のデータ(まだ読んでいなければ undefined) */
  expressway: () => RouteData | undefined;
  /** 都道府県道の一覧(読み込み前は undefined、データがなければ null) */
  prefIndex: () => PrefRoadIndex | null | undefined;
  loadPref: (code: number) => Promise<RouteData | undefined>;
  prefName: (code: number) => string;
  toast: (lines: string[]) => void;
}

/** 道の選び方: 国道だけ / 国道→都道府県道 / 国道→都道府県道→一般道 / それに高速道路も */
export type NaviMode = "kokudo" | "pref" | "free" | "exp";
const MODE_LABELS: Record<NaviMode, string> = {
  kokudo: "国道だけ",
  pref: "国道 → 都道府県道",
  free: "国道 → 都道府県道 → 一般道",
  exp: "高速も使う(+ 国道 → 都道府県道 → 一般道)",
};

interface Course {
  name: string;
  points: NaviPoint[];
  mode: NaviMode;
  extra?: NaviPoint[];
  savedAt?: string;
  /** アプリの音声案内のデータがあるか(MiniPC に保存したとき) */
  guide?: { length: number; maneuvers: number };
}

const POINTS_KEY = "kokudo-navi-points";
const EXTRA_KEY = "kokudo-navi-extra";
const MODE_KEY = "kokudo-navi-mode";
const PER_LINK_KEY = "kokudo-navi-per-link";
/** MiniPC に保存できないとき(静的な公開版など)のコースの置き場所 */
const COURSES_KEY = "kokudo-navi-courses";
const API = "/api";
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
let graphCache: { data: RouteData; box: string; mode: NaviMode; graph: RoadGraph } | null = null;
/** Google が道筋から外れた所に足した経由地 */
let extra: NaviPoint[] = [];
/** Google で確かめた結果(リンクごと)。道筋が変わったら消す */
let checks: (RouteCheck | { error: string } | null)[] = [];
let checking = false;
let courses: Course[] = [];
let coursesOnServer = true;
/** 道筋に出てくる都道府県道の名前 */
const prefNames = new Map<string, string>();

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
const mode = (): NaviMode => {
  const m = readJson<string>(MODE_KEY, "kokudo");
  return m === "pref" || m === "free" || m === "exp" ? m : "kokudo";
};

function routeName(ref: string): string {
  if (ref === FREE_REF) return "一般道";
  if (isExpRef(ref)) return ref.slice(EXP_PREFIX.length);
  if (ref.includes("-")) return prefRouteLabel(ref, prefNames.get(ref), ctx?.prefName ?? String);
  return `国道${ref}号`;
}

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
    extra = readJson<NaviPoint[]>(EXTRA_KEY, []);
    void loadCourses();
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

const nf = (p: NaviPoint) => ({ lon: p.lon, lat: p.lat });

const round5 = (v: number) => Math.round(v * 1e5) / 1e5;

function changed() {
  writeJson(POINTS_KEY, points);
  writeJson(EXTRA_KEY, extra);
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

/** 範囲にかかる都道府県道のファイル(都道府県のコード) */
function prefsInBox(idx: PrefRoadIndex, box: [number, number, number, number]): number[] {
  const [w, s, e, n] = box;
  const cells = new Set<number>();
  for (let x = Math.floor(w / idx.cell); x <= Math.floor(e / idx.cell); x++)
    for (let y = Math.floor(s / idx.cell); y <= Math.floor(n / idx.cell); y++) cells.add(x * 1000 + y);
  return Object.entries(idx.prefs)
    .filter(([, info]) => info.cells.some((c) => cells.has(c)))
    .map(([code]) => Number(code));
}

/** 高速道路の区間を、路線に EXP_PREFIX を付けた区間にしたもの(作り直さないよう覚えておく) */
const expSegCache = new WeakMap<Segment, Segment>();
const expSegment = (s: Segment): Segment => {
  let e = expSegCache.get(s);
  if (!e) expSegCache.set(s, (e = { ...s, routes: s.routes.map((r) => EXP_PREFIX + r) }));
  return e;
};

/** 範囲にかかる高速道路の区間と、ランプなど */
async function expresswayIn(box: [number, number, number, number]): Promise<{ segs: Segment[]; extras: ExpresswayExtras }> {
  const ex = ctx?.expressway();
  if (!ex) throw new Error("高速道路のデータを読み込み中です。少しお待ちください");
  const loader = splitLoaderOf(ex);
  if (loader) await loader.load(loader.cellsIn(...box));
  const [w, s, e, n] = box;
  const inBox = ([x, y]: LonLat) => x >= w && x <= e && y >= s && y <= n;
  const lines = (ls: LonLat[][] | undefined) => (ls ?? []).filter((c) => c.some(inBox));
  return {
    segs: segmentsIn(ex.segments, box).map(expSegment),
    extras: { ramps: (ex.ramps ?? []).filter((r) => r.c.some(inBox)), jct: lines(ex.jct), uncounted: lines(ex.uncounted), access: (ex.access ?? []).filter(inBox) },
  };
}

async function graphFor(data: RouteData, m: NaviMode): Promise<RoadGraph> {
  const box = bboxOf(points);
  const key = box.map((v) => v.toFixed(2)).join(",");
  // 前に作った範囲に収まっていれば作り直さない
  if (graphCache?.data === data && graphCache.mode === m) {
    const [w, s, e, n] = graphCache.box.split(",").map(Number);
    if (box[0] >= w && box[1] >= s && box[2] <= e && box[3] <= n) return graphCache.graph;
  }
  const loader = splitLoaderOf(data);
  if (loader) await loader.load(loader.cellsIn(...box));
  // 点線国道(歩道・山道のことがある)・海上区間・旧道は通らない
  let segs = segmentsIn(data.segments, box).filter((s) => !s.cats.some((c) => c === "dotted" || c === "ferry" || c === "old"));
  let expressway: ExpresswayExtras | undefined;
  if (m === "exp") {
    const ex = await expresswayIn(expBboxOf(points));
    // 国道の自動車専用道路(高速道路のデータにもある同じ道)は、高速道路として扱う(ランプでだけ乗り降りする)
    const ids = new Set(ex.segs.map((s) => s.id));
    segs = segs.filter((s) => !ids.has(s.id));
    segs.push(...ex.segs);
    expressway = ex.extras;
  }
  if (m !== "kokudo" && ctx) {
    const idx = ctx.prefIndex();
    if (!idx) throw new Error(idx === null ? "都道府県道のデータがまだありません(国道だけで作れます)" : "都道府県道の一覧を読み込み中です。少しお待ちください");
    const seen = new Set<string>();
    for (const code of prefsInBox(idx, box)) {
      const d = await ctx.loadPref(code);
      if (!d) continue;
      for (const [ref, r] of Object.entries(d.routes)) if (r.name) prefNames.set(ref, r.name);
      // 県境の道は両方のファイルにある
      for (const s of segmentsIn(d.segments, box))
        if (!seen.has(s.id)) {
          seen.add(s.id);
          segs.push(s);
        }
    }
  }
  const graph = new RoadGraph(segs, { free: m === "free" || m === "exp", expressway });
  graphCache = { data, box: key, mode: m, graph };
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
  checks = [];
  render();
  try {
    const m = mode();
    const graph = await graphFor(data, m);
    const free = m === "free" || m === "exp";
    labels = points.map((p) => (free && graph.distanceTo(p) > 80 ? "一般道" : graph.routesNear(p).map(routeName).join(" / ")));
    const r = planNavi(graph, points, { perLink: perLink(), free, extra });
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
  const path = { type: "FeatureCollection" as const, features: p ? pathFeatures(p) : [] };
  const glines = {
    type: "FeatureCollection" as const,
    features: p
      ? checks.flatMap((c) =>
          c && "line" in c
            ? [
                { type: "Feature" as const, properties: { off: 0 }, geometry: { type: "LineString" as const, coordinates: c.line } },
                ...c.offs.map((o) => ({ type: "Feature" as const, properties: { off: 1 }, geometry: { type: "LineString" as const, coordinates: o.line } })),
              ]
            : [],
        )
      : [],
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
    (map.getSource("navi-google") as GeoJSONSource).setData(glines);
    (map.getSource("navi-wp") as GeoJSONSource).setData(wps);
    keepOnTop();
    return;
  }
  map.addSource("navi-path", { type: "geojson", data: path });
  map.addSource("navi-google", { type: "geojson", data: glines });
  map.addSource("navi-wp", { type: "geojson", data: wps });
  map.addLayer({
    id: "navi-path",
    type: "line",
    source: "navi-path",
    filter: ["==", ["get", "kind"], 0],
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": "#7b1fa2", "line-width": ["interpolate", ["linear"], ["zoom"], 6, 3, 14, 8], "line-opacity": 0.75 },
  });
  // 一般道(Google に任せる区間)は点線
  map.addLayer({
    id: "navi-path-free",
    type: "line",
    source: "navi-path",
    filter: ["==", ["get", "kind"], 1],
    paint: { "line-color": "#7b1fa2", "line-width": ["interpolate", ["linear"], ["zoom"], 6, 2, 14, 5], "line-opacity": 0.75, "line-dasharray": [1.5, 1.5] },
  });
  // 高速道路(Google に任せる区間)は緑
  map.addLayer({
    id: "navi-path-exp",
    type: "line",
    source: "navi-path",
    filter: ["==", ["get", "kind"], 2],
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": "#0b8043", "line-width": ["interpolate", ["linear"], ["zoom"], 6, 3, 14, 8], "line-opacity": 0.75 },
  });
  // Google が引いた道(灰色)と、道筋から外れた所(赤)
  map.addLayer({
    id: "navi-google",
    type: "line",
    source: "navi-google",
    layout: { "line-cap": "round", "line-join": "round" },
    paint: {
      "line-color": ["case", ["==", ["get", "off"], 1], "#d93025", "#202124"],
      "line-width": ["case", ["==", ["get", "off"], 1], 5, 2],
      "line-opacity": ["case", ["==", ["get", "off"], 1], 0.9, 0.5],
    },
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
  for (const id of ["navi-path", "navi-path-free", "navi-path-exp", "navi-google", "navi-wp"]) map.moveLayer(id);
}

/** 道筋を、データの道(kind 0)・一般道(1)・高速道路(2)の部分に分けた線 */
function pathFeatures(p: NaviPlan) {
  const inSpans = (spans: { from: number; to: number }[], i: number) => spans.some((f) => p.acc[i] >= f.from - 0.01 && p.acc[i + 1] <= f.to + 0.01);
  const out: { type: "Feature"; properties: { kind: number }; geometry: { type: "LineString"; coordinates: [number, number][] } }[] = [];
  for (let i = 0; i + 1 < p.path.length; i++) {
    const kind = inSpans(p.freeSpans, i) ? 1 : inSpans(p.expSpans, i) ? 2 : 0;
    const last = out[out.length - 1];
    if (last && last.properties.kind === kind) last.geometry.coordinates.push(p.path[i + 1]);
    else out.push({ type: "Feature", properties: { kind }, geometry: { type: "LineString", coordinates: [p.path[i], p.path[i + 1]] } });
  }
  return out;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const kmText = (m: number) => (m / 1000).toFixed(1);

function render() {
  if (!panel || !ctx) return;
  const name = routeName;
  const m = mode();
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
    const freeLen = plan.freeSpans.reduce((s, f) => s + f.to - f.from, 0);
    const expLen = plan.expSpans.reduce((s, f) => s + f.to - f.from, 0);
    const allChecked = checks.length === plan.links.length && checks.every((c) => c && "line" in c);
    const offCount = checks.reduce((s, c) => s + (c && "offs" in c ? c.offs.length : 0), 0);
    result =
      `<p class="navi-summary">${plan.routes.map((r) => esc(name(r))).join(" → ")}<br>` +
      `約${kmText(plan.length)}km・経由地 ${plan.waypoints.length - 1} 個・リンク ${plan.links.length} 本` +
      (expLen > 0 ? `<br><span class="muted">緑は高速道路(約${kmText(expLen)}km。経由地は置かず、どの高速道路を通るかは Google マップに任せる)</span>` : "") +
      (freeLen > 0 ? `<br><span class="muted">点線は一般道(Google マップに道を任せる。長さは直線で約${kmText(freeLen)}km)</span>` : "") +
      `</p>` +
      `<ol class="navi-links">` +
      plan.links
        .map((l, i) => {
          const c = checks[i];
          const check = !c
            ? ""
            : "error" in c
              ? `<br><span class="navi-error">${esc(c.error)}</span>`
              : `<br><span class="${c.offs.length ? "navi-error" : "navi-ok"}">Google ${kmText(c.googleLength)}km` +
                (c.offs.length ? `・道筋から外れる所 ${c.offs.length} か所` : "・道筋どおり") +
                `</span>`;
          return (
            `<li><span class="navi-dot" style="background:${COLORS[i % COLORS.length]}"></span>` +
            `<span class="navi-link-text">${l.routes.map((r) => esc(name(r))).join(" → ")}<br><span class="muted">${kmText(l.from)}〜${kmText(l.to)}km・経由地 ${l.waypoints.length} 個</span>${check}</span>` +
            `<a class="button" href="${esc(l.url)}" target="_blank" rel="noopener">開く</a>` +
            `<button type="button" data-copy="${i}">コピー</button></li>`
          );
        })
        .join("") +
      `</ol>` +
      `<div class="navi-row"><button type="button" data-act="copy-all">まとめてコピー</button>` +
      (typeof navigator.share === "function" ? `<button type="button" data-act="share">共有</button>` : "") +
      `</div>` +
      `<div class="navi-row">` +
      `<button type="button" data-act="check"${checking ? " disabled" : ""}>${checking ? "Google に問い合わせ中…" : `Google で確かめる(${plan.links.length} 回)`}</button>` +
      (offCount ? `<button type="button" data-act="fix">外れた所に経由地を足す</button>` : "") +
      (extra.length ? `<button type="button" data-act="clear-extra">足した経由地 ${extra.length} 個を消す</button>` : "") +
      `</div>` +
      (allChecked && !offCount ? `<p class="navi-ok">Google の道は、どのリンクも道筋どおりでした</p>` : "") +
      (checks.length ? `<p class="muted">灰色の線が Google の道、赤は道筋から外れた所です。</p>` : "") +
      `<p class="muted">どのリンクも出発地は現在地です。前のリンクの目的地に着いたら次のリンクを開いてください。` +
      `経由地に着くたびに「到着」と出ることがありますが、そのまま進めば大丈夫です。` +
      `有料道路を避けたいときは、Google マップの経路オプションで「有料道路を使用しない」にしてください。</p>`;
  }
  const courseList = courses
    .map((c, i) => `<option value="${i}">${c.guide ? "📱 " : ""}${esc(c.name)}(${esc(MODE_LABELS[c.mode] ?? "")})</option>`)
    .join("");
  panel.innerHTML =
    `<div class="navi-head"><h2>🧭 ナビ・コース</h2><button type="button" data-act="close" aria-label="閉じる">×</button></div>` +
    `<details class="navi-help"${points.length >= 2 ? "" : " open"}><summary>使い方</summary><p class="muted">地図を押して、出発 → 通りたい道の上 → … → 到着 の順に点を置きます(点はドラッグで動かせます)。` +
    `道を乗り換えるところでは、乗り換えた先の道の上に点を置くと確実です。選んだ道の選び方で道筋を作り、Google マップのナビ用リンクにします。` +
    `都道府県道は国道より少し遠回りとみなして国道を優先します。「一般道」まで使うと、データの道の切れ目や道から離れた点を、Google マップに任せる区間(点線)でつなぎます。` +
    `「高速も使う」にすると、速い高速道路(緑)も使って、遠くの点の間は高速道路で移動します。高速道路には経由地を置かず、降りた少し先に経由地を置きます。` +
    `高速道路を走りたくない区間は、その区間の下の道の上に点を置いてください。</p></details>` +
    `<label class="navi-per">道の選び方 <select data-act="mode">` +
    (Object.keys(MODE_LABELS) as NaviMode[]).map((k) => `<option value="${k}"${m === k ? " selected" : ""}>${MODE_LABELS[k]}</option>`).join("") +
    `</select></label>` +
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
    result +
    `<details class="navi-courses"${courses.length && points.length < 2 ? " open" : ""}><summary>コース(${courses.length})</summary>` +
    (courseList
      ? `<div class="navi-row"><select data-act="course">${courseList}</select>` +
        `<button type="button" data-act="load-course">開く</button><button type="button" data-act="delete-course" class="danger">消す</button></div>`
      : `<p class="muted">保存したコースはまだありません</p>`) +
    `<div class="navi-row"><input type="text" data-course-name maxlength="60" placeholder="コースの名前" value="${esc(courseName)}">` +
    `<button type="button" data-act="save-course"${points.length >= 2 ? "" : " disabled"}>保存</button></div>` +
    `<p class="muted">${coursesOnServer ? "コースは MiniPC に保存するので、ほかの端末からも開けます。道筋ができてから保存すると、iPhone の走行ロガーの「ナビ」で音声案内できます(📱 の付いたコース)。" : "MiniPC に保存できないので、この端末のブラウザに保存します。"}</p>` +
    `</details>`;
}

/** 今のコースの名前(保存欄に入れたもの・開いたもの) */
let courseName = "";

async function loadCourses() {
  try {
    const r = await fetch(`${API}/navi/courses`);
    if (!r.ok || !r.headers.get("content-type")?.includes("json")) throw new Error(String(r.status));
    courses = (await r.json()) as Course[];
    coursesOnServer = true;
  } catch {
    courses = readJson<Course[]>(COURSES_KEY, []);
    coursesOnServer = false;
  }
  render();
}

async function saveCourse() {
  if (!panel || points.length < 2) return;
  const input = panel.querySelector<HTMLInputElement>("[data-course-name]");
  const nm = (input?.value ?? "").trim();
  if (!nm) {
    ctx?.toast(["コースの名前を入れてください"]);
    input?.focus();
    return;
  }
  courseName = nm;
  const course: Course = { name: nm, points: points.map(nf), mode: mode(), extra: extra.map(nf) };
  if (coursesOnServer) {
    try {
      // iPhone アプリの音声案内のデータも一緒に送る(道筋ができているとき)
      const guide = plan ? buildGuide(plan, nm, routeName) : undefined;
      const r = await fetch(`${API}/navi/courses`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...course, guide }) });
      if (!r.ok) throw new Error(String(r.status));
      courses = (await r.json()) as Course[];
      ctx?.toast([guide ? `コース「${nm}」を保存しました(アプリで音声案内できます。案内 ${guide.man.length} か所)` : `コース「${nm}」を保存しました`]);
      render();
      return;
    } catch {
      coursesOnServer = false;
    }
  }
  courses = [{ ...course, savedAt: new Date().toISOString() }, ...courses.filter((c) => c.name !== nm)];
  writeJson(COURSES_KEY, courses);
  ctx?.toast([`コース「${nm}」をこの端末に保存しました`]);
  render();
}

function selectedCourse(): Course | undefined {
  const sel = panel?.querySelector<HTMLSelectElement>('[data-act="course"]');
  return sel ? courses[Number(sel.value)] : undefined;
}

function openCourse() {
  const c = selectedCourse();
  if (!c) return;
  points = c.points.map(nf);
  extra = (c.extra ?? []).map(nf);
  courseName = c.name;
  writeJson(MODE_KEY, c.mode);
  fitNext = true;
  changed();
}

async function removeCourse() {
  const c = selectedCourse();
  if (!c) return;
  if (coursesOnServer) {
    try {
      const r = await fetch(`${API}/navi/courses?name=${encodeURIComponent(c.name)}`, { method: "DELETE" });
      if (!r.ok) throw new Error(String(r.status));
      courses = (await r.json()) as Course[];
      render();
      return;
    } catch {
      coursesOnServer = false;
    }
  }
  courses = courses.filter((x) => x.name !== c.name);
  writeJson(COURSES_KEY, courses);
  render();
}

/** リンクを1本ずつ Google に問い合わせて、道筋と比べる */
async function checkWithGoogle() {
  const p = plan;
  if (!p || checking) return;
  checking = true;
  checks = p.links.map(() => null);
  render();
  for (let i = 0; i < p.links.length; i++) {
    const l = p.links[i];
    try {
      const r = await fetch(`${API}/gmaps/route`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ origin: originOf(p, i), destination: nf(l.dest), waypoints: l.waypoints.map(nf) }),
      });
      const body = (await r.json().catch(() => ({ error: `MiniPC の応答 ${r.status}` }))) as { distance?: number; duration?: number; polyline?: string; error?: string };
      if (plan !== p) break; // 問い合わせ中に道筋が変わった
      if (body.error || !body.polyline) {
        checks[i] = { error: body.error ?? "Google の道を受け取れませんでした" };
        if (r.status === 429 || r.status === 404) break;
      } else checks[i] = compareRoute(p, l, decodePolyline(body.polyline), body.distance ?? 0, body.duration ?? 0);
    } catch {
      checks[i] = { error: "MiniPC につながりません(Google で確かめるには MiniPC の地図サーバーが必要です)" };
      break;
    }
    drawPlan(p);
    render();
  }
  checking = false;
  if (plan === p) {
    drawPlan(p);
    render();
  }
}

/** Google が外れた所の真ん中に経由地を足して、道筋を作り直す */
function fixOffs() {
  const p = plan;
  if (!p) return;
  let added = 0;
  for (const c of checks)
    if (c && "offs" in c)
      for (const o of c.offs) {
        extra.push(fixPoint(p, o));
        added++;
      }
  if (!added) return;
  ctx?.toast([`経由地を ${added} 個足しました。もう一度「Google で確かめる」で確かめられます`]);
  changed();
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
      extra = [];
      courseName = "";
      changed();
      break;
    case "copy-all":
      if (plan) void copy(linksText(plan, routeName));
      break;
    case "share":
      if (plan) void navigator.share({ title: courseName || "ナビ", text: linksText(plan, routeName) }).catch(() => undefined);
      break;
    case "check":
      void checkWithGoogle();
      break;
    case "fix":
      fixOffs();
      break;
    case "clear-extra":
      extra = [];
      changed();
      break;
    case "save-course":
      void saveCourse();
      break;
    case "load-course":
      openCourse();
      break;
    case "delete-course":
      void removeCourse();
      break;
  }
}

function onPanelChange(e: Event) {
  const el = e.target as HTMLSelectElement;
  if (el.dataset.act === "per") {
    writeJson(PER_LINK_KEY, Number(el.value));
    schedule();
  }
  if (el.dataset.act === "mode") {
    writeJson(MODE_KEY, el.value);
    schedule();
  }
}
