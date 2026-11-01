// ゲーム要素(レベル・実績・振り返り・チャレンジ)の画面。HTML の文字列を作るだけで、イベントは main.ts で扱う
import {
  CONQUER_RATIO,
  almostConquered,
  cumulative,
  fillMonths,
  monthly,
  nearbyUntouched,
  regionProgress,
  timeline,
  tripTotals,
  yearly,
  type AchievementState,
  type DatasetSummary,
  type Level,
  type Suggestion,
} from "./game";
import { prefName } from "./prefs";
import type { Trip } from "./trips";
import type { Progress } from "./stats";
import type { Coverage, DatasetKind, RouteData } from "./types";

const km = (m: number, digits = 1) => (m / 1000).toLocaleString("ja-JP", { maximumFractionDigits: digits });
const num = (n: number, digits = 0) => n.toLocaleString("ja-JP", { maximumFractionDigits: digits });
export const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

export function levelCard(lv: Level, unlocked: number, total: number, regionTitle?: string): string {
  const pct = ((lv.xp - lv.from) / (lv.to - lv.from)) * 100;
  return `<div class="level-head"><span class="level-num">Lv.${lv.level}</span><span class="level-title">${lv.title}</span>
      ${regionTitle ? `<span class="region-title" title="いちばん制覇率の高い地方の称号">${regionTitle}</span>` : ""}</div>
    <div class="bar" title="${lv.parts.map((p) => `${p.label}: ${num(p.xp)}`).join("\n")}"><span style="width:${pct}%"></span></div>
    <p class="muted">経験値 ${num(lv.xp)}(次のレベルまで ${num(lv.to - lv.xp)})</p>
    <div class="game-buttons">
      <button type="button" data-game="achievements">🏅 実績 ${unlocked}/${total}</button>
      <button type="button" data-game="suggest">🧭 おすすめ</button>
      <button type="button" data-game="review">📊 振り返り</button>
      <button type="button" data-game="prefs">🗾 都道府県</button>
    </div>`;
}

// ---------------------------------------------------------------- 実績

export function achievementsView(states: AchievementState[], lv: Level): string {
  const groups = new Map<string, AchievementState[]>();
  // 段階のある実績は、達成したものと次の1つだけ出す(先の目標まで並ぶと長くなるので)
  const nextShown = new Set<string>();
  const hidden = states.filter((s) => {
    if (s.unlocked || !s.a.series) return false;
    if (nextShown.has(s.a.series)) return true;
    nextShown.add(s.a.series);
    return false;
  });
  for (const s of states) {
    if (hidden.includes(s)) continue;
    let g = groups.get(s.a.group);
    if (!g) groups.set(s.a.group, (g = []));
    g.push(s);
  }
  const unlocked = states.filter((s) => s.unlocked).length;
  return `<p class="muted">解除 ${unlocked} / ${states.length}。解除するたびに経験値 +50。段階のある実績は次の目標だけ出しています(ほか ${hidden.length} 個)</p>
    ${[...groups]
      .map(
        ([name, list]) => `<h3>${name}</h3><ul class="badges">${list
          .map((s) => {
            const pct = Math.min(100, (s.cur / s.target) * 100);
            const progress = s.unlocked
              ? "達成!"
              : s.target === 1
                ? "未達成"
                : `${num(Math.min(s.cur, s.target), s.a.unit === "km" || s.a.unit === "%" ? 1 : 0)} / ${num(s.target, 1)} ${s.a.unit ?? ""}`;
            return `<li class="badge${s.unlocked ? " unlocked" : ""}">
              <span class="badge-icon">${s.a.icon}</span>
              <span class="badge-body"><b>${s.a.name}</b><span class="muted">${s.a.desc}</span>
                ${s.unlocked || s.target === 1 ? "" : `<span class="bar"><span style="width:${pct}%"></span></span>`}
                <span class="muted">${progress}</span></span></li>`;
          })
          .join("")}</ul>`,
      )
      .join("")}
    <h3>レベルと称号</h3>
    <table class="table"><tbody>${lv.parts.map((p) => `<tr><td>${p.label}</td><td>${num(p.xp)}</td></tr>`).join("")}
      <tr><th>合計</th><th>${num(lv.xp)}</th></tr></tbody></table>
    <p class="muted">国道 1km = 1、高速道路 1km = 0.5、国道の制覇 1本 = 30、高速道路の制覇 1路線 = 15、実績 1つ = 50。
      制覇は走行率 ${CONQUER_RATIO * 100}% 以上です。</p>`;
}

// ---------------------------------------------------------------- おすすめ

function suggestionList(items: Suggestion[], name: (ref: string) => string, kind: DatasetKind, note: (s: Suggestion) => string) {
  if (items.length === 0) return `<p class="muted">該当なし</p>`;
  return `<ul class="suggest">${items
    .map(
      (s) => `<li><a href="#" data-route="${esc(s.ref)}" data-kind="${kind}">${esc(name(s.ref))}</a>
        <span class="muted">${note(s)}</span></li>`,
    )
    .join("")}</ul>`;
}

export function suggestionsView(
  active: { kind: DatasetKind; data: RouteData; summary: DatasetSummary; coverage: Coverage },
  name: (ref: string) => string,
): string {
  const label = active.kind === "kokudo" ? "国道" : "高速道路";
  return `<h3>あと少しで制覇できる${label}</h3>
    ${suggestionList(almostConquered(active.summary), name, active.kind, (s) => `あと ${km(s.total * CONQUER_RATIO - s.done)} km(${num((s.done / s.total) * 100)}%)`)}
    <h3>よく走るあたりから近い、未踏の${label}</h3>
    ${suggestionList(nearbyUntouched(active.data, active.summary, active.coverage), name, active.kind, (s) => `約 ${km(s.distance!, 0)} km 先・全長 ${km(s.total)} km`)}
    <p class="muted">名前を押すと地図で表示します。今開いているタブ(${label})から選んでいます。</p>`;
}

// ---------------------------------------------------------------- 振り返り

const W = 560;
const H = 160;
const PAD = { l: 44, r: 8, t: 10, b: 22 };

/** 目盛りにちょうどよい刻み */
function niceStep(max: number, ticks = 4) {
  const raw = max / ticks;
  const p = 10 ** Math.floor(Math.log10(raw || 1));
  return [1, 2, 5, 10].map((k) => k * p).find((s) => s >= raw) ?? raw;
}

function axisY(max: number, fmt: (v: number) => string) {
  const step = niceStep(max);
  const top = Math.max(step, Math.ceil(max / step) * step);
  const lines: string[] = [];
  for (let v = 0; v <= top + 1e-9; v += step) {
    const y = PAD.t + (H - PAD.t - PAD.b) * (1 - v / top);
    lines.push(`<line class="grid" x1="${PAD.l}" x2="${W - PAD.r}" y1="${y}" y2="${y}"/>
      <text class="tick" x="${PAD.l - 6}" y="${y + 4}" text-anchor="end">${fmt(v)}</text>`);
  }
  return { top, svg: lines.join("") };
}

function monthlyChart(rows: [string, number][], label: string): string {
  const shown = rows.slice(-24);
  const max = Math.max(...shown.map(([, m]) => m / 1000), 1);
  const { top, svg } = axisY(max, (v) => num(v));
  const plotW = W - PAD.l - PAD.r;
  const bw = plotW / shown.length;
  const plotH = H - PAD.t - PAD.b;
  const bars = shown
    .map(([ym, m], i) => {
      const h = ((m / 1000) / top) * plotH;
      const x = PAD.l + i * bw + 1;
      const w = Math.max(1, bw - 2);
      const month = Number(ym.slice(5));
      // 年が分かるよう、最初の月と1月には年もつける
      const label = i === 0 || month === 1 ? `${ym.slice(2, 4)}年${month}月` : shown.length <= 12 ? `${month}月` : "";
      return `<g class="hit"><rect class="hitbox" x="${x - 1}" y="${PAD.t}" width="${bw}" height="${plotH}"/>
        <path class="mark" d="${barPath(x, PAD.t + plotH, w, h)}"/>
        <title>${ym.replace("-", "年")}月: ${km(m)} km</title>
        ${label ? `<text class="tick" x="${x + w / 2}" y="${H - 6}" text-anchor="middle">${label}</text>` : ""}</g>`;
    })
    .join("");
  return `<svg viewBox="0 0 ${W} ${H}" class="chart" role="img" aria-label="${label}">${svg}${bars}</svg>`;
}

/** 上の角だけ丸めた棒 */
function barPath(x: number, base: number, w: number, h: number) {
  if (h <= 0) return "";
  const r = Math.min(4, w / 2, h);
  const y = base - h;
  return `M${x},${base}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${base}Z`;
}

function progressChart(points: [string, number][], start: number, total: number): string {
  if (points.length === 0) return "";
  const t0 = Date.parse(points[0][0]);
  const t1 = Math.max(Date.parse(points[points.length - 1][0]), t0 + 86400000);
  const pct = (m: number) => (m / total) * 100;
  const max = Math.max(pct(points[points.length - 1][1]), 0.1);
  const { top, svg } = axisY(max, (v) => `${num(v, 1)}%`);
  const plotW = W - PAD.l - PAD.r;
  const plotH = H - PAD.t - PAD.b;
  const x = (d: string) => PAD.l + ((Date.parse(d) - t0) / (t1 - t0)) * plotW;
  const y = (m: number) => PAD.t + plotH * (1 - pct(m) / top);
  // 階段状に(その日まで横ばい、その日に増える)
  let d = `M${x(points[0][0])},${y(start)}`;
  for (const [day, m] of points) d += `H${x(day)}V${y(m)}`;
  const dots = points
    .map(
      ([day, m]) => `<g class="hit"><circle class="hitbox" cx="${x(day)}" cy="${y(m)}" r="8"/>
        <circle class="dot" cx="${x(day)}" cy="${y(m)}" r="3"/><title>${day}: ${num(pct(m), 2)}%(${km(m)} km)</title></g>`,
    )
    .join("");
  const first = points[0][0];
  const last = points[points.length - 1][0];
  return `<svg viewBox="0 0 ${W} ${H}" class="chart" role="img" aria-label="制覇率の推移">${svg}
    <path class="line" d="${d}"/>${dots}
    <text class="tick" x="${PAD.l}" y="${H - 6}">${first}</text>
    <text class="tick" x="${W - PAD.r}" y="${H - 6}" text-anchor="end">${last}</text></svg>`;
}

export function reviewView(
  s: DatasetSummary,
  trips: Map<string, Trip>,
  today: string,
  name: (ref: string) => string,
  kind: DatasetKind,
): string {
  const label = kind === "kokudo" ? "国道" : "高速道路";
  const years = yearly(s);
  const t = tripTotals(trips);
  const firstTrip = [...t.byMonth.keys()].sort()[0];
  const { start, points } = cumulative(s);
  // 2つの棒グラフの月をそろえる
  const firstNew = monthly(s, today)[0]?.[0];
  const from = [firstTrip, firstNew].filter(Boolean).sort()[0];
  const months = monthly(s, today, from);
  const tripMonths = from ? fillMonths(t.byMonth, today, from) : [];
  const events = timeline(s);
  if (points.length === 0 && t.count === 0) {
    return `<p class="muted">${label}の日付つきの記録がまだありません。走行ログを読み込むと、ここに月ごとの記録や制覇の歴史が出ます。</p>`;
  }
  // ログ上の距離だけの年もあるので、両方の年を並べる
  const yearKeys = [...new Set([...years.map((y) => y.year), ...t.byYear.keys()])].sort((a, b) => b.localeCompare(a));
  const yearRows = yearKeys
    .map((key) => {
      const y = years.find((x) => x.year === key);
      const tr = t.byYear.get(key);
      return `<tr><td>${key === "" ? "日付なし" : key}</td><td>${tr ? `${km(tr.m, 0)} km` : "-"}</td><td>${km(y?.newKm ?? 0)} km</td>
        <td>${y?.firstRoutes ?? 0}</td><td>${y?.conquered ?? 0}</td></tr>`;
    })
    .join("");
  const undated = start > 0 ? `<p class="muted">日付を記録する前に読み込んだ ${km(start)} km は、最初から走っていたことにしています。</p>` : "";
  const noTrips =
    t.count === 0
      ? `<p class="muted">ログ上の走行距離は、これから読み込むログから数えます。MiniPC に保存してあるログは「保存したログで判定し直す」を押すと数えられます。</p>`
      : "";
  const shownEvents = events.slice(0, 150);
  return `<p class="muted">走行距離はログ上で走った距離(国道以外の道も、同じ道を何度走ったかも含む)、
      開拓距離は今開いているタブ(${label})を初めて通った距離です。</p>
    <p>ログ上の走行距離 合計 <b>${km(t.total, 0)} km</b> <span class="muted">(${t.count} 本のログ)</span></p>
    ${noTrips}
    <h3>年ごとのまとめ</h3>
    <table class="table"><thead><tr><th>年</th><th>走行距離</th><th>開拓距離</th><th>初めて走った路線</th><th>制覇した路線</th></tr></thead>
      <tbody>${yearRows}</tbody></table>
    ${t.count ? `<h3>月ごとの走行距離(ログ上・km)</h3>${monthlyChart(tripMonths, "月ごとの走行距離")}` : ""}
    ${months.length ? `<h3>月ごとの開拓距離(${label}・km)</h3>${monthlyChart(months, "月ごとの開拓距離")}` : ""}
    ${points.length ? `<h3>制覇率の推移</h3>${progressChart(points, start, s.stats.overall.total)}` : ""}
    ${undated}
    <h3>タイムライン</h3>
    <ol class="timeline" data-scroll="timeline">${shownEvents
      .map(
        (e) => `<li class="${e.type}"><span class="muted">${e.date}</span>
          <span>${e.type === "conquer" ? "🏁" : "👣"} <a href="#" data-route="${esc(e.ref)}" data-kind="${kind}">${esc(name(e.ref))}</a>
          を${e.type === "conquer" ? "制覇" : "初めて走った"}</span></li>`,
      )
      .join("")}</ol>
    ${events.length > shownEvents.length ? `<p class="muted">ほか ${events.length - shownEvents.length} 件</p>` : ""}`;
}

// ---------------------------------------------------------------- 都道府県

function prefRow(label: string, p: Progress, attrs: string) {
  const pct = p.total > 0 ? (p.done / p.total) * 100 : 0;
  return `<div class="row" ${attrs}><span>${label}</span><span>${pct.toFixed(1)}%</span>
    <div class="bar"><span style="width:${pct}%"></span></div>
    <span class="muted">${km(p.done)} / ${km(p.total)} km</span></div>`;
}

export function prefsView(s: DatasetSummary, kind: DatasetKind, fillOn: boolean, hasShapes: boolean): string {
  const label = kind === "kokudo" ? "国道" : "高速道路";
  if (!s.byPref) {
    return `<p>道路データにまだ都道府県が付いていません。</p>
      <p class="muted">GitHub の Actions で「国道・高速道路のデータを更新」を target = pref で実行し、
      終わったら MiniPC で update.bat を実行してください(10分ほどかかります)。</p>`;
  }
  const regions = regionProgress(s.byPref);
  const visited = [...s.byPref.values()].filter((p) => p.done > 0).length;
  return `<p class="muted">今開いているタブ(${label})の都道府県ごとの制覇率です。都道府県は区間の中ほどの位置で決めています。
      足跡のある都道府県 ${visited} / ${s.byPref.size}</p>
    ${hasShapes ? `<button type="button" id="pref-fill" aria-pressed="${fillOn}">${fillOn ? "地図の色分けをやめる" : "🗺️ 地図を都道府県で色分けする"}</button>
      <p class="legend pref-legend">0% <span class="ramp"></span> 100%<span class="muted">(少し走っただけでも色が付くよう、低い側を細かく塗り分けています。地図の県を押すと制覇率が出ます)</span></p>` : ""}
    ${regions
      .map(
        (r) => `<details class="region" open><summary>${prefRow(`<b>${r.name}</b>`, r.progress, "")}</summary>
          <ul class="prefs">${r.prefs
            .map((code) => `<li>${prefRow(prefName(code), s.byPref!.get(code)!, `data-pref="${code}"`)}</li>`)
            .join("")}</ul></details>`,
      )
      .join("")}
    <p class="muted">都道府県名を押すと、地図を色分けしてその都道府県を映します。</p>`;
}
