import maplibregl, { type GeoJSONSource } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import type { PassDates } from "./store";
import type { Coverage, LonLat, RouteData, Segment, TrackPoint } from "./types";

const GSI_ATTRIBUTION =
  '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank">地理院タイル</a> / 道路: © <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap contributors</a>';

/** 背景の地図(地理院タイル)。白地図は道路や地名がほぼなく、走った線だけが目立つ */
export const BASEMAPS = [
  { id: "pale", label: "淡色地図", url: "pale/{z}/{x}/{y}.png", minzoom: 2, maxzoom: 18 },
  { id: "blank", label: "白地図", url: "blank/{z}/{x}/{y}.png", minzoom: 5, maxzoom: 14 },
  { id: "std", label: "標準地図", url: "std/{z}/{x}/{y}.png", minzoom: 2, maxzoom: 18 },
  { id: "photo", label: "写真", url: "seamlessphoto/{z}/{x}/{y}.jpg", minzoom: 2, maxzoom: 18 },
] as const;
export type BasemapId = (typeof BASEMAPS)[number]["id"];
const BASEMAP_KEY = "kokudo-basemap";

function savedBasemap(): BasemapId {
  try {
    const v = localStorage.getItem(BASEMAP_KEY);
    if (BASEMAPS.some((b) => b.id === v)) return v as BasemapId;
  } catch {
    // 保存できないブラウザでは毎回淡色地図にする
  }
  return "pale";
}

export function createMap(container: HTMLElement): maplibregl.Map {
  const current = savedBasemap();
  const sources: Record<string, maplibregl.SourceSpecification> = {};
  // 白地図は ZL5 未満のタイルがないので、その下に白い下地を敷いておく
  const layers: maplibregl.LayerSpecification[] = [
    { id: "basemap-bg", type: "background", paint: { "background-color": "#ffffff" } },
  ];
  for (const b of BASEMAPS) {
    sources[`basemap-${b.id}`] = {
      type: "raster",
      tiles: [`https://cyberjapandata.gsi.go.jp/xyz/${b.url}`],
      tileSize: 256,
      minzoom: b.minzoom,
      maxzoom: b.maxzoom,
      attribution: GSI_ATTRIBUTION,
    };
    // 表示していない背景は visibility: none なのでタイルを読まない
    layers.push({
      id: `basemap-${b.id}`,
      type: "raster",
      source: `basemap-${b.id}`,
      layout: { visibility: b.id === current ? "visible" : "none" },
    });
  }
  return new maplibregl.Map({
    container,
    // 北海道から沖縄まで入るように
    bounds: [[123, 24], [146, 45.6]],
    fitBoundsOptions: { padding: 20 },
    style: { version: 8, sources, layers },
  });
}

export function setBasemap(map: maplibregl.Map, id: BasemapId) {
  for (const b of BASEMAPS) map.setLayoutProperty(`basemap-${b.id}`, "visibility", b.id === id ? "visible" : "none");
  try {
    localStorage.setItem(BASEMAP_KEY, id);
  } catch {
    // 保存できなくても切り替えはできる
  }
}

/** 背景の地図を選ぶ欄 */
class BasemapControl implements maplibregl.IControl {
  private el?: HTMLElement;
  onAdd(map: maplibregl.Map) {
    const el = document.createElement("div");
    el.className = "maplibregl-ctrl maplibregl-ctrl-group basemap-ctrl";
    const select = document.createElement("select");
    select.setAttribute("aria-label", "背景の地図");
    select.title = "背景の地図";
    const current = savedBasemap();
    for (const b of BASEMAPS) select.add(new Option(b.label, b.id, false, b.id === current));
    select.addEventListener("change", () => setBasemap(map, select.value as BasemapId));
    el.append(select);
    this.el = el;
    return el;
  }
  onRemove() {
    this.el?.remove();
  }
}

/** 位置情報が使えない(HTTP で開いた)ときに代わりに置くボタン。押すと理由を出す */
class NoGeolocateControl implements maplibregl.IControl {
  private el?: HTMLElement;
  constructor(private notify: (lines: string[]) => void) {}
  onAdd() {
    const el = document.createElement("div");
    el.className = "maplibregl-ctrl maplibregl-ctrl-group";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "maplibregl-ctrl-geolocate geolocate-unavailable";
    button.title = "現在位置(HTTPS で開いたときだけ使えます)";
    button.setAttribute("aria-label", button.title);
    button.innerHTML = '<span class="maplibregl-ctrl-icon" aria-hidden="true"></span>';
    button.addEventListener("click", () =>
      this.notify([
        "📍 現在位置は HTTPS で開いたときだけ使えます",
        "Tailscale の https://〜.ts.net/ のアドレスで開いてください",
      ]),
    );
    el.append(button);
    this.el = el;
    return el;
  }
  onRemove() {
    this.el?.remove();
  }
}

/** 背景の切り替えと現在位置のボタンを地図に置く */
export function addMapControls(map: maplibregl.Map, notify: (lines: string[]) => void) {
  // 右上は詳細の枠と重なるので右下に置く
  map.addControl(new BasemapControl(), "bottom-right");
  if (!window.isSecureContext || !("geolocation" in navigator)) {
    map.addControl(new NoGeolocateControl(notify), "bottom-right");
    return;
  }
  const geolocate = new maplibregl.GeolocateControl({
    // iPhone の Safari は、追いかけ中(watchPosition)に止まっていて新しい位置が来ないと、
    // timeout ごとに TIMEOUT エラーを出す。屋内では GPS の最初の測位にも 15 秒以上かかることがある。
    // そのため時間切れは長めにし、少し前の位置(30 秒以内)も使う
    positionOptions: { enableHighAccuracy: true, timeout: 60000, maximumAge: 30000 },
    // 押すと現在位置へ移動し、そのあとも動きに合わせて追いかける(もう一度押すと止める)
    trackUserLocation: true,
    showAccuracyCircle: true,
    fitBoundsOptions: { maxZoom: 14 },
  });
  // 一度でも位置が取れたあとの時間切れは「止まっていて更新が無い」だけなので知らせない
  let gotPosition = false;
  geolocate.on("geolocate", () => {
    gotPosition = true;
  });
  geolocate.on("trackuserlocationend", () => {
    gotPosition = false;
  });
  geolocate.on("error", (e: GeolocationPositionError) => {
    if (e.code === 3 && gotPosition) return;
    const detail = `(コード ${e.code}${e.message ? `: ${e.message}` : ""})`;
    if (e.code === 1) {
      notify([
        "📍 位置情報の利用が許可されていません " + detail,
        "iPhone: 設定 → プライバシーとセキュリティ → 位置情報サービス → Safari Webサイト を「使用中のみ」に",
        "Chrome などの場合は 設定 → (アプリ名) → 位置情報 を許可してください",
      ]);
    } else if (e.code === 3) {
      notify([
        "📍 現在位置の取得が時間切れになりました " + detail,
        "空が見える場所でもう一度押してください",
      ]);
    } else {
      notify([
        "📍 現在位置を取得できませんでした " + detail,
        "iPhone: 位置情報サービスがオンか、Safari Webサイト の「正確な位置情報」がオンかを確認してください",
      ]);
    }
  });
  map.addControl(geolocate, "bottom-right");
}

/** 今のデータ(国道/高速道路)で登録したイベントの後始末。データを切り替えるときに呼ぶ */
let cleanups: (() => void)[] = [];

function onLayers(map: maplibregl.Map, layers: string[], fn: (e: maplibregl.MapLayerMouseEvent) => void) {
  map.on("click", layers, fn);
  cleanups.push(() => map.off("click", layers, fn));
}

const routeLabel = (data: RouteData, ref: string) =>
  data.routes[ref]?.name ?? (data.kind === "expressway" || data.kind === "prefroad" ? ref : `国道${ref}号`);

/** 地図から道路の線をすべて消す(データを切り替える前に呼ぶ) */
export function clearRoutes(map: maplibregl.Map) {
  for (const f of cleanups) f();
  cleanups = [];
  painted = null;
  for (const id of map.getStyle().layers.map((l) => l.id)) {
    if (/^(routes|overview)-|^(selected|selected-casing|focus)$/.test(id)) map.removeLayer(id);
  }
  for (const id of ["routes", "overview", "selected", "focus"]) if (map.getSource(id)) map.removeSource(id);
}

export function addRoutes(
  map: maplibregl.Map,
  data: RouteData,
  datesOf: (id: string) => PassDates | undefined,
  onSelect: (ref: string) => void,
) {
  clearRoutes(map);
  // 引いた縮尺では約200mの区間が間引かれて消えるので、つながった区間を長い線にまとめた
  // 軽いソースで描く(paintCoverage で走行状況が変わるたびに作り直す)
  map.addSource("overview", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  const overviewColor = ["match", ["get", "s"], 2, "#d93025", 1, "#f29900", "#9aa0a6"];
  addLineLayers(map, "overview", "overview", overviewColor, { maxzoom: DETAIL_ZOOM });
  onLayers(map, ["overview-road", "overview-dotted", "overview-ferry", "overview-old"], (e) => {
    const f = e.features?.[0];
    if (!f) return;
    const refs = String(f.properties.routes).split(",");
    const names = refs.map((r) => routeLabel(data, r)).join(" / ");
    new maplibregl.Popup().setLngLat(e.lngLat).setText(`${names}(拡大すると区間ごとの割合が見られます)`).addTo(map);
    onSelect(refs[0]);
  });

  // 区間ごとのソース(約36万本)は重いので、拡大したときに初めて作る
  const check = () => {
    if (map.getZoom() >= DETAIL_ZOOM - 1) {
      map.off("zoomend", check);
      addDetail(map, data, datesOf, onSelect);
    }
  };
  map.on("zoomend", check);
  cleanups.push(() => map.off("zoomend", check));
  check();
}

/** これより拡大したら区間ごとに描き、引いたときはまとめた線(overview)で描く */
const DETAIL_ZOOM = 9;

function addLineLayers(
  map: maplibregl.Map,
  prefix: string,
  source: string,
  color: unknown,
  zoom: { minzoom?: number; maxzoom?: number },
  before?: string,
) {
  const width = ["interpolate", ["linear"], ["zoom"], 5, 1.5, 12, 4];
  map.addLayer({
    id: `${prefix}-road`,
    type: "line",
    source,
    ...zoom,
    filter: ["all", ["!", ["get", "dotted"]], ["!", ["get", "ferry"]], ["!", ["get", "old"]]],
    paint: { "line-color": color as never, "line-width": width as never },
  }, before);
  // 旧道は今の国道ではないので、細い破線で控えめに描く
  map.addLayer({
    id: `${prefix}-old`,
    type: "line",
    source,
    ...zoom,
    filter: ["all", ["get", "old"], ["!", ["get", "dotted"]]],
    paint: {
      "line-color": color as never,
      "line-width": ["interpolate", ["linear"], ["zoom"], 5, 1, 12, 2.5],
      "line-dasharray": [3, 1.5],
      "line-opacity": 0.85,
    },
  }, before);
  map.addLayer({
    id: `${prefix}-dotted`,
    type: "line",
    source,
    ...zoom,
    filter: ["get", "dotted"],
    paint: { "line-color": color as never, "line-width": width as never, "line-dasharray": [1, 1.5] },
  }, before);
  map.addLayer({
    id: `${prefix}-ferry`,
    type: "line",
    source,
    ...zoom,
    filter: ["get", "ferry"],
    paint: { "line-color": color as never, "line-width": 1.5, "line-dasharray": [3, 3] },
  }, before);
}

interface OverviewTopology {
  /** 区間ごとの、国道・種別をまとめたキー(走行状況は含まない) */
  keys: string[];
  /** 区間ごとの両端の番号(同じ国道・種別で同じ座標の端は同じ番号) */
  start: Int32Array;
  end: Int32Array;
  /** 端の番号 → その端を持つ区間 */
  byEnd: number[][];
}

/** 区間のつながり(記録によらない)。データごとに一度だけ作る */
const topologyCache = new WeakMap<RouteData, OverviewTopology>();
function topologyOf(data: RouteData): OverviewTopology {
  const hit = topologyCache.get(data);
  if (hit) return hit;
  const segs = data.segments;
  const keys = segs.map(
    (s) =>
      `${s.routes.join(",")}|${s.cats.includes("dotted") ? 1 : 0}${s.cats.includes("ferry") ? 1 : 0}${s.cats.includes("old") ? 1 : 0}`,
  );
  // 文字列のキーを作ると遅いので、座標は 1e-5 度単位の整数にして数値のキーで引く
  const keyIds = new Map<string, number>();
  const kid = keys.map((k) => {
    let id = keyIds.get(k);
    if (id === undefined) keyIds.set(k, (id = keyIds.size));
    return id;
  });
  /** 座標 → [キーの番号, 端の番号, キーの番号, 端の番号, ...] */
  const ids = new Map<number, number[]>();
  const byEnd: number[][] = [];
  const endId = (k: number, c: LonLat, i: number) => {
    const pos = Math.round(c[0] * 1e5) * 1e7 + Math.round(c[1] * 1e5);
    let list = ids.get(pos);
    if (!list) ids.set(pos, (list = []));
    let id = -1;
    for (let n = 0; n < list.length; n += 2) if (list[n] === k) id = list[n + 1];
    if (id < 0) {
      id = byEnd.length;
      list.push(k, id);
      byEnd.push([]);
    }
    byEnd[id].push(i);
    return id;
  };
  const start = new Int32Array(segs.length);
  const end = new Int32Array(segs.length);
  segs.forEach((s, i) => {
    start[i] = endId(kid[i], s.coords[0], i);
    end[i] = endId(kid[i], s.coords[s.coords.length - 1], i);
  });
  const t = { keys, start, end, byEnd };
  topologyCache.set(data, t);
  return t;
}

/**
 * 端点でつながっていて、国道・種別・走行状況(未走行/一部/走行済み)が同じ区間を1本の線にまとめる。
 * 約36万区間が数千本になり、引いた縮尺でも速く、消えずに描ける。
 * つながり方はデータごとに一度だけ調べ、記録が変わったときは走行状況だけ見直す
 */
export function buildOverview(data: RouteData, coverage: Coverage) {
  const segs = data.segments;
  const { keys, start, end, byEnd } = topologyOf(data);
  const state = new Uint8Array(segs.length);
  for (let i = 0; i < segs.length; i++) {
    const r = coverage.get(segs[i].id) ?? 0;
    state[i] = r >= 1 ? 2 : r > 0 ? 1 : 0;
  }
  const used = new Uint8Array(segs.length);
  /** 端 e につながる、まだ使っていない同じ走行状況の区間 */
  const next = (e: number, s: number) => byEnd[e].find((j) => !used[j] && state[j] === s);

  const features = [];
  for (let i = 0; i < segs.length; i++) {
    if (used[i]) continue;
    used[i] = 1;
    const s = state[i];
    let line: LonLat[] = [...segs[i].coords];
    // 後ろへ、次に前へ伸ばす。tail / head は線の端の番号
    let tail = end[i];
    for (let j = next(tail, s); j !== undefined; j = next(tail, s)) {
      used[j] = 1;
      const c = segs[j].coords;
      if (start[j] === tail) {
        for (let k = 1; k < c.length; k++) line.push(c[k]);
        tail = end[j];
      } else {
        for (let k = c.length - 2; k >= 0; k--) line.push(c[k]);
        tail = start[j];
      }
    }
    let head = start[i];
    const before: LonLat[] = [];
    for (let j = next(head, s); j !== undefined; j = next(head, s)) {
      used[j] = 1;
      const c = segs[j].coords;
      // 前に足す分は逆順にためておき、最後にまとめてつなぐ
      if (end[j] === head) {
        for (let k = c.length - 2; k >= 0; k--) before.push(c[k]);
        head = start[j];
      } else {
        for (let k = 1; k < c.length; k++) before.push(c[k]);
        head = end[j];
      }
    }
    if (before.length) line = before.reverse().concat(line);
    const [routes, kind] = keys[i].split("|");
    features.push({
      type: "Feature" as const,
      properties: { routes, dotted: kind[0] === "1", ferry: kind[1] === "1", old: kind[2] === "1", s },
      geometry: { type: "LineString" as const, coordinates: line },
    });
  }
  return { type: "FeatureCollection" as const, features };
}

let painted: Coverage | null = null;

function addDetail(
  map: maplibregl.Map,
  data: RouteData,
  datesOf: (id: string) => PassDates | undefined,
  onSelect: (ref: string) => void,
) {
  map.addSource("routes", {
    type: "geojson",
    promoteId: "id",
    data: {
      type: "FeatureCollection",
      features: data.segments.map((s) => ({
        type: "Feature",
        properties: {
          id: s.id,
          routes: s.routes.join(","),
          dotted: s.cats.includes("dotted"),
          ferry: s.cats.includes("ferry"),
          old: s.cats.includes("old"),
        },
        geometry: { type: "LineString", coordinates: s.coords },
      })),
    },
  });
  const ratio = ["coalesce", ["feature-state", "r"], 0];
  const color = ["case", [">=", ratio, 1], "#d93025", [">", ratio, 0], "#f29900", "#9aa0a6"];
  addLineLayers(map, "routes", "routes", color, { minzoom: DETAIL_ZOOM }, "overview-road");

  onLayers(map, ["routes-road", "routes-dotted", "routes-ferry", "routes-old"], (e) => {
    const f = e.features?.[0];
    if (!f) return;
    const names = String(f.properties.routes)
      .split(",")
      .map((r) => routeLabel(data, r))
      .join(" / ");
    const r = Number(f.state?.r ?? 0);
    const d = datesOf(String(f.properties.id));
    const when = !d ? "" : d[0] === d[1] ? ` / ${d[0]} に通過` : ` / 初めて ${d[0]}、最後 ${d[1]}`;
    new maplibregl.Popup().setLngLat(e.lngLat).setText(`${names}(この区間 ${Math.round(r * 100)}%${when})`).addTo(map);
    onSelect(String(f.properties.routes).split(",")[0]);
  });
  if (painted) for (const [id, r] of painted) map.setFeatureState({ source: "routes", id }, { r });
}

export function paintCoverage(map: maplibregl.Map, data: RouteData, coverage: Coverage) {
  // 国道の絞り込みなどで描き直すときは、記録が変わっていなければ何もしない
  if (coverage === painted) return;
  painted = coverage;
  if (map.getSource("routes")) {
    map.removeFeatureState({ source: "routes" });
    for (const [id, r] of coverage) map.setFeatureState({ source: "routes", id }, { r });
  }
  (map.getSource("overview") as GeoJSONSource | undefined)?.setData(buildOverview(data, coverage));
}

export function showTrack(map: maplibregl.Map, track: TrackPoint[]) {
  const data = {
    type: "Feature" as const,
    properties: {},
    geometry: { type: "LineString" as const, coordinates: track.map((p) => [p.lon, p.lat]) },
  };
  const src = map.getSource("track") as GeoJSONSource | undefined;
  if (src) src.setData(data);
  else {
    map.addSource("track", { type: "geojson", data });
    map.addLayer({ id: "track", type: "line", source: "track", paint: { "line-color": "#8e24aa", "line-width": 2, "line-opacity": 0.8 } });
  }
  if (track.length > 0) {
    const b = new maplibregl.LngLatBounds();
    for (const p of track) b.extend([p.lon, p.lat]);
    map.fitBounds(b, { padding: 40, maxZoom: 13 });
  }
}

/** 運転評価の出来事(急ブレーキ・急ハンドルなど)を地図に点で出す。空なら消す */
export function showDriveEvents(map: maplibregl.Map, events: { lat: number; lon: number; label: string }[]) {
  const data = {
    type: "FeatureCollection" as const,
    features: events.map((e) => ({
      type: "Feature" as const,
      properties: { label: e.label },
      geometry: { type: "Point" as const, coordinates: [e.lon, e.lat] },
    })),
  };
  const src = map.getSource("drive-events") as GeoJSONSource | undefined;
  if (src) {
    src.setData(data);
    return;
  }
  map.addSource("drive-events", { type: "geojson", data });
  map.addLayer({
    id: "drive-events",
    type: "circle",
    source: "drive-events",
    paint: { "circle-radius": 6, "circle-color": "#f57c00", "circle-stroke-color": "#fff", "circle-stroke-width": 2 },
  });
  map.on("click", "drive-events", (e) => {
    const f = e.features?.[0];
    if (!f) return;
    new maplibregl.Popup().setLngLat(e.lngLat).setText(String(f.properties.label)).addTo(map);
  });
}

/** 出来事の1つを地図の真ん中に出す */
export function flyToEvent(map: maplibregl.Map, lat: number, lon: number, label: string) {
  map.flyTo({ center: [lon, lat], zoom: Math.max(map.getZoom(), 15) });
  new maplibregl.Popup().setLngLat([lon, lat]).setText(label).addTo(map);
}

export function fitRoute(map: maplibregl.Map, data: RouteData, ref: string, padding: maplibregl.PaddingOptions | number = 40) {
  fitSegments(map, data.segments.filter((s) => s.routes.includes(ref)), padding);
}

export function fitSegments(map: maplibregl.Map, segs: Segment[], padding: maplibregl.PaddingOptions | number = 40) {
  const b = new maplibregl.LngLatBounds();
  for (const s of segs) for (const c of s.coords) b.extend(c);
  // 点線国道のような短い区間は寄りすぎないようにする
  if (!b.isEmpty()) map.fitBounds(b, { padding, maxZoom: 15 });
}

/**
 * 選んだ国道を上に重ねて描く。未踏破は青。
 * 全体の source は引いた縮尺で短い区間(約200m)を間引くので、国道4号のような長い路線を
 * 全体表示すると消えてしまう。こちらは1路線分だけなので tolerance 0 で間引かずに描く。
 */
export function showSelected(map: maplibregl.Map, data: RouteData, ref: string | null, coverage: Coverage) {
  const features = !ref
    ? []
    : data.segments
        .filter((s) => s.routes.includes(ref))
        .map((s) => ({
          type: "Feature" as const,
          properties: { r: coverage.get(s.id) ?? 0, dashed: s.cats.some((c) => c === "dotted" || c === "ferry" || c === "old") },
          geometry: { type: "LineString" as const, coordinates: s.coords },
        }));
  const fc = { type: "FeatureCollection" as const, features };
  const src = map.getSource("selected") as GeoJSONSource | undefined;
  if (src) {
    src.setData(fc);
    return;
  }
  map.addSource("selected", { type: "geojson", data: fc, tolerance: 0 });
  const color = ["case", [">=", ["get", "r"], 1], "#d93025", [">", ["get", "r"], 0], "#f29900", "#1a56db"];
  const width = ["interpolate", ["linear"], ["zoom"], 4, 3, 12, 6];
  map.addLayer({
    id: "selected-casing",
    type: "line",
    source: "selected",
    layout: { "line-cap": "round", "line-join": "round" },
    // zoom の式は一番外側でしか使えないので、太さは段ごとに書く
    paint: { "line-color": "#ffffff", "line-width": ["interpolate", ["linear"], ["zoom"], 4, 6, 12, 9], "line-opacity": 0.9 },
  });
  map.addLayer({
    id: "selected",
    type: "line",
    source: "selected",
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": color as never, "line-width": width as never },
  });
}

/** 内訳や重複区間から選んだ区間を、黄色い帯で目立たせる。ids が空なら消す */
export function showFocus(map: maplibregl.Map, data: RouteData, ids: string[]) {
  const want = new Set(ids);
  const fc = {
    type: "FeatureCollection" as const,
    features: data.segments
      .filter((s) => want.has(s.id))
      .map((s) => ({ type: "Feature" as const, properties: {}, geometry: { type: "LineString" as const, coordinates: s.coords } })),
  };
  const src = map.getSource("focus") as GeoJSONSource | undefined;
  if (src) {
    src.setData(fc);
    return;
  }
  map.addSource("focus", { type: "geojson", data: fc, tolerance: 0 });
  map.addLayer(
    {
      id: "focus",
      type: "line",
      source: "focus",
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": "#ffd400", "line-width": ["interpolate", ["linear"], ["zoom"], 4, 10, 12, 16], "line-opacity": 0.85 },
    },
    map.getLayer("selected-casing") ? "selected-casing" : undefined,
  );
}

// ---- 都道府県の色分け ----

type Ring = [number, number][];
export interface PrefShapes {
  type: "FeatureCollection";
  features: {
    type: "Feature";
    properties: { code: number; name: string };
    geometry: { type: "Polygon"; coordinates: Ring[] } | { type: "MultiPolygon"; coordinates: Ring[][] };
  }[];
}

/** 制覇率(0〜1)を色に。少し走った県から濃くなるよう、平方根で目盛る */
const PREF_COLOR = [
  "case",
  ["<", ["get", "r"], 0],
  "rgba(0,0,0,0)",
  ["interpolate", ["linear"], ["sqrt", ["get", "r"]], 0, "#f3f3f4", 0.05, "#fde2df", 0.3, "#f6a49b", 0.6, "#e5544a", 1, "#8f1d14"],
];

/**
 * 都道府県を制覇率で塗る。values が null なら消す。
 * 道路の線より下に描く(道路のレイヤーはあとから足しても上に来る)
 */
export function showPrefFill(map: maplibregl.Map, shapes: PrefShapes, values: Map<number, { total: number; done: number }> | null) {
  const visibility = values ? "visible" : "none";
  const fc = {
    ...shapes,
    features: shapes.features.map((f) => {
      const p = values?.get(f.properties.code);
      return { ...f, properties: { ...f.properties, r: p && p.total > 0 ? p.done / p.total : -1 } };
    }),
  };
  const src = map.getSource("prefs") as GeoJSONSource | undefined;
  if (src) {
    src.setData(fc as never);
    for (const id of ["prefs-fill", "prefs-line"]) map.setLayoutProperty(id, "visibility", visibility);
    return;
  }
  if (!values) return;
  map.addSource("prefs", { type: "geojson", data: fc as never });
  const before = map.getStyle().layers.find((l) => /^(overview|routes)-/.test(l.id))?.id;
  map.addLayer({
    id: "prefs-fill",
    type: "fill",
    source: "prefs",
    layout: { visibility },
    // 拡大したら道路の線が見やすいよう薄くする
    paint: { "fill-color": PREF_COLOR as never, "fill-opacity": ["interpolate", ["linear"], ["zoom"], 5, 0.6, 10, 0.3] },
  }, before);
  map.addLayer({
    id: "prefs-line",
    type: "line",
    source: "prefs",
    layout: { visibility },
    paint: { "line-color": "#6b6b70", "line-width": 0.8, "line-opacity": 0.6 },
  }, before);
  map.on("click", "prefs-fill", (e) => {
    const f = e.features?.[0];
    if (!f) return;
    // 道路の線を押したときは道路のポップアップを優先する
    const roads = map.getStyle().layers.filter((l) => /^(overview|routes)-/.test(l.id)).map((l) => l.id);
    if (roads.length && map.queryRenderedFeatures(e.point, { layers: roads }).length) return;
    const r = Number(f.properties.r);
    new maplibregl.Popup()
      .setLngLat(e.lngLat)
      .setText(`${f.properties.name}: ${r < 0 ? "データなし" : `${(r * 100).toFixed(1)}%`}`)
      .addTo(map);
  });
}

/** 都道府県の範囲を映す */
export function fitPref(map: maplibregl.Map, shapes: PrefShapes, code: number, padding: maplibregl.PaddingOptions | number = 40) {
  const f = shapes.features.find((x) => x.properties.code === code);
  if (!f) return;
  const b = new maplibregl.LngLatBounds();
  const polys = f.geometry.type === "Polygon" ? [f.geometry.coordinates] : f.geometry.coordinates;
  for (const poly of polys) for (const [lon, lat] of poly[0]) b.extend([lon, lat]);
  map.fitBounds(b, { padding, maxZoom: 11 });
}
