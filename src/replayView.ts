// 運転リプレイの画面: 地図の上を走る丸(向きつき)と、時間をそろえた速度・G・躍度のグラフ、G円。
// PC は地図の下に重ね、スマホは一覧の代わりに地図の下に出す(#replay)
import * as maplibregl from "maplibre-gl";
import { frameAt, hasMotion, indexAt, nearestTime, niceMax, type ReplayData, type ReplayFrame } from "./replay";

export interface ReplayEvent {
  /** UNIX ミリ秒 */
  t: number;
  label: string;
}

export interface ReplayOptions {
  map: maplibregl.Map;
  data: ReplayData;
  events: ReplayEvent[];
  /** 閉じたとき(× や Esc) */
  onClose?: () => void;
  /** その時刻(UNIX ミリ秒)の場面を YouTube で開く URL。動画が無ければ undefined */
  videoUrl?: (t: number) => string | undefined;
}

/** 動画を開くときは、押した時刻のこの秒数前から(見逃さないように) */
const VIDEO_LEAD_MS = 3000;

/** 急な操作の目安(運転評価の HARSH_G・HARSH_JERK と同じ) */
const HARSH_G = 0.35;
const HARSH_JERK = 4;
const RATES = [1, 5, 10, 30, 60];
/** 表示幅(秒)。0 は走行全体 */
const WINDOWS: [number, string][] = [
  [0, "全体"],
  [600, "10分"],
  [120, "2分"],
];
const COLORS = { speed: "#8e24aa", lon: "#1e88e5", lat: "#43a047", jerk: "#00897b", event: "#f57c00" };
/** G円に残す軌跡の長さ(ミリ秒) */
const TRAIL_MS = 4000;

interface State {
  opts: ReplayOptions;
  t: number;
  playing: boolean;
  rate: number;
  windowS: number;
  follow: boolean;
  raf?: number;
  last?: number;
  marker: maplibregl.Marker;
  ranges: { speed: number; g: number; jerk: number };
  cleanup: (() => void)[];
}

let st: State | null = null;

export const replayOpen = () => st !== null;

const $ = (id: string) => document.getElementById(id)!;
const pad2 = (n: number) => String(n).padStart(2, "0");
const hms = (t: number) => {
  const d = new Date(t);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
};
const hm = (t: number) => {
  const d = new Date(t);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
};
const sign = (v: number, digits: number) => `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(digits)}`;

/** リプレイを開く(開いていれば閉じてから) */
export function openReplay(opts: ReplayOptions) {
  closeReplay();
  const { data: d, map } = opts;
  const motion = hasMotion(d);
  const box = $("replay");
  box.innerHTML = `
    <div class="rp-head">
      <button type="button" id="rp-play" class="rp-play" aria-label="再生">▶</button>
      <select id="rp-rate" aria-label="再生の速さ">${RATES.map((r) => `<option value="${r}"${r === 10 ? " selected" : ""}>×${r}</option>`).join("")}</select>
      <select id="rp-win" aria-label="グラフの表示幅">${WINDOWS.map(([s, l]) => `<option value="${s}">${l}</option>`).join("")}</select>
      <button type="button" id="rp-follow" class="rp-follow" aria-pressed="true" title="地図が丸についていく">追尾</button>
      ${opts.videoUrl ? `<button type="button" id="rp-video" class="rp-video" title="この場面を YouTube の車載動画で開く" hidden>🎬 動画</button>` : ""}
      <span class="spacer"></span>
      <button type="button" id="rp-close" class="rp-close" aria-label="リプレイを閉じる">×</button>
    </div>
    <div id="rp-readout" class="rp-readout" aria-live="off"></div>
    <div class="rp-body">
      ${motion ? `<canvas id="rp-gcircle" class="rp-gcircle" aria-label="G円(前後と左右の加速度)"></canvas>` : ""}
      <canvas id="rp-chart" class="rp-chart" aria-label="速度・加速度・躍度の推移"></canvas>
    </div>
    ${
      opts.events.length
        ? `<div class="rp-events">${opts.events
            .map((e, i) => `<button type="button" data-rp-event="${i}">${e.label}<span>${hm(e.t)}</span></button>`)
            .join("")}</div>`
        : ""
    }
    ${motion ? "" : `<p class="muted rp-note">このログには加速度の記録がないので、位置と速度だけ再生します。</p>`}`;
  box.hidden = false;
  document.body.classList.add("replaying");

  const el = document.createElement("div");
  el.className = "rp-marker";
  el.innerHTML = `<svg viewBox="0 0 32 32" width="32" height="32" aria-hidden="true"><circle cx="16" cy="16" r="12" fill="${COLORS.speed}" stroke="#fff" stroke-width="3"/><path class="rp-arrow" d="M16 7 L22.5 22 L16 18.5 L9.5 22 Z" fill="#fff"/><circle class="rp-dot" cx="16" cy="16" r="3.5" fill="#fff"/></svg>`;
  // 追尾中は丸が地図の真ん中に来るが、真ん中が 196.5px のように半端だと、整数に丸める既定の置き方では
  // 196 と 197 を行ったり来たりして丸がブルブル震える(iPhone の幅 393px など)。丸めずに置く
  const marker = new maplibregl.Marker({ element: el, rotationAlignment: "map", pitchAlignment: "map", subpixelPositioning: true }).setLngLat([d.lon[0], d.lat[0]]).addTo(map);

  st = {
    opts,
    t: d.t[0],
    playing: false,
    rate: 10,
    windowS: 0,
    follow: true,
    marker,
    ranges: {
      speed: niceMax(d.kmh, 20, 20, 400),
      g: motion ? niceMax([...d.lonG!, ...d.latG!], 0.4, 0.1, 1.2) : 0.4,
      jerk: motion ? niceMax(d.jerk!, 5, 1, 20) : 5,
    },
    cleanup: [],
  };
  bind(st);
  // PC は枠が地図に重なるので、丸が枠に隠れないよう、地図の中心を見えている所の真ん中にずらす
  const oldPadding = map.getPadding();
  st.cleanup.push(() => map.setPadding(oldPadding));
  requestAnimationFrame(() => {
    map.resize();
    if (getComputedStyle(box).position === "absolute") {
      const detail = document.getElementById("detail");
      const right = detail && !detail.hidden && getComputedStyle(detail).position === "absolute" ? detail.offsetWidth + 12 : 0;
      map.setPadding({ top: 0, left: 0, right, bottom: box.offsetHeight + 28 });
    }
    map.jumpTo({ center: [d.lon[0], d.lat[0]], zoom: Math.max(map.getZoom(), 14) });
    render();
  });
}

/** リプレイを閉じる */
export function closeReplay() {
  if (!st) return;
  const s = st;
  st = null;
  if (s.raf) cancelAnimationFrame(s.raf);
  s.marker.remove();
  for (const f of s.cleanup) f();
  const box = $("replay");
  box.hidden = true;
  box.innerHTML = "";
  document.body.classList.remove("replaying");
  requestAnimationFrame(() => s.opts.map.resize());
}

function bind(s: State) {
  const { map, data: d } = s.opts;
  const on = <K extends keyof HTMLElementEventMap>(target: HTMLElement | Document | Window, type: K | string, fn: (e: never) => void) => {
    target.addEventListener(type, fn as EventListener);
    s.cleanup.push(() => target.removeEventListener(type, fn as EventListener));
  };
  on($("rp-play"), "click", () => setPlaying(!s.playing));
  on($("rp-rate"), "change", (e: Event) => (s.rate = Number((e.target as HTMLSelectElement).value)));
  on($("rp-win"), "change", (e: Event) => {
    s.windowS = Number((e.target as HTMLSelectElement).value);
    render();
  });
  on($("rp-follow"), "click", () => setFollow(!s.follow));
  const videoBtn = document.getElementById("rp-video");
  if (videoBtn && s.opts.videoUrl) {
    on(videoBtn, "click", () => {
      const url = s.opts.videoUrl!(Math.max(d.t[0], s.t - VIDEO_LEAD_MS));
      if (!url) return;
      setPlaying(false);
      window.open(url, "_blank", "noopener");
    });
  }
  on($("rp-close"), "click", () => {
    const cb = s.opts.onClose;
    closeReplay();
    cb?.();
  });
  on($("replay"), "click", (e: MouseEvent) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>("[data-rp-event]");
    if (!b) return;
    const ev = s.opts.events[Number(b.dataset.rpEvent)];
    if (!ev) return;
    // 出来事は 5 秒前から等倍で見る
    s.rate = 1;
    ($("rp-rate") as HTMLSelectElement).value = "1";
    seek(ev.t - 5000);
    setFollow(true);
    setPlaying(true);
  });

  // グラフ: 全体表示は押した時刻へ、表示幅を決めているときはなぞった分だけ時刻を送る
  const chart = $("rp-chart") as HTMLCanvasElement;
  let drag: { x: number; t: number; moved: boolean } | null = null;
  on(chart, "pointerdown", (e: PointerEvent) => {
    chart.setPointerCapture(e.pointerId);
    drag = { x: e.clientX, t: s.t, moved: false };
    if (s.windowS === 0) seek(timeAtX(chart, e.clientX));
  });
  on(chart, "pointermove", (e: PointerEvent) => {
    if (!drag) return;
    if (Math.abs(e.clientX - drag.x) > 3) drag.moved = true;
    if (s.windowS === 0) seek(timeAtX(chart, e.clientX));
    else if (drag.moved) seek(drag.t - ((e.clientX - drag.x) / plotWidth(chart)) * s.windowS * 1000);
  });
  on(chart, "pointerup", (e: PointerEvent) => {
    if (drag && !drag.moved && s.windowS !== 0) seek(timeAtX(chart, e.clientX));
    drag = null;
  });
  on(chart, "pointercancel", () => (drag = null));

  // 地図: 線の近くを押すとその時刻へ。手で地図を動かしたら追尾をやめる
  const click = (e: maplibregl.MapMouseEvent) => {
    const t = nearestTime(d, (lon, lat) => map.project([lon, lat]), e.point);
    if (t !== undefined) seek(t);
  };
  const dragstart = (e: { originalEvent?: Event }) => {
    if (e.originalEvent && s.follow) setFollow(false);
  };
  map.on("click", click);
  map.on("dragstart", dragstart);
  s.cleanup.push(() => {
    map.off("click", click);
    map.off("dragstart", dragstart);
  });

  on(document, "keydown", (e: KeyboardEvent) => {
    const t = e.target as HTMLElement;
    if (e.altKey || e.ctrlKey || e.metaKey || t.closest("input, select, textarea, dialog[open]")) return;
    if (e.key === " ") {
      e.preventDefault();
      setPlaying(!s.playing);
    } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      seek(s.t + (e.key === "ArrowLeft" ? -1 : 1) * (e.shiftKey ? 30000 : 5000));
    } else if (e.key === "Escape") {
      const cb = s.opts.onClose;
      closeReplay();
      cb?.();
    }
  });
  const ro = new ResizeObserver(() => render());
  ro.observe($("replay"));
  s.cleanup.push(() => ro.disconnect());
  const scheme = matchMedia("(prefers-color-scheme: dark)");
  const redraw = () => render();
  scheme.addEventListener("change", redraw);
  s.cleanup.push(() => scheme.removeEventListener("change", redraw));
}

function setPlaying(on: boolean) {
  if (!st) return;
  const s = st;
  const d = s.opts.data;
  if (on && s.t >= d.t[d.t.length - 1]) s.t = d.t[0]; // 最後まで見たら最初から
  s.playing = on;
  const b = $("rp-play");
  b.textContent = on ? "⏸" : "▶";
  b.setAttribute("aria-label", on ? "一時停止" : "再生");
  if (on) {
    s.last = undefined;
    s.raf = requestAnimationFrame(tick);
  } else if (s.raf) {
    cancelAnimationFrame(s.raf);
    s.raf = undefined;
  }
}

function setFollow(on: boolean) {
  if (!st) return;
  st.follow = on;
  $("rp-follow").setAttribute("aria-pressed", String(on));
  if (on) render();
}

function seek(t: number) {
  if (!st) return;
  const d = st.opts.data;
  st.t = Math.max(d.t[0], Math.min(d.t[d.t.length - 1], t));
  render();
}

function tick(now: number) {
  if (!st || !st.playing) return;
  const s = st;
  const d = s.opts.data;
  if (s.last !== undefined) s.t += Math.min(now - s.last, 250) * s.rate;
  s.last = now;
  if (s.t >= d.t[d.t.length - 1]) {
    s.t = d.t[d.t.length - 1];
    render();
    setPlaying(false);
    return;
  }
  render();
  s.raf = requestAnimationFrame(tick);
}

/** いまの時刻に合わせて、地図の丸・数字・グラフ・G円を描き直す */
function render() {
  if (!st) return;
  const s = st;
  const f = frameAt(s.opts.data, s.t);
  s.marker.setLngLat([f.lon, f.lat]);
  const arrow = s.marker.getElement().querySelector<SVGElement>(".rp-arrow");
  const dot = s.marker.getElement().querySelector<SVGElement>(".rp-dot");
  // 止まっていて向きが分からないときは、矢印の代わりに点を出す
  if (arrow) arrow.style.display = f.bearing === undefined ? "none" : "";
  if (dot) dot.style.display = f.bearing === undefined ? "" : "none";
  if (f.bearing !== undefined) s.marker.setRotation(f.bearing);
  if (s.follow) s.opts.map.setCenter([f.lon, f.lat]);
  readout(f);
  const videoBtn = document.getElementById("rp-video");
  if (videoBtn) videoBtn.hidden = !s.opts.videoUrl?.(s.t);
  drawChart(s, f);
  drawGCircle(s);
}

function readout(f: ReplayFrame) {
  const parts = [`<b>${hms(f.t)}</b>`, `<span style="color:${COLORS.speed}">${f.kmh.toFixed(0)} km/h</span>`];
  if (f.lonG !== undefined) parts.push(`<span style="color:${COLORS.lon}">前後 ${sign(f.lonG, 2)}G</span>`);
  if (f.latG !== undefined) parts.push(`<span style="color:${COLORS.lat}">横 ${sign(f.latG, 2)}G</span>`);
  if (f.jerk !== undefined) parts.push(`<span style="color:${COLORS.jerk}">躍度 ${f.jerk.toFixed(1)}</span>`);
  $("rp-readout").innerHTML = parts.join("");
}

/** グラフの左の目盛りの幅 */
const AXIS_W = 34;
const plotWidth = (c: HTMLCanvasElement) => Math.max(1, c.clientWidth - AXIS_W - 6);

/** グラフに出す時刻の範囲 */
function viewRange(s: State): [number, number] {
  const d = s.opts.data;
  const a = d.t[0], b = d.t[d.t.length - 1];
  if (s.windowS === 0 || (b - a) / 1000 <= s.windowS) return [a, b];
  const w = s.windowS * 1000;
  const lo = Math.max(a, Math.min(b - w, s.t - w / 2));
  return [lo, lo + w];
}

function timeAtX(c: HTMLCanvasElement, clientX: number): number {
  if (!st) return 0;
  const [a, b] = viewRange(st);
  const x = clientX - c.getBoundingClientRect().left - AXIS_W;
  return a + (Math.max(0, Math.min(plotWidth(c), x)) / plotWidth(c)) * (b - a);
}

/** キャンバスを表示の大きさ×画面の倍率にして、CSS ピクセルで描けるようにする */
function setup(c: HTMLCanvasElement): CanvasRenderingContext2D | null {
  const w = c.clientWidth, h = c.clientHeight;
  if (!w || !h) return null;
  const r = window.devicePixelRatio || 1;
  if (c.width !== Math.round(w * r) || c.height !== Math.round(h * r)) {
    c.width = Math.round(w * r);
    c.height = Math.round(h * r);
  }
  const g = c.getContext("2d");
  if (!g) return null;
  g.setTransform(r, 0, 0, r, 0, 0);
  g.clearRect(0, 0, w, h);
  return g;
}

const cssVar = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

interface Panel {
  label: string;
  lo: number;
  hi: number;
  series: { ys: number[]; color: string; abs?: boolean }[];
  guides: number[];
  ticks: number[];
  value: string;
}

function drawChart(s: State, f: ReplayFrame) {
  const c = document.getElementById("rp-chart") as HTMLCanvasElement | null;
  const g = c && setup(c);
  if (!c || !g) return;
  const d = s.opts.data;
  const W = c.clientWidth, H = c.clientHeight;
  const fg = cssVar("--fg"), muted = cssVar("--muted"), line = cssVar("--line");
  const panels: Panel[] = [
    {
      label: "速度 km/h",
      lo: 0,
      hi: s.ranges.speed,
      series: [{ ys: d.kmh, color: COLORS.speed }],
      guides: [],
      ticks: [0, s.ranges.speed / 2, s.ranges.speed],
      value: `${f.kmh.toFixed(0)}`,
    },
  ];
  if (hasMotion(d)) {
    const r = s.ranges.g;
    panels.push(
      {
        label: "前後G・横G",
        lo: -r,
        hi: r,
        series: [
          { ys: d.latG, color: COLORS.lat },
          { ys: d.lonG, color: COLORS.lon },
        ],
        guides: [HARSH_G, -HARSH_G],
        ticks: [-r, 0, r],
        value: `前後 ${sign(f.lonG!, 2)} / 横 ${sign(f.latG!, 2)}`,
      },
      {
        label: "躍度 m/s³",
        lo: 0,
        hi: s.ranges.jerk,
        series: [{ ys: d.jerk, color: COLORS.jerk }],
        guides: [HARSH_JERK],
        ticks: [0, s.ranges.jerk / 2, s.ranges.jerk],
        value: f.jerk!.toFixed(1),
      },
    );
  }
  const [ta, tb] = viewRange(s);
  const pw = plotWidth(c);
  const X = (t: number) => AXIS_W + ((t - ta) / (tb - ta)) * pw;
  const axisH = 14;
  const gap = 6;
  const ph = (H - axisH - gap * (panels.length - 1)) / panels.length;
  const i0 = Math.max(0, indexAt(d.t, ta) - 1), i1 = Math.min(d.t.length - 1, indexAt(d.t, tb) + 1);
  g.font = "10px system-ui, sans-serif";
  g.textBaseline = "middle";

  panels.forEach((p, k) => {
    const top = k * (ph + gap);
    const Y = (v: number) => top + ph - ((Math.max(p.lo, Math.min(p.hi, v)) - p.lo) / (p.hi - p.lo)) * ph;
    // 枠と目盛り
    g.strokeStyle = line;
    g.lineWidth = 1;
    g.fillStyle = muted;
    g.textAlign = "right";
    for (const v of p.ticks) {
      const y = Y(v);
      g.beginPath();
      g.moveTo(AXIS_W, Math.round(y) + 0.5);
      g.lineTo(AXIS_W + pw, Math.round(y) + 0.5);
      g.stroke();
      g.fillText(fmtTick(v), AXIS_W - 4, Math.min(top + ph - 5, Math.max(top + 5, y)));
    }
    // 目安の線(急な操作)
    g.setLineDash([4, 3]);
    g.strokeStyle = COLORS.event;
    g.globalAlpha = 0.7;
    for (const v of p.guides) {
      g.beginPath();
      g.moveTo(AXIS_W, Y(v));
      g.lineTo(AXIS_W + pw, Y(v));
      g.stroke();
    }
    g.setLineDash([]);
    // 出来事の時刻
    g.globalAlpha = 0.35;
    g.lineWidth = 2;
    for (const e of s.opts.events) {
      if (e.t < ta || e.t > tb) continue;
      g.beginPath();
      g.moveTo(X(e.t), top);
      g.lineTo(X(e.t), top + ph);
      g.stroke();
    }
    g.globalAlpha = 1;
    // 値の線(1 ピクセルの幅に入る点は最小と最大だけ結ぶ)
    g.save();
    g.beginPath();
    g.rect(AXIS_W, top, pw, ph);
    g.clip();
    for (const sr of p.series) drawSeries(g, d.t, sr.ys, i0, i1, X, Y, sr.color);
    g.restore();
    // 見出しと、いまの値
    g.textAlign = "left";
    g.fillStyle = muted;
    g.fillText(p.label, AXIS_W + 4, top + 7);
    const lw = g.measureText(p.label).width;
    g.fillStyle = fg;
    g.font = "bold 10px system-ui, sans-serif";
    g.fillText(p.value, AXIS_W + 10 + lw, top + 7);
    g.font = "10px system-ui, sans-serif";
  });

  // 時刻の目盛り
  g.fillStyle = muted;
  g.textAlign = "center";
  const span = tb - ta;
  const steps = [10e3, 30e3, 60e3, 120e3, 300e3, 600e3, 900e3, 1800e3, 3600e3, 7200e3];
  const step = steps.find((x) => span / x <= Math.max(2, pw / 70)) ?? 7200e3;
  const tz = new Date(ta).getTimezoneOffset() * 60e3;
  for (let t = Math.ceil((ta - tz) / step) * step + tz; t <= tb; t += step) {
    const x = X(t);
    g.fillText(step < 60e3 ? hms(t) : hm(t), Math.max(AXIS_W + 14, Math.min(W - 16, x)), H - axisH / 2);
  }
  // いまの時刻の縦線
  const cx = X(s.t);
  g.strokeStyle = fg;
  g.lineWidth = 1.5;
  g.beginPath();
  g.moveTo(cx, 0);
  g.lineTo(cx, H - axisH);
  g.stroke();
}

const fmtTick = (v: number) => (Math.abs(v) < 1 && v !== 0 ? v.toFixed(1) : v.toFixed(0)).replace(/^-/, "−");

function drawSeries(
  g: CanvasRenderingContext2D,
  ts: number[],
  ys: number[],
  i0: number,
  i1: number,
  X: (t: number) => number,
  Y: (v: number) => number,
  color: string,
) {
  g.strokeStyle = color;
  g.lineWidth = 1.4;
  g.lineJoin = "round";
  g.beginPath();
  let col = NaN, mn = 0, mx = 0, first = true;
  const flush = () => {
    if (Number.isNaN(col)) return;
    if (first) {
      g.moveTo(col, Y(mn));
      first = false;
    } else g.lineTo(col, Y(mn));
    if (mx !== mn) g.lineTo(col, Y(mx));
  };
  for (let i = i0; i <= i1; i++) {
    const x = Math.round(X(ts[i]));
    const v = ys[i];
    if (x !== col) {
      flush();
      col = x;
      mn = mx = v;
    } else {
      mn = Math.min(mn, v);
      mx = Math.max(mx, v);
    }
  }
  flush();
  g.stroke();
}

/** G円: ボウルに乗った球のように、加速すると下・減速すると上・左に曲がると右へ球が動く。直近の数秒を尾で出す */
function drawGCircle(s: State) {
  const c = document.getElementById("rp-gcircle") as HTMLCanvasElement | null;
  const g = c && setup(c);
  const d = s.opts.data;
  if (!c || !g || !hasMotion(d)) return;
  const W = c.clientWidth, H = c.clientHeight;
  const cx = W / 2, cy = H / 2, R = Math.min(W, H) / 2 - 12;
  const max = Math.max(0.5, s.ranges.g);
  const muted = cssVar("--muted"), line = cssVar("--line"), fg = cssVar("--fg");
  g.strokeStyle = line;
  g.lineWidth = 1;
  for (let v = 0.1; v <= max + 1e-9; v += 0.1) {
    g.beginPath();
    g.arc(cx, cy, (v / max) * R, 0, Math.PI * 2);
    g.stroke();
  }
  g.beginPath();
  g.moveTo(cx - R, cy);
  g.lineTo(cx + R, cy);
  g.moveTo(cx, cy - R);
  g.lineTo(cx, cy + R);
  g.stroke();
  g.setLineDash([4, 3]);
  g.strokeStyle = COLORS.event;
  g.beginPath();
  g.arc(cx, cy, (HARSH_G / max) * R, 0, Math.PI * 2);
  g.stroke();
  g.setLineDash([]);
  g.fillStyle = muted;
  g.font = "9px system-ui, sans-serif";
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText("減速", cx, 6);
  g.fillText("加速", cx, H - 6);
  // 球は G と逆向き(体が押される向き)に動く: 加速(lonG が +)で下、左に曲がる(latG が +)と右
  const P = (lonG: number, latG: number): [number, number] => {
    const k = R / max;
    let x = latG * k, y = lonG * k;
    const r = Math.hypot(x, y);
    if (r > R) {
      x *= R / r;
      y *= R / r;
    }
    return [cx + x, cy + y];
  };
  const a = indexAt(d.t, s.t - TRAIL_MS), b = indexAt(d.t, s.t);
  for (let i = a + 1; i <= b; i++) {
    const age = (s.t - d.t[i]) / TRAIL_MS;
    g.strokeStyle = `rgba(30, 136, 229, ${Math.max(0, 0.8 * (1 - age))})`;
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(...P(d.lonG[i - 1], d.latG[i - 1]));
    g.lineTo(...P(d.lonG[i], d.latG[i]));
    g.stroke();
  }
  const f = frameAt(d, s.t);
  const [px, py] = P(f.lonG!, f.latG!);
  const over = Math.max(Math.abs(f.lonG!), Math.abs(f.latG!)) > HARSH_G;
  g.fillStyle = over ? COLORS.event : COLORS.lon;
  g.strokeStyle = fg === "" ? "#fff" : cssVar("--bg");
  g.lineWidth = 2;
  g.beginPath();
  g.arc(px, py, 6, 0, Math.PI * 2);
  g.fill();
  g.stroke();
}
