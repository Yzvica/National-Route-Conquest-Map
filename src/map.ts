import maplibregl, { type GeoJSONSource } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import type { PassDates } from "./store";
import type { Coverage, LonLat, RouteData, Segment, TrackPoint } from "./types";

export function createMap(container: HTMLElement): maplibregl.Map {
  return new maplibregl.Map({
    container,
    // 北海道から沖縄まで入るように
    bounds: [[123, 24], [146, 45.6]],
    fitBoundsOptions: { padding: 20 },
    style: {
      version: 8,
      sources: {
        gsi: {
          type: "raster",
          tiles: ["https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png"],
          tileSize: 256,
          maxzoom: 18,
          attribution:
            '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank">地理院タイル</a> / 道路: © <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap contributors</a>',
        },
      },
      layers: [{ id: "gsi", type: "raster", source: "gsi" }],
    },
  });
}

/** 今のデータ(国道/高速道路)で登録したイベントの後始末。データを切り替えるときに呼ぶ */
let cleanups: (() => void)[] = [];

function onLayers(map: maplibregl.Map, layers: string[], fn: (e: maplibregl.MapLayerMouseEvent) => void) {
  map.on("click", layers, fn);
  cleanups.push(() => map.off("click", layers, fn));
}

const routeLabel = (data: RouteData, ref: string) =>
  data.routes[ref]?.name ?? (data.kind === "expressway" ? ref : `国道${ref}号`);

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
  onLayers(map, ["overview-road", "overview-dotted", "overview-ferry"], (e) => {
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
    filter: ["all", ["!", ["get", "dotted"]], ["!", ["get", "ferry"]]],
    paint: { "line-color": color as never, "line-width": width as never },
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

/**
 * 端点でつながっていて、国道・種別・走行状況(未走行/一部/走行済み)が同じ区間を1本の線にまとめる。
 * 約36万区間が数千本になり、引いた縮尺でも速く、消えずに描ける。
 */
export function buildOverview(data: RouteData, coverage: Coverage) {
  const segs = data.segments;
  const keys = segs.map((s) => {
    const r = coverage.get(s.id) ?? 0;
    return `${s.routes.join(",")}|${s.cats.includes("dotted") ? 1 : 0}${s.cats.includes("ferry") ? 1 : 0}|${r >= 1 ? 2 : r > 0 ? 1 : 0}`;
  });
  const pt = (c: LonLat) => `${c[0]},${c[1]}`;
  const ends = new Map<string, number[]>();
  const addEnd = (k: string, i: number) => {
    const list = ends.get(k);
    if (list) list.push(i);
    else ends.set(k, [i]);
  };
  segs.forEach((s, i) => {
    addEnd(`${keys[i]}@${pt(s.coords[0])}`, i);
    addEnd(`${keys[i]}@${pt(s.coords[s.coords.length - 1])}`, i);
  });
  const used = new Uint8Array(segs.length);
  const next = (k: string, c: LonLat) => ends.get(`${k}@${pt(c)}`)?.find((j) => !used[j]);

  const features = [];
  for (let i = 0; i < segs.length; i++) {
    if (used[i]) continue;
    used[i] = 1;
    const k = keys[i];
    let line: LonLat[] = [...segs[i].coords];
    // 後ろへ、次に前へ伸ばす
    for (let j = next(k, line[line.length - 1]); j !== undefined; j = next(k, line[line.length - 1])) {
      used[j] = 1;
      const c = segs[j].coords;
      line.push(...(pt(c[0]) === pt(line[line.length - 1]) ? c.slice(1) : [...c].reverse().slice(1)));
    }
    for (let j = next(k, line[0]); j !== undefined; j = next(k, line[0])) {
      used[j] = 1;
      const c = segs[j].coords;
      line = (pt(c[c.length - 1]) === pt(line[0]) ? c.slice(0, -1) : [...c].reverse().slice(0, -1)).concat(line);
    }
    const [routes, kind, state] = k.split("|");
    features.push({
      type: "Feature" as const,
      properties: { routes, dotted: kind[0] === "1", ferry: kind[1] === "1", s: Number(state) },
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
        properties: { id: s.id, routes: s.routes.join(","), dotted: s.cats.includes("dotted"), ferry: s.cats.includes("ferry") },
        geometry: { type: "LineString", coordinates: s.coords },
      })),
    },
  });
  const ratio = ["coalesce", ["feature-state", "r"], 0];
  const color = ["case", [">=", ratio, 1], "#d93025", [">", ratio, 0], "#f29900", "#9aa0a6"];
  addLineLayers(map, "routes", "routes", color, { minzoom: DETAIL_ZOOM }, "overview-road");

  onLayers(map, ["routes-road", "routes-dotted", "routes-ferry"], (e) => {
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
          properties: { r: coverage.get(s.id) ?? 0, dashed: s.cats.includes("dotted") || s.cats.includes("ferry") },
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
    // zoom は interpolate の一番外でしか使えないので、太さに 3 を足した式を別に作る
    paint: { "line-color": "#ffffff", "line-width": ["interpolate", ["linear"], ["zoom"], 4, 6, 12, 9] as never, "line-opacity": 0.9 },
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
      paint: { "line-color": "#ffd400", "line-width": ["interpolate", ["linear"], ["zoom"], 4, 10, 12, 16], "line-opacity": 0.7 },
    },
    map.getLayer("selected-casing") ? "selected-casing" : undefined,
  );
}
