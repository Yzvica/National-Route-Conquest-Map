// ログタブの「まとめ画像」: 旅行(期間)や1本のログの経路を地図に描き、距離・通った国道などのサマリーを添えた1枚の画像を作る。
// 画像はその場で作って見せるだけ(MiniPC には保存しない)。iPhone では長押しか「共有」で写真に保存できる
import * as maplibregl from "maplibre-gl";
import { km, num } from "./gameView";
import type { PassedRoute, TripStats } from "./logView";
import type { PeriodItem } from "./period";
import type { SavedLog } from "./store";
import { PANEL_MODES, TRIP_MODES, type ShowMode, type TravelTrip } from "./travel";
import type { DatasetKind } from "./types";

/** 画像の地図に描く線 */
export interface CardLine {
  coords: [number, number][];
  color: string;
  /** 記録が途切れた間(点線) */
  dashed?: boolean;
}

/** 画像の文字の部分 */
export interface CardInfo {
  title: string;
  subtitle: string;
  /** 大きく出す数字 */
  tiles: { label: string; value: string; unit?: string }[];
  /** 手段ごとの内訳など(色の印つき) */
  rows: { color?: string; text: string }[];
  /** 通った道路(種別ごと) */
  routes: { label: string; count: number; names: string[] }[];
  footer: string;
}

const WD = "日月火水木金土";
/** "2026-11-07" → "2026/11/7(土)"。year=false なら年を付けない */
export function dayLabel(day: string, year = true): string {
  const wd = WD[new Date(`${day}T00:00:00Z`).getUTCDay()];
  const md = `${Number(day.slice(5, 7))}/${Number(day.slice(8, 10))}(${wd})`;
  return year ? `${day.slice(0, 4)}/${md}` : md;
}

/** 期間の表示と日数。同じ年なら2つめの日付に年を付けない */
export function rangeLabel(from: string, to: string): string {
  if (from === to) return dayLabel(from);
  const days = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
  return `${dayLabel(from)}〜${dayLabel(to, from.slice(0, 4) !== to.slice(0, 4))}・${days}日間`;
}

const pad = (n: number) => String(n).padStart(2, "0");
/** 日本時間の時:分(ブラウザの時間帯によらない) */
const hmJst = (ms: number) => {
  const d = new Date(ms + 9 * 3600_000);
  return `${d.getUTCHours()}:${pad(d.getUTCMinutes())}`;
};
const duration = (ms: number) => {
  const min = Math.round(ms / 60_000);
  return min >= 60 ? `${Math.floor(min / 60)}時間${pad(min % 60)}分` : `${min}分`;
};
const kmText = (m: number) => km(m, m >= 100_000 ? 0 : 1);

/** 何本ものログで通った路線を、路線ごとに足し合わせる(長い順) */
export function mergeRoutes(lists: PassedRoute[][]): PassedRoute[] {
  const by = new Map<string, PassedRoute>();
  for (const list of lists) {
    for (const r of list) {
      const k = `${r.kind}:${r.ref}`;
      const cur = by.get(k);
      by.set(k, cur ? { ...cur, m: cur.m + r.m } : { ...r });
    }
  }
  return [...by.values()].sort((a, b) => b.m - a.m);
}

const ROUTE_LABELS: [DatasetKind, string][] = [
  ["kokudo", "通った国道"],
  ["expressway", "通った高速道路"],
  ["prefroad", "通った都道府県道"],
];

/** 通った道路の欄。国道は番号の順、ほかは長い順に名前を並べる(多すぎる分は数だけ) */
export function routeSections(routes: PassedRoute[] | null, max = 40): CardInfo["routes"] {
  if (!routes) return [];
  return ROUTE_LABELS.flatMap(([kind, label]) => {
    let list = routes.filter((r) => r.kind === kind);
    if (!list.length) return [];
    if (kind === "kokudo") list = [...list].sort((a, b) => (Number(a.ref) || 9999) - (Number(b.ref) || 9999) || a.ref.localeCompare(b.ref));
    return [{ label, count: list.length, names: list.slice(0, max).map((r) => r.name) }];
  });
}

const footerText = (overall?: number) =>
  `国道制覇マップ${overall !== undefined ? `・いまの国道の総合制覇率 ${overall.toFixed(2)}%` : ""}`;

const modeOf = (id: ShowMode) => PANEL_MODES.find((m) => m.id === id) ?? PANEL_MODES[PANEL_MODES.length - 1];
const itemMode = (it: PeriodItem): ShowMode => (it.kind === "log" ? "car" : it.trip.mode);
const itemM = (it: PeriodItem) => (it.kind === "log" ? (it.log.m ?? 0) : it.trip.m);

/** 旅行(期間)や、チェックした何本かのログのまとめ */
export function periodCardInfo(opts: {
  title: string;
  /** 期間(なければ items の日付から) */
  from?: string;
  to?: string;
  items: PeriodItem[];
  routes: PassedRoute[] | null;
  overall?: number;
}): CardInfo {
  const { items } = opts;
  const days = items.map((i) => i.day).filter(Boolean).sort();
  const from = opts.from ?? days[0];
  const to = opts.to ?? days[days.length - 1];
  const total = items.reduce((s, i) => s + itemM(i), 0);
  const tiles: CardInfo["tiles"] = [{ label: "合計の距離", value: kmText(total), unit: "km" }];
  const cars = items.filter((i) => i.kind === "log");
  if (cars.length) tiles.push({ label: "運転", value: kmText(cars.reduce((s, i) => s + itemM(i), 0)), unit: "km" });
  const scored = cars.flatMap((i) => (i.kind === "log" && i.log.score !== undefined ? [i.log.score] : []));
  if (scored.length) tiles.push({ label: "運転評価の平均", value: num(scored.reduce((s, x) => s + x, 0) / scored.length, 0), unit: "点" });
  const kokudo = opts.routes?.filter((r) => r.kind === "kokudo").length;
  if (kokudo) tiles.push({ label: "通った国道", value: String(kokudo), unit: "路線" });
  const rows: CardInfo["rows"] = [];
  for (const m of PANEL_MODES) {
    const list = items.filter((i) => itemMode(i) === m.id);
    if (!list.length) continue;
    const m2 = list.reduce((s, i) => s + itemM(i), 0);
    rows.push({ color: m.color, text: `${m.icon} ${m.label} ${list.length}${m.id === "car" ? "本" : "回"}・${kmText(m2)} km` });
  }
  return {
    title: opts.title,
    subtitle: from && to ? rangeLabel(from, to) : "",
    tiles: tiles.slice(0, 4),
    rows,
    routes: routeSections(opts.routes),
    footer: footerText(opts.overall),
  };
}

/** 1本の車のログのまとめ */
export function logCardInfo(log: SavedLog, stats: TripStats, routes: PassedRoute[] | null, overall?: number): CardInfo {
  const day = log.date;
  const time = stats.start !== undefined && stats.end !== undefined ? `${hmJst(stats.start)}〜${hmJst(stats.end)}` : "";
  const tiles: CardInfo["tiles"] = [{ label: "距離", value: kmText(stats.m), unit: "km" }];
  if (stats.movingMs !== undefined) tiles.push({ label: "走っていた時間", value: duration(stats.movingMs) });
  if (stats.avgKmh !== undefined) tiles.push({ label: "平均速度", value: num(stats.avgKmh, 0), unit: "km/h" });
  if (log.score !== undefined) tiles.push({ label: "運転評価", value: num(log.score, 0), unit: "点" });
  const rows: CardInfo["rows"] = [];
  if (stats.totalMs !== undefined) rows.push({ text: `⏱ かかった時間 ${duration(stats.totalMs)}${stats.maxKmh !== undefined ? `・最高 ${num(stats.maxKmh, 0)} km/h` : ""}` });
  const w = log.weather;
  if (w) rows.push({ text: `${w.icon} ${w.label}${w.tMin !== null && w.tMax !== null ? ` ${num(w.tMin, 0)}〜${num(w.tMax, 0)}℃` : ""}` });
  return {
    title: `🚗 ${day ? dayLabel(day, false) + "の" : ""}ドライブ`,
    subtitle: [day ? dayLabel(day) : "", time, log.name].filter(Boolean).join("・"),
    tiles,
    rows,
    routes: routeSections(routes),
    footer: footerText(overall),
  };
}

/** 旅の記録(電車・飛行機など)の線 */
export function tripLines(t: TravelTrip): CardLine[] {
  const color = (TRIP_MODES.find((m) => m.id === t.mode) ?? TRIP_MODES[3]).color;
  return [...t.lines.map((coords) => ({ coords, color })), ...t.gaps.map((coords) => ({ coords, color, dashed: true }))];
}

export const carColor = () => modeOf("car").color;

// ---- 地図を描く ----

/** 線が全部入る範囲。線がなければ null */
export function linesBounds(lines: CardLine[]): [[number, number], [number, number]] | null {
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const l of lines) {
    for (const [x, y] of l.coords) {
      if (x < w) w = x;
      if (x > e) e = x;
      if (y < s) s = y;
      if (y > n) n = y;
    }
  }
  return w === Infinity ? null : [[w, s], [e, n]];
}

const TILE_URLS: { [id: string]: string } = {
  pale: "pale/{z}/{x}/{y}.png",
  blank: "blank/{z}/{x}/{y}.png",
  std: "std/{z}/{x}/{y}.png",
  photo: "seamlessphoto/{z}/{x}/{y}.jpg",
};

/**
 * 画面に出していない地図で線を描き、画像(canvas)にする。
 * width・height は CSS の px。scale 倍の大きさで描く(文字やタイルの見た目は画面と同じ大きさ)
 */
export async function renderRouteMap(
  lines: CardLine[],
  opts: { width: number; height: number; scale?: number; basemap?: string; markers?: { at: [number, number]; color: string }[] },
): Promise<HTMLCanvasElement> {
  const box = linesBounds(lines);
  if (!box) throw new Error("地図に描く線がありません");
  const scale = opts.scale ?? 2;
  const container = document.createElement("div");
  container.style.cssText = `position:fixed;left:-${opts.width + 1000}px;top:0;width:${opts.width}px;height:${opts.height}px;`;
  document.body.appendChild(container);
  const tiles = TILE_URLS[opts.basemap ?? "pale"] ?? TILE_URLS.pale;
  const feature = (l: CardLine) => ({
    type: "Feature" as const,
    properties: { color: l.color, dashed: !!l.dashed },
    geometry: { type: "LineString" as const, coordinates: l.coords },
  });
  const width = Math.max(opts.width, opts.height) >= 500 ? 4 : 3;
  const map = new maplibregl.Map({
    container,
    style: {
      version: 8,
      sources: {
        base: { type: "raster", tiles: [`https://cyberjapandata.gsi.go.jp/xyz/${tiles}`], tileSize: 256, maxzoom: 18 },
        lines: { type: "geojson", data: { type: "FeatureCollection", features: lines.filter((l) => l.coords.length > 1).map(feature) } },
        marks: {
          type: "geojson",
          data: {
            type: "FeatureCollection",
            features: (opts.markers ?? []).map((m) => ({ type: "Feature" as const, properties: { color: m.color }, geometry: { type: "Point" as const, coordinates: m.at } })),
          },
        },
      },
      layers: [
        { id: "bg", type: "background", paint: { "background-color": "#ffffff" } },
        { id: "base", type: "raster", source: "base" },
        { id: "casing", type: "line", source: "lines", filter: ["!", ["get", "dashed"]], layout: { "line-cap": "round", "line-join": "round" },
          paint: { "line-color": "#ffffff", "line-width": width + 3, "line-opacity": 0.9 } },
        { id: "gap", type: "line", source: "lines", filter: ["get", "dashed"], paint: { "line-color": ["get", "color"], "line-width": width - 1, "line-dasharray": [2, 2] } },
        { id: "line", type: "line", source: "lines", filter: ["!", ["get", "dashed"]], layout: { "line-cap": "round", "line-join": "round" },
          paint: { "line-color": ["get", "color"], "line-width": width } },
        { id: "marks", type: "circle", source: "marks", paint: { "circle-radius": 6, "circle-color": ["get", "color"], "circle-stroke-color": "#ffffff", "circle-stroke-width": 2 } },
      ],
    },
    bounds: box,
    fitBoundsOptions: { padding: Math.round(Math.min(opts.width, opts.height) * 0.08), maxZoom: 13 },
    interactive: false,
    attributionControl: false,
    fadeDuration: 0,
    pixelRatio: scale,
    canvasContextAttributes: { preserveDrawingBuffer: true },
  });
  try {
    await new Promise<void>((resolve) => {
      // タイルが読めない(オフラインなど)ときも、線だけで描けるように時間で打ち切る
      const timer = setTimeout(resolve, 20_000);
      map.once("idle", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    const src = map.getCanvas();
    const out = document.createElement("canvas");
    out.width = src.width;
    out.height = src.height;
    out.getContext("2d")!.drawImage(src, 0, 0);
    return out;
  } finally {
    map.remove();
    container.remove();
  }
}

// ---- 画像にまとめる ----

const W = 1080;
const PAD = 56;
const FONT = `"Hiragino Sans", "Hiragino Kaku Gothic ProN", "Yu Gothic UI", "Yu Gothic", Meiryo, "Noto Sans JP", "Noto Sans CJK JP", sans-serif`;
const C = { bg: "#ffffff", fg: "#1d1d1f", muted: "#6b6b70", line: "#e3e3e6", chip: "#f0f0f2", accent: "#c2185b" };

/** 文字を幅に収まるように折り返す(日本語は1文字ずつ、英数字はそのまま) */
function wrap(ctx: CanvasRenderingContext2D, text: string, maxW: number): string[] {
  const out: string[] = [];
  let cur = "";
  for (const ch of [...text]) {
    if (ctx.measureText(cur + ch).width > maxW && cur) {
      out.push(cur);
      cur = ch.trim() ? ch : "";
    } else cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

/** 長すぎる1行を「…」で切る */
function fit(ctx: CanvasRenderingContext2D, text: string, maxW: number): string {
  if (ctx.measureText(text).width <= maxW) return text;
  let s = text;
  while (s && ctx.measureText(s + "…").width > maxW) s = [...s].slice(0, -1).join("");
  return s + "…";
}

/**
 * 地図と文字を1枚にまとめる。高さは中身に合わせる。
 * draw を2回(高さを測る・描く)呼ぶ
 */
export function composeCard(mapImage: CanvasImageSource & { width: number; height: number }, info: CardInfo): HTMLCanvasElement {
  const mapH = Math.round((mapImage.height / mapImage.width) * W);
  const draw = (ctx: CanvasRenderingContext2D, paint: boolean): number => {
    const text = (s: string, x: number, y: number, size: number, color = C.fg, weight = 400, align: CanvasTextAlign = "left") => {
      ctx.font = `${weight} ${size}px ${FONT}`;
      ctx.fillStyle = color;
      ctx.textAlign = align;
      ctx.textBaseline = "alphabetic";
      if (paint) ctx.fillText(s, x, y);
    };
    if (paint) {
      ctx.fillStyle = C.bg;
      ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    }
    let y = PAD;
    // 見出し
    ctx.font = `700 52px ${FONT}`;
    const titleLines = wrap(ctx, info.title, W - PAD * 2).slice(0, 2);
    for (const t of titleLines) {
      y += 60;
      text(t, PAD, y, 52, C.fg, 700);
    }
    if (info.subtitle) {
      ctx.font = `400 30px ${FONT}`;
      y += 48;
      text(fit(ctx, info.subtitle, W - PAD * 2), PAD, y, 30, C.muted);
    }
    y += 32;
    // 地図
    if (paint) {
      ctx.drawImage(mapImage, 0, y, W, mapH);
      ctx.font = `400 20px ${FONT}`;
      const credit = "地図: 地理院タイル";
      const cw = ctx.measureText(credit).width;
      ctx.fillStyle = "rgba(255,255,255,0.8)";
      ctx.fillRect(W - cw - 24, y + mapH - 34, cw + 24, 34);
      text(credit, W - 12, y + mapH - 10, 20, C.muted, 400, "right");
    }
    y += mapH + 44;
    // 大きな数字
    if (info.tiles.length) {
      const tw = (W - PAD * 2) / info.tiles.length;
      info.tiles.forEach((t, i) => {
        const x = PAD + tw * i;
        text(t.label, x, y + 28, 26, C.muted);
        ctx.font = `700 60px ${FONT}`;
        const vw = ctx.measureText(t.value).width;
        text(t.value, x, y + 100, 60, C.fg, 700);
        if (t.unit) text(t.unit, x + vw + 8, y + 100, 28, C.muted);
      });
      y += 132;
    }
    // 内訳
    for (const r of info.rows) {
      y += 46;
      let x = PAD;
      if (r.color) {
        if (paint) {
          ctx.fillStyle = r.color;
          ctx.fillRect(x, y - 24, 36, 10);
        }
        x += 52;
      }
      ctx.font = `400 32px ${FONT}`;
      text(fit(ctx, r.text, W - PAD - x), x, y, 32);
    }
    if (info.rows.length) y += 24;
    // 通った道路(名前を札のように並べる)
    for (const sec of info.routes) {
      y += 28;
      if (paint) {
        ctx.fillStyle = C.line;
        ctx.fillRect(PAD, y - 4, W - PAD * 2, 2);
      }
      y += 48;
      text(`${sec.label}`, PAD, y, 32, C.fg, 700);
      ctx.font = `700 32px ${FONT}`;
      text(`${sec.count} 路線`, PAD + ctx.measureText(sec.label).width + 16, y, 28, C.muted);
      y += 20;
      const size = 28;
      const h = 48;
      let x = PAD;
      y += 8;
      ctx.font = `400 ${size}px ${FONT}`;
      const names = [...sec.names, ...(sec.count > sec.names.length ? [`ほか ${sec.count - sec.names.length} 路線`] : [])];
      for (const n of names) {
        const label = fit(ctx, n, W - PAD * 2 - 32);
        const w = ctx.measureText(label).width + 32;
        if (x + w > W - PAD && x > PAD) {
          x = PAD;
          y += h + 10;
        }
        if (paint) {
          ctx.fillStyle = C.chip;
          ctx.beginPath();
          ctx.roundRect(x, y, w, h, h / 2);
          ctx.fill();
        }
        text(label, x + 16, y + 34, size);
        x += w + 10;
      }
      y += h;
    }
    // 下の帯
    y += 44;
    if (paint) {
      ctx.fillStyle = C.accent;
      ctx.fillRect(0, y, W, 6);
    }
    y += 50;
    text(info.footer, PAD, y, 24, C.muted);
    return y + 32;
  };
  const measure = document.createElement("canvas").getContext("2d")!;
  const h = Math.ceil(draw(measure, false));
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = h;
  draw(canvas.getContext("2d")!, true);
  return canvas;
}

// ---- 画像を見せる枠 ----

export interface CardModal {
  /** 作っている途中の様子 */
  status(text: string): void;
  /** できた画像を出す */
  show(canvas: HTMLCanvasElement, fileName: string): void;
  /** 閉じられたか(閉じたら作るのをやめる) */
  readonly closed: boolean;
}

/** 画像を出す枠を開く。保存・共有のボタンつき */
export function openCardModal(): CardModal {
  let closed = false;
  let url: string | null = null;
  const el = document.createElement("div");
  el.className = "card-modal";
  el.innerHTML = `<div class="card-box" role="dialog" aria-label="まとめ画像">
      <div class="card-head"><strong>まとめ画像</strong><span class="spacer"></span><button type="button" class="card-close" aria-label="閉じる">×</button></div>
      <p class="muted card-status">画像を作っています…</p>
      <div class="card-img"></div>
      <div class="card-actions" hidden>
        <a class="button card-save" download>画像を保存</a>
        <button type="button" class="secondary card-share" hidden>共有…</button>
      </div>
      <p class="muted card-hint" hidden>iPhone では画像を長押しして「写真に保存」もできます。</p>
    </div>`;
  const close = () => {
    closed = true;
    if (url) URL.revokeObjectURL(url);
    el.remove();
    document.removeEventListener("keydown", onKey);
  };
  const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
  el.addEventListener("click", (e) => {
    if (e.target === el || (e.target as HTMLElement).closest(".card-close")) close();
  });
  document.addEventListener("keydown", onKey);
  document.body.appendChild(el);
  const q = <T extends HTMLElement>(s: string) => el.querySelector<T>(s)!;
  return {
    get closed() {
      return closed;
    },
    status(text) {
      q(".card-status").textContent = text;
    },
    show(canvas, fileName) {
      canvas.toBlob((blob) => {
        if (!blob || closed) return;
        url = URL.createObjectURL(blob);
        const img = document.createElement("img");
        img.src = url;
        img.alt = "まとめ画像";
        q(".card-img").replaceChildren(img);
        q(".card-status").hidden = true;
        const save = q<HTMLAnchorElement>(".card-save");
        save.href = url;
        save.download = fileName;
        q(".card-actions").hidden = false;
        q(".card-hint").hidden = false;
        const file = new File([blob], fileName, { type: "image/png" });
        const share = q<HTMLButtonElement>(".card-share");
        if (navigator.canShare?.({ files: [file] })) {
          share.hidden = false;
          share.onclick = () => void navigator.share({ files: [file] }).catch(() => undefined);
        }
      }, "image/png");
    },
  };
}

/** ファイル名に使えない文字を除く */
export const cardFileName = (title: string) => `${title.replace(/[\\/:*?"<>|\s]+/g, "_").replace(/^[_🚗🧳]+/u, "") || "まとめ"}.png`;
