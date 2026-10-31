import maplibregl, { type GeoJSONSource } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import type { PassDates } from "./store";
import type { Coverage, RouteData, TrackPoint } from "./types";

export function createMap(container: HTMLElement): maplibregl.Map {
  return new maplibregl.Map({
    container,
    center: [137.5, 37.5],
    zoom: 4.5,
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

export function addRoutes(
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
  const width = ["interpolate", ["linear"], ["zoom"], 5, 1.5, 12, 4];
  map.addLayer({
    id: "routes-road",
    type: "line",
    source: "routes",
    filter: ["all", ["!", ["get", "dotted"]], ["!", ["get", "ferry"]]],
    paint: { "line-color": color as never, "line-width": width as never },
  });
  map.addLayer({
    id: "routes-dotted",
    type: "line",
    source: "routes",
    filter: ["get", "dotted"],
    paint: { "line-color": color as never, "line-width": width as never, "line-dasharray": [1, 1.5] },
  });
  map.addLayer({
    id: "routes-ferry",
    type: "line",
    source: "routes",
    filter: ["get", "ferry"],
    paint: { "line-color": color as never, "line-width": 1.5, "line-dasharray": [3, 3] },
  });

  map.on("click", ["routes-road", "routes-dotted", "routes-ferry"], (e) => {
    const f = e.features?.[0];
    if (!f) return;
    const names = String(f.properties.routes)
      .split(",")
      .map((r) => data.routes[r]?.name ?? `国道${r}号`)
      .join(" / ");
    const r = Number(f.state?.r ?? 0);
    const d = datesOf(String(f.properties.id));
    const when = !d ? "" : d[0] === d[1] ? ` / ${d[0]} に通過` : ` / 初めて ${d[0]}、最後 ${d[1]}`;
    new maplibregl.Popup().setLngLat(e.lngLat).setText(`${names}(この区間 ${Math.round(r * 100)}%${when})`).addTo(map);
    onSelect(String(f.properties.routes).split(",")[0]);
  });
}

export function paintCoverage(map: maplibregl.Map, coverage: Coverage) {
  map.removeFeatureState({ source: "routes" });
  for (const [id, r] of coverage) map.setFeatureState({ source: "routes", id }, { r });
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
    map.addLayer({ id: "track", type: "line", source: "track", paint: { "line-color": "#1a73e8", "line-width": 2, "line-opacity": 0.7 } });
  }
  if (track.length > 0) {
    const b = new maplibregl.LngLatBounds();
    for (const p of track) b.extend([p.lon, p.lat]);
    map.fitBounds(b, { padding: 40, maxZoom: 13 });
  }
}

export function fitRoute(map: maplibregl.Map, data: RouteData, ref: string, padding: maplibregl.PaddingOptions | number = 40) {
  const b = new maplibregl.LngLatBounds();
  for (const s of data.segments) if (s.routes.includes(ref)) for (const c of s.coords) b.extend(c);
  if (!b.isEmpty()) map.fitBounds(b, { padding });
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
    paint: { "line-color": "#ffffff", "line-width": ["+", width, 3] as never, "line-opacity": 0.9 },
  });
  map.addLayer({
    id: "selected",
    type: "line",
    source: "selected",
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": color as never, "line-width": width as never },
  });
}
