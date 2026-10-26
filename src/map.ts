import maplibregl, { type GeoJSONSource } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
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

export function addRoutes(map: maplibregl.Map, data: RouteData) {
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
    new maplibregl.Popup().setLngLat(e.lngLat).setText(`${names}(この区間 ${Math.round(r * 100)}%)`).addTo(map);
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

export function fitRoute(map: maplibregl.Map, data: RouteData, ref: string) {
  const b = new maplibregl.LngLatBounds();
  for (const s of data.segments) if (s.routes.includes(ref)) for (const c of s.coords) b.extend(c);
  if (!b.isEmpty()) map.fitBounds(b, { padding: 40 });
}
