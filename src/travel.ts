// 地図の「旅の記録」レイヤー。iPhone の走行ロガーで記録した電車・飛行機などの移動の線を出す。
// 国道の制覇には使わない(見るだけ)。データは MiniPC のサーバーの GET /api/trips から読む
import maplibregl from "maplibre-gl";

export type TripMode = "train" | "plane" | "ride" | "other";

/** サーバー(server/trips.mjs)が返す1回の移動 */
export interface TravelTrip {
  id: string;
  mode: TripMode;
  start: string | null;
  end: string | null;
  /** 距離(m) */
  m: number;
  maxAltM: number | null;
  /** 実線の区間([経度, 緯度] の並び) */
  lines: [number, number][][];
  /** 点が途切れた間(点線でつなぐ) */
  gaps: [number, number][][];
}

export const TRIP_MODES: { id: TripMode; label: string; icon: string; color: string }[] = [
  { id: "train", label: "電車", icon: "🚆", color: "#00897b" },
  { id: "plane", label: "飛行機", icon: "✈️", color: "#3949ab" },
  { id: "ride", label: "同乗", icon: "🚌", color: "#8d6e63" },
  { id: "other", label: "その他", icon: "🚶", color: "#546e7a" },
];
const modeOf = (id: string) => TRIP_MODES.find((m) => m.id === id) ?? TRIP_MODES[3];

const SOURCE = "travel";
const LAYERS = ["travel-casing", "travel-gap", "travel-line"];
/** 旅の記録より上に置く層(選んだ国道・読み込んだログなど、いま見ているもの) */
const OVERLAY = /^(selected|selected-casing|focus|track|drive-events|period-tracks.*)$/;

interface Settings {
  on: boolean;
  modes: TripMode[];
}
const KEY = "kokudo-travel";
const DEFAULTS: Settings = { on: true, modes: ["train", "plane"] };

export function loadSettings(): Settings {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "null");
    if (v && typeof v.on === "boolean" && Array.isArray(v.modes)) {
      return { on: v.on, modes: v.modes.filter((m: string) => TRIP_MODES.some((x) => x.id === m)) };
    }
  } catch {
    // 保存できないブラウザでは毎回はじめの設定にする
  }
  return { ...DEFAULTS, modes: [...DEFAULTS.modes] };
}

function saveSettings(s: Settings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // 保存できなくても切り替えはできる
  }
}

interface TravelFeature {
  type: "Feature";
  properties: { i: number; id: string; mode: TripMode; gap: 0 | 1 };
  geometry: { type: "LineString"; coordinates: [number, number][] };
}

/** 地図に出す GeoJSON。線ごとに移動の番号(i)と手段(mode)を持たせる */
export function toGeoJSON(trips: TravelTrip[]) {
  const features: TravelFeature[] = [];
  trips.forEach((t, i) => {
    for (const l of t.lines) features.push({ type: "Feature", properties: { i, id: t.id, mode: t.mode, gap: 0 }, geometry: { type: "LineString", coordinates: l } });
    for (const g of t.gaps) features.push({ type: "Feature", properties: { i, id: t.id, mode: t.mode, gap: 1 }, geometry: { type: "LineString", coordinates: g } });
  });
  return { type: "FeatureCollection" as const, features };
}

const jst = (iso: string | null) => {
  if (!iso) return null;
  const d = new Date(new Date(iso).getTime() + 9 * 3600_000);
  if (Number.isNaN(d.getTime())) return null;
  const p = (n: number) => String(n).padStart(2, "0");
  return { day: `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`, time: `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}` };
};

export const formatKm = (m: number) => (m >= 100_000 ? `${Math.round(m / 1000)}km` : `${(m / 1000).toFixed(1)}km`);

/** 線を押したときに出す説明 */
export function describeTrip(t: TravelTrip): string[] {
  const mode = modeOf(t.mode);
  const s = jst(t.start);
  const e = jst(t.end);
  const lines = [`${mode.icon} ${mode.label}`];
  if (s) lines.push(`${s.day} ${s.time}〜${e ? (e.day === s.day ? e.time : `${e.day} ${e.time}`) : ""}`);
  const info = [formatKm(t.m)];
  if (t.start && t.end) {
    const min = Math.round((new Date(t.end).getTime() - new Date(t.start).getTime()) / 60_000);
    if (min > 0) info.push(min >= 60 ? `${Math.floor(min / 60)}時間${min % 60}分` : `${min}分`);
  }
  if (t.mode === "plane" && t.maxAltM !== null) info.push(`最高 ${t.maxAltM.toLocaleString()}m`);
  lines.push(info.join(" / "));
  return lines;
}

/** only: ログタブで期間を指定しているときに出す移動(手段の設定にかかわらず、これだけを出す) */
const layerFilter = (id: string, modes: TripMode[], only: string[] | null = null) =>
  [
    "all",
    ["==", ["get", "gap"], id === "travel-gap" ? 1 : 0],
    only ? ["in", ["get", "id"], ["literal", only]] : ["in", ["get", "mode"], ["literal", modes]],
  ] as never;

/** 移動の日付(日本時間の YYYY-MM-DD)。時刻がなければ "" */
export function tripDay(t: TravelTrip): string {
  return jst(t.start)?.day ?? "";
}

/** 移動の範囲 [[西, 南], [東, 北]]。点がなければ null */
export function tripBounds(list: TravelTrip[]): [[number, number], [number, number]] | null {
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const t of list) for (const l of [...t.lines, ...t.gaps]) for (const [x, y] of l) {
    w = Math.min(w, x); e = Math.max(e, x); s = Math.min(s, y); n = Math.max(n, y);
  }
  return w === Infinity ? null : [[w, s], [e, n]];
}

// 読み込んだ移動(地図の線とログタブの一覧で使う)
let trips: TravelTrip[] = [];
let loadedAt = 0;
let failed: string | null = null;
let loading: Promise<TravelTrip[]> | null = null;
const listeners: (() => void)[] = [];

/** MiniPC のサーバーから移動を読み込む。force でなければ30秒以内に読んだものを使う */
export function loadTravelTrips(force = false): Promise<TravelTrip[]> {
  if (loading) return loading;
  if (!force && loadedAt && Date.now() - loadedAt < 30_000) return Promise.resolve(trips);
  loading = (async () => {
    try {
      const r = await fetch(`${import.meta.env.BASE_URL}api/trips`);
      if (!r.ok || !r.headers.get("content-type")?.includes("json")) throw new Error("MiniPC のサーバーで開いたときだけ見られます");
      trips = ((await r.json()) as { trips: TravelTrip[] }).trips ?? [];
      failed = null;
    } catch (e) {
      failed = (e as Error).message;
    }
    loadedAt = Date.now();
    loading = null;
    for (const f of listeners) f();
    return trips;
  })();
  return loading;
}

let highlight: (only: string[] | null) => void = () => {};
/** ログタブで期間を指定したとき、その期間の移動だけを(旅の記録の設定にかかわらず)出す。null で元に戻す */
export function showOnlyTrips(only: string[] | null) {
  highlight(only);
}

/** 旅の記録の層を、道路の線の上・いま見ているもの(選んだ国道・ログ)の下に保つ */
function keepOrder(map: maplibregl.Map) {
  const ids = map.getStyle().layers.map((l) => l.id);
  if (!LAYERS.every((id) => ids.includes(id))) return;
  const rest = ids.filter((id) => !LAYERS.includes(id));
  const before = rest.find((id) => OVERLAY.test(id));
  const want = before ? [...rest.slice(0, rest.indexOf(before)), ...LAYERS, ...rest.slice(rest.indexOf(before))] : [...rest, ...LAYERS];
  if (want.every((id, k) => ids[k] === id)) return;
  for (const id of LAYERS) map.moveLayer(id, before);
}

/** 旅の記録の線と、表示を切り替えるボタン(地図の右下)を置く */
export function addTravelLayer(map: maplibregl.Map) {
  let settings = loadSettings();
  let only: string[] | null = null;

  map.addSource(SOURCE, { type: "geojson", data: toGeoJSON([]) });
  const color = ["match", ["get", "mode"], ...TRIP_MODES.flatMap((m) => [m.id, m.color]), "#546e7a"] as never;
  const width = ["interpolate", ["linear"], ["zoom"], 4, 2, 12, 4] as never;
  const layout = { visibility: settings.on ? ("visible" as const) : ("none" as const), "line-cap": "round" as const, "line-join": "round" as const };
  map.addLayer({
    id: "travel-casing",
    type: "line",
    source: SOURCE,
    filter: layerFilter("travel-casing", settings.modes),
    layout,
    paint: { "line-color": "#ffffff", "line-width": ["interpolate", ["linear"], ["zoom"], 4, 4, 12, 7] as never, "line-opacity": 0.8 },
  });
  map.addLayer({
    id: "travel-gap",
    type: "line",
    source: SOURCE,
    filter: layerFilter("travel-gap", settings.modes),
    layout: { ...layout, "line-cap": "butt" },
    paint: { "line-color": color, "line-width": width, "line-opacity": 0.7, "line-dasharray": [2, 2] },
  });
  map.addLayer({
    id: "travel-line",
    type: "line",
    source: SOURCE,
    filter: layerFilter("travel-line", settings.modes),
    layout,
    paint: { "line-color": color, "line-width": width, "line-opacity": 0.9 },
  });
  keepOrder(map);
  map.on("styledata", () => keepOrder(map));

  const apply = () => {
    for (const id of LAYERS) {
      map.setLayoutProperty(id, "visibility", settings.on || only ? "visible" : "none");
      map.setFilter(id, layerFilter(id, settings.modes, only));
    }
    saveSettings(settings);
    control.render();
  };
  highlight = (o) => {
    only = o;
    apply();
  };

  listeners.push(() => {
    (map.getSource(SOURCE) as maplibregl.GeoJSONSource).setData(toGeoJSON(trips));
    control.render();
  });
  const load = () => void loadTravelTrips(true);

  const popup = new maplibregl.Popup({ closeButton: true, maxWidth: "260px" });
  map.on("click", "travel-line", (e) => {
    const i = e.features?.[0]?.properties?.i;
    const t = typeof i === "number" ? trips[i] : undefined;
    if (!t) return;
    const el = document.createElement("div");
    el.className = "travel-popup";
    for (const line of describeTrip(t)) el.append(Object.assign(document.createElement("div"), { textContent: line }));
    popup.setLngLat(e.lngLat).setDOMContent(el).addTo(map);
  });
  map.on("mouseenter", "travel-line", () => (map.getCanvas().style.cursor = "pointer"));
  map.on("mouseleave", "travel-line", () => (map.getCanvas().style.cursor = ""));

  const fit = () => {
    const shown = trips.filter((t) => settings.modes.includes(t.mode));
    const b = new maplibregl.LngLatBounds();
    for (const t of shown) for (const l of [...t.lines, ...t.gaps]) for (const p of l) b.extend(p);
    if (!b.isEmpty()) map.fitBounds(b, { padding: 40, maxZoom: 13 });
  };

  class TravelControl implements maplibregl.IControl {
    private el = document.createElement("div");
    private panel = document.createElement("div");
    private button = document.createElement("button");
    onAdd() {
      this.el.className = "maplibregl-ctrl maplibregl-ctrl-group travel-ctrl";
      this.button.type = "button";
      this.button.className = "travel-toggle";
      this.button.textContent = "旅";
      this.button.title = "旅の記録(電車・飛行機など)";
      this.button.setAttribute("aria-label", this.button.title);
      this.button.addEventListener("click", () => {
        this.panel.hidden = !this.panel.hidden;
        // 開くたびに新しい記録を読む(続けて開いたときは読まない)
        if (!this.panel.hidden) void loadTravelTrips();
        this.render();
      });
      this.panel.className = "travel-panel";
      this.panel.hidden = true;
      this.el.append(this.panel, this.button);
      this.render();
      return this.el;
    }
    onRemove() {
      this.el.remove();
    }
    render() {
      this.button.classList.toggle("on", settings.on);
      this.button.setAttribute("aria-expanded", String(!this.panel.hidden));
      if (this.panel.hidden) return;
      this.panel.replaceChildren();
      const head = document.createElement("label");
      head.className = "travel-head";
      const all = Object.assign(document.createElement("input"), { type: "checkbox", checked: settings.on });
      all.addEventListener("change", () => {
        settings = { ...settings, on: all.checked };
        apply();
      });
      head.append(all, " 旅の記録を表示");
      this.panel.append(head);
      for (const m of TRIP_MODES) {
        const list = trips.filter((t) => t.mode === m.id);
        const row = document.createElement("label");
        row.className = "travel-row";
        const box = Object.assign(document.createElement("input"), { type: "checkbox", checked: settings.modes.includes(m.id), disabled: !settings.on });
        box.addEventListener("change", () => {
          const modes = TRIP_MODES.map((x) => x.id).filter((id) => (id === m.id ? box.checked : settings.modes.includes(id)));
          settings = { ...settings, modes };
          apply();
        });
        const swatch = Object.assign(document.createElement("span"), { className: "travel-swatch" });
        swatch.style.background = m.color;
        const km = list.reduce((s, t) => s + t.m, 0);
        row.append(box, swatch, ` ${m.icon} ${m.label}`, Object.assign(document.createElement("span"), { className: "muted", textContent: ` ${list.length}回 ${formatKm(km)}` }));
        this.panel.append(row);
      }
      if (failed) this.panel.append(Object.assign(document.createElement("p"), { className: "muted", textContent: failed }));
      else if (!loadedAt) this.panel.append(Object.assign(document.createElement("p"), { className: "muted", textContent: "読み込み中…" }));
      else if (!trips.length) this.panel.append(Object.assign(document.createElement("p"), { className: "muted", textContent: "まだ記録がありません(iPhone の走行ロガーで電車・飛行機などを選んで記録すると出ます)" }));
      else {
        const b = Object.assign(document.createElement("button"), { type: "button", className: "travel-fit", textContent: "全体を表示" });
        b.addEventListener("click", fit);
        this.panel.append(b);
      }
    }
  }
  const control = new TravelControl();
  map.addControl(control, "bottom-right");
  load();
}
