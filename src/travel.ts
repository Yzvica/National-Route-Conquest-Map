// 地図の「旅の記録」レイヤー。iPhone の走行ロガーで記録した電車・飛行機などの移動の線を出す。
// 国道の制覇には使わない(見るだけ)。データは MiniPC のサーバーの GET /api/trips から読む
import * as maplibregl from "maplibre-gl";

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

/** 「旅」パネルで選ぶ手段。car は自分の運転(保存してある車のログ) */
export type ShowMode = "car" | TripMode;
export const PANEL_MODES: { id: ShowMode; label: string; icon: string; color: string }[] = [
  { id: "car", label: "運転", icon: "🚗", color: "#c2185b" },
  ...TRIP_MODES,
];

const KEY = "kokudo-travel-modes";
/** はじめは自分の運転だけ */
const DEFAULT_MODES: ShowMode[] = ["car"];

/** 期間を指定したときに、はじめから地図に出す手段 */
export function travelModes(): ShowMode[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "null");
    if (Array.isArray(v)) return PANEL_MODES.map((m) => m.id).filter((id) => v.includes(id));
  } catch {
    // 保存できないブラウザでは毎回はじめの設定にする
  }
  return [...DEFAULT_MODES];
}

function saveModes(modes: ShowMode[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(modes));
  } catch {
    // 保存できなくても切り替えはできる
  }
}

/** 「旅」パネルが main.ts に聞くこと・知らせること */
export interface TravelHooks {
  /** 期間を指定しているときの手段ごとの本数と距離(m)。期間を指定していなければ null */
  counts(): Map<ShowMode, { n: number; m: number }> | null;
  /** 手段のチェックを変えた */
  onModes(changed: ShowMode, on: boolean): void;
  /** 地図に出ているものが全部入るように合わせる */
  fit(): void;
}
let hooks: TravelHooks = { counts: () => null, onModes: () => {}, fit: () => {} };
let rerender: () => void = () => {};
export function setTravelHooks(h: TravelHooks) {
  hooks = h;
  rerender();
}
/** 期間や一覧が変わったので、開いているパネルを描き直す */
export function refreshTravelPanel() {
  rerender();
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

/** only: 地図に出す移動(ログタブの一覧でチェックしたもの)。空なら何も出さない */
const layerFilter = (id: string, only: string[]) =>
  ["all", ["==", ["get", "gap"], id === "travel-gap" ? 1 : 0], ["in", ["get", "id"], ["literal", only]]] as never;

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

let highlight: (only: string[]) => void = () => {};
/** 地図に出す移動を決める(ログタブの一覧でチェックしたもの)。空なら何も出さない */
export function showOnlyTrips(only: string[]) {
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

/** 旅の記録の線と、地図に出すものを選ぶボタン(地図の右下)を置く */
export function addTravelLayer(map: maplibregl.Map) {
  let modes = travelModes();
  let only: string[] = [];

  map.addSource(SOURCE, { type: "geojson", data: toGeoJSON([]) });
  const color = ["match", ["get", "mode"], ...TRIP_MODES.flatMap((m) => [m.id, m.color]), "#546e7a"] as never;
  const width = ["interpolate", ["linear"], ["zoom"], 4, 2, 12, 4] as never;
  const layout = { "line-cap": "round" as const, "line-join": "round" as const };
  map.addLayer({
    id: "travel-casing",
    type: "line",
    source: SOURCE,
    filter: layerFilter("travel-casing", only),
    layout,
    paint: { "line-color": "#ffffff", "line-width": ["interpolate", ["linear"], ["zoom"], 4, 4, 12, 7] as never, "line-opacity": 0.8 },
  });
  map.addLayer({
    id: "travel-gap",
    type: "line",
    source: SOURCE,
    filter: layerFilter("travel-gap", only),
    layout: { ...layout, "line-cap": "butt" },
    paint: { "line-color": color, "line-width": width, "line-opacity": 0.7, "line-dasharray": [2, 2] },
  });
  map.addLayer({
    id: "travel-line",
    type: "line",
    source: SOURCE,
    filter: layerFilter("travel-line", only),
    layout,
    paint: { "line-color": color, "line-width": width, "line-opacity": 0.9 },
  });
  keepOrder(map);
  map.on("styledata", () => keepOrder(map));

  highlight = (o) => {
    only = o;
    for (const id of LAYERS) map.setFilter(id, layerFilter(id, only));
  };

  listeners.push(() => {
    (map.getSource(SOURCE) as maplibregl.GeoJSONSource).setData(toGeoJSON(trips));
    control.render();
  });

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

  const text = (tag: string, className: string, textContent: string) => Object.assign(document.createElement(tag), { className, textContent });

  class TravelControl implements maplibregl.IControl {
    private el = document.createElement("div");
    private panel = document.createElement("div");
    private button = document.createElement("button");
    onAdd() {
      this.el.className = "maplibregl-ctrl maplibregl-ctrl-group travel-ctrl";
      this.button.type = "button";
      this.button.className = "travel-toggle";
      this.button.textContent = "旅";
      this.button.title = "地図に出すログ(運転・電車・飛行機など)";
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
      const counts = hooks.counts();
      this.button.classList.toggle("on", counts !== null);
      this.button.setAttribute("aria-expanded", String(!this.panel.hidden));
      if (this.panel.hidden) return;
      this.panel.replaceChildren();
      this.panel.append(text("div", "travel-head", "地図に出すもの"));
      if (!counts) {
        this.panel.append(
          text("p", "muted", "ログタブの一覧でチェックしたログだけを地図に出します。期間を指定すると、ここで手段ごとにまとめて切り替えられます。"),
        );
      } else {
        for (const m of PANEL_MODES) {
          const c = counts.get(m.id) ?? { n: 0, m: 0 };
          const row = document.createElement("label");
          row.className = "travel-row";
          const box = Object.assign(document.createElement("input"), { type: "checkbox", checked: modes.includes(m.id) });
          box.addEventListener("change", () => {
            modes = PANEL_MODES.map((x) => x.id).filter((id) => (id === m.id ? box.checked : modes.includes(id)));
            saveModes(modes);
            hooks.onModes(m.id, box.checked);
            this.render();
          });
          const swatch = Object.assign(document.createElement("span"), { className: "travel-swatch" });
          swatch.style.background = m.color;
          row.append(box, swatch, ` ${m.icon} ${m.label}`, text("span", "muted", ` ${c.n}${m.id === "car" ? "本" : "回"} ${formatKm(c.m)}`));
          this.panel.append(row);
        }
        this.panel.append(text("p", "muted", "一覧の左のチェックで、1本ずつ出したり消したりできます。"));
      }
      if (failed) this.panel.append(text("p", "muted", failed));
      const b = Object.assign(document.createElement("button"), { type: "button", className: "travel-fit", textContent: "地図に出ているものを全体表示" });
      b.addEventListener("click", () => hooks.fit());
      this.panel.append(b);
    }
  }
  const control = new TravelControl();
  rerender = () => control.render();
  map.addControl(control, "bottom-right");
  void loadTravelTrips(true);
}

/** 移動手段を直した結果(server.mjs の changeMode) */
export interface ModeChange {
  session: string;
  mode: ShowMode;
  from: ShowMode;
  kind: "drive" | "trip";
  moved: boolean;
  /** 地図(国道の判定)に車のログがあるか */
  gpx: boolean;
  /** 判定から外したログの数 */
  removed: number;
  /** 判定し直しが要るとき: "server" は MiniPC で始めた、"browser" はこの画面で判定し直す */
  rejudge: "server" | "browser" | null;
}

/** iPhone のロガーの走行の移動手段を MiniPC で直す */
export async function changeSessionMode(session: string, mode: ShowMode): Promise<ModeChange> {
  const r = await fetch(`${import.meta.env.BASE_URL}api/rawlog/mode?session=${encodeURIComponent(session)}&mode=${mode}`, { method: "POST" });
  if (!r.ok || !r.headers.get("content-type")?.includes("json")) {
    throw new Error(r.status === 404 ? "MiniPC にこの走行が見つかりません" : `移動手段を直せませんでした(${r.status})`);
  }
  loadedAt = 0; // 旅の記録を読み直す
  return r.json();
}
