// 「ログ」タブ: 保存してある走行ログの一覧と、選んだログの詳細(時間・速度・運転評価・通った道路)。
// HTML の文字列を作るだけで、イベントは main.ts で扱う
import { distance } from "./geo";
import { driveEvalView, esc, km, num, sortLogs } from "./gameView";
import type { DriveEval, SavedLog } from "./store";
import { trackLength } from "./trips";
import { DATASET_LABELS, type Coverage, type DatasetKind, type RouteData, type TrackPoint } from "./types";

/** 速度はこの秒数ぶん離れた点どうしで求める(GPS の細かい揺れで速く見えないように) */
const SPEED_WINDOW_S = 5;
/** これより遅い間は止まっているとみなす(走行時間・平均速度に入れない) */
const MOVING_KMH = 5;
/** 時速これを超える値は GPS の飛びとして捨てる */
const MAX_KMH = 200;

export interface SpeedPoint {
  /** UNIX ミリ秒 */
  t: number;
  kmh: number;
}

export interface TripStats {
  start?: number;
  end?: number;
  /** 最初の点から最後の点まで(ミリ秒) */
  totalMs?: number;
  /** 走っていた時間(ミリ秒) */
  movingMs?: number;
  m: number;
  avgKmh?: number;
  maxKmh?: number;
  speeds: SpeedPoint[];
}

/** ログの時間・距離・速度。時刻のないログは距離だけ */
export function tripStats(track: TrackPoint[]): TripStats {
  const m = trackLength(track);
  const timed = track.filter((p): p is TrackPoint & { time: number } => p.time !== undefined);
  if (timed.length < 2) return { m, speeds: [] };
  const speeds: SpeedPoint[] = [];
  let j = 0;
  for (let i = 0; i < timed.length; i++) {
    while (j < i && timed[i].time - timed[j].time > SPEED_WINDOW_S * 1000) j++;
    const a = timed[j > 0 ? j - 1 : 0];
    const b = timed[i];
    const dt = (b.time - a.time) / 3_600_000;
    if (dt <= 0) continue;
    const kmh = distance([a.lon, a.lat], [b.lon, b.lat]) / 1000 / dt;
    if (kmh <= MAX_KMH) speeds.push({ t: b.time, kmh });
  }
  let movingMs = 0;
  for (let i = 1; i < speeds.length; i++) {
    const dt = speeds[i].t - speeds[i - 1].t;
    // 記録が途切れた間(トンネルなど)は、前後どちらかが走っていれば走っていたことにする
    if (speeds[i].kmh > MOVING_KMH || speeds[i - 1].kmh > MOVING_KMH) movingMs += dt;
  }
  const start = timed[0].time;
  const end = timed[timed.length - 1].time;
  return {
    start,
    end,
    totalMs: end - start,
    movingMs,
    m,
    avgKmh: movingMs > 0 ? m / 1000 / (movingMs / 3_600_000) : undefined,
    maxKmh: speeds.length ? Math.max(...speeds.map((s) => s.kmh)) : undefined,
    speeds,
  };
}

/** そのログで通った路線と距離(m)。距離は区間の長さ × 通った割合 */
export interface PassedRoute {
  kind: DatasetKind;
  ref: string;
  name: string;
  m: number;
}

/** datasets: 調べる道路データ(都道府県道は都道府県ごとのファイルを並べる) */
export function passedRoutes(
  coverage: Coverage,
  datasets: [DatasetKind, RouteData][],
  name: (kind: DatasetKind, ref: string, d: RouteData) => string,
): PassedRoute[] {
  const out: PassedRoute[] = [];
  for (const [kind, d] of datasets) {
    const byRef = new Map<string, number>();
    for (const s of d.segments) {
      const r = coverage.get(s.id);
      if (!r) continue;
      for (const ref of s.routes) byRef.set(ref, (byRef.get(ref) ?? 0) + s.len * r);
    }
    for (const [ref, m] of byRef) if (m >= 100) out.push({ kind, ref, name: name(kind, ref, d), m });
  }
  return out.sort((a, b) => b.m - a.m);
}

const pad = (n: number) => String(n).padStart(2, "0");
const hm = (t: number) => {
  const d = new Date(t);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const duration = (ms: number) => {
  const min = Math.round(ms / 60_000);
  return min >= 60 ? `${Math.floor(min / 60)}時間${pad(min % 60)}分` : `${min}分`;
};

const W = 360;
const H = 140;
const PAD = { l: 36, r: 8, t: 8, b: 20 };

/** 速度のグラフ。出来事(急ブレーキなど)の時刻に印を付ける */
export function speedChart(speeds: SpeedPoint[], events: { t: number; label: string }[] = []): string {
  if (speeds.length < 2) return "";
  const t0 = speeds[0].t;
  const t1 = speeds[speeds.length - 1].t;
  if (t1 <= t0) return "";
  // 点が多いと重いので、横幅の2倍くらいまで間引く(区切りごとの最大をとって、速いところを潰さない)
  const n = W * 2;
  const bins: number[] = new Array(n).fill(-1);
  for (const s of speeds) {
    const i = Math.min(n - 1, Math.floor(((s.t - t0) / (t1 - t0)) * n));
    bins[i] = Math.max(bins[i], s.kmh);
  }
  const max = Math.max(60, Math.ceil(Math.max(...bins) / 20) * 20);
  const plotW = W - PAD.l - PAD.r;
  const plotH = H - PAD.t - PAD.b;
  const x = (t: number) => PAD.l + ((t - t0) / (t1 - t0)) * plotW;
  const y = (v: number) => PAD.t + plotH * (1 - v / max);
  let d = "";
  let pen = false;
  bins.forEach((v, i) => {
    if (v < 0) return;
    const px = PAD.l + ((i + 0.5) / n) * plotW;
    d += `${pen ? "L" : "M"}${px.toFixed(1)},${y(v).toFixed(1)}`;
    pen = true;
  });
  const grid = [];
  for (let v = 0; v <= max; v += max > 100 ? 40 : 20) {
    grid.push(`<line class="grid" x1="${PAD.l}" x2="${W - PAD.r}" y1="${y(v)}" y2="${y(v)}"/>
      <text class="tick" x="${PAD.l - 4}" y="${y(v) + 4}" text-anchor="end">${v}</text>`);
  }
  const marks = events
    .filter((e) => e.t >= t0 && e.t <= t1)
    .map(
      (e) => `<g class="hit"><line class="event-mark" x1="${x(e.t)}" x2="${x(e.t)}" y1="${PAD.t}" y2="${H - PAD.b}"/>
        <title>${hm(e.t)} ${esc(e.label)}</title></g>`,
    )
    .join("");
  return `<svg viewBox="0 0 ${W} ${H}" class="chart" role="img" aria-label="速度の変化">${grid.join("")}
    <path class="line" d="${d}"/>${marks}
    <text class="tick" x="${PAD.l}" y="${H - 5}">${hm(t0)}</text>
    <text class="tick" x="${W - PAD.r}" y="${H - 5}" text-anchor="end">${hm(t1)}</text></svg>`;
}

/** 選んだログの詳細。読み込み中の部分は undefined */
export interface LogDetail {
  log: SavedLog;
  stats?: TripStats;
  /** 読めなかったときの理由 */
  error?: string;
  ev?: DriveEval | null;
  /** 通った路線。調べている間は undefined、道路データがなければ null */
  routes?: PassedRoute[] | null;
}

/** ログが何年のものか(日付のないものは "") */
const yearOf = (l: SavedLog) => l.date?.slice(0, 4) ?? "";

export function logYears(logs: SavedLog[]): string[] {
  return [...new Set(logs.map(yearOf))].sort((a, b) => (a === "" ? 1 : b === "" ? -1 : b.localeCompare(a)));
}

/** ログタブの一覧 */
export function logListPanel(logs: SavedLog[] | null, year: string, shared: boolean): string {
  if (logs === null) return `<p class="muted">読み込み中…</p>`;
  if (!shared) {
    return `<p class="muted">ログを残せるのは、MiniPC のサーバーで開いたときだけです(このブラウザだけで使っているときは、読み込んだログを保存しません)。</p>`;
  }
  if (logs.length === 0) return `<p class="muted">保存してあるログはまだありません。読み込んだログや、iPhone のロガーから送られたログがここに並びます。</p>`;
  const years = logYears(logs);
  const shown = sortLogs(logs).filter((l) => year === "all" || yearOf(l) === year);
  const total = shown.reduce((s, l) => s + (l.m ?? 0), 0);
  const scored = shown.filter((l) => l.score !== undefined);
  const avg = scored.length ? scored.reduce((s, l) => s + l.score!, 0) / scored.length : undefined;
  return `<label class="pref-select">年
      <select id="log-year"><option value="all"${year === "all" ? " selected" : ""}>すべて</option>${years
        .map((y) => `<option value="${y}"${y === year ? " selected" : ""}>${y === "" ? "日付なし" : `${y}年`}</option>`)
        .join("")}</select></label>
    <p class="muted">${shown.length} 本・${km(total, 0)} km${avg !== undefined ? `・運転の平均 ${num(avg, 0)} 点(${scored.length} 本)` : ""}</p>
    <ol class="log-list">${shown
      .map(
        (l) => `<li><a href="#" data-log-open="${esc(l.id)}">
          <span class="muted">${l.date ?? "日付なし"}</span>
          <span class="log-name">${esc(l.name)}</span>
          <span class="muted">${l.m !== undefined ? `${km(l.m)} km` : ""}</span>
          ${l.score !== undefined ? `<span class="eval-badge ${grade(l.score)}">${Math.round(l.score)} 点</span>` : ""}</a></li>`,
      )
      .join("")}</ol>`;
}

const grade = (score: number) => (score >= 80 ? "good" : score >= 50 ? "fair" : "poor");

/** 選んだログの詳細 */
export function logDetailPanel(d: LogDetail): string {
  const s = d.stats;
  const head = `<button type="button" id="log-back" class="link">← 一覧に戻る</button>
    <h2 class="log-title">${esc(d.log.name)}</h2>`;
  if (d.error) return `${head}<p class="muted">読み込めませんでした: ${esc(d.error)}</p>`;
  if (!s) return `${head}<p class="muted">読み込み中…</p>`;
  const facts: [string, string][] = [];
  facts.push(["日付", d.log.date ?? "日付なし"]);
  if (s.start !== undefined && s.end !== undefined) facts.push(["時刻", `${hm(s.start)}〜${hm(s.end)}`]);
  facts.push(["距離", `${km(s.m)} km`]);
  if (s.totalMs !== undefined) facts.push(["かかった時間", duration(s.totalMs)]);
  if (s.movingMs !== undefined) facts.push(["走っていた時間", duration(s.movingMs)]);
  if (s.avgKmh !== undefined) facts.push(["平均速度", `${num(s.avgKmh, 0)} km/h`]);
  if (s.maxKmh !== undefined) facts.push(["最高速度", `${num(s.maxKmh, 0)} km/h`]);
  const events = d.ev?.events.map((e) => ({ t: e.t_unix * 1000, label: e.kind })) ?? [];
  const chart = speedChart(s.speeds, events);
  const evalPart =
    d.log.score === undefined
      ? ""
      : `<h3>運転評価</h3>${driveEvalView({ id: d.log.id, ev: d.ev })}`;
  const routes =
    d.routes === undefined
      ? `<p class="muted">通った道路を調べています…</p>`
      : d.routes === null
        ? `<p class="muted">道路データを読み込んでから調べます。</p>`
        : d.routes.length === 0
          ? `<p class="muted">国道・高速道路・都道府県道は通っていません。</p>`
          : (["kokudo", "expressway", "prefroad"] as DatasetKind[])
              .map((kind) => {
                const list = d.routes!.filter((r) => r.kind === kind);
                if (!list.length) return "";
                return `<h4>${DATASET_LABELS[kind]} <span class="muted">${list.length} 路線</span></h4>
                  <ul class="passed">${list
                    .map(
                      (r) => `<li>${
                        // 都道府県道は、表示している都道府県が違うと地図に出せないので、名前だけにする
                        kind === "prefroad" ? esc(r.name) : `<a href="#" data-route="${esc(r.ref)}" data-kind="${kind}">${esc(r.name)}</a>`
                      }
                        <span class="muted">${km(r.m)} km</span></li>`,
                    )
                    .join("")}</ul>`;
              })
              .join("");
  return `${head}
    <dl class="facts">${facts.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("")}</dl>
    ${chart ? `<h3>速度 <span class="muted">(km/h${events.length ? "・縦線は出来事" : ""})</span></h3>${chart}` : ""}
    ${evalPart}
    <h3>通った道路</h3>${routes}`;
}
