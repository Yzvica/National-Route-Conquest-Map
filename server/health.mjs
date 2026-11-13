// 保守用の状態まとめ。/api/health(JSON)と /health(見やすい画面)で出す。
// MiniPC のファイル(data\update.log など)を見に行かなくても、サーバーの様子がわかるようにする。
import { existsSync, readdirSync, readFileSync, statSync, statfsSync } from "node:fs";
import { join, resolve } from "node:path";

const startedAt = new Date();

function readText(path, encoding = "utf8") {
  try {
    const buf = readFileSync(path);
    // PowerShell 5 の Add-Content(既定)はシフトJIS で書く。UTF-8 として読めればそちらを使う
    let text;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(buf);
    } catch {
      text = new TextDecoder(encoding === "utf8" ? "utf-8" : encoding).decode(buf);
    }
    return text.replace(/^﻿/, "");
  } catch {
    return null;
  }
}

/** ファイルの最後の n 行(大きいファイルは末尾 64KB だけ読む) */
function tail(path, n, encoding = "utf8") {
  const text = readText(path, encoding);
  if (text === null) return null;
  return text.slice(-65536).split(/\r?\n/).filter((l) => l.trim()).slice(-n);
}

function mtime(path) {
  try {
    return statSync(path).mtime.toISOString();
  } catch {
    return null;
  }
}

/** 動いているコードのコミット(.git を直接読む。git コマンドは使わない) */
function gitHead(root) {
  try {
    const head = readFileSync(join(root, ".git", "HEAD"), "utf8").trim();
    if (!head.startsWith("ref: ")) return { branch: null, commit: head };
    const ref = head.slice(5);
    const branch = ref.replace(/^refs\/heads\//, "");
    const loose = join(root, ".git", ref);
    if (existsSync(loose)) return { branch, commit: readFileSync(loose, "utf8").trim() };
    const packed = readText(join(root, ".git", "packed-refs")) ?? "";
    const line = packed.split(/\r?\n/).find((l) => l.endsWith(` ${ref}`));
    return { branch, commit: line ? line.split(" ")[0] : null };
  } catch {
    return { branch: null, commit: null };
  }
}

function disk(path) {
  try {
    const s = statfsSync(path);
    return { path, freeGB: +((s.bavail * s.bsize) / 1e9).toFixed(1), totalGB: +((s.blocks * s.bsize) / 1e9).toFixed(1) };
  } catch {
    return { path, freeGB: null, totalGB: null };
  }
}

/** 走行フォルダ(<走行ID> = 20261113-123456 など)のうち一番新しいもの */
function latestSession(dir) {
  try {
    const names = readdirSync(dir).filter((n) => /^\d{8}-\d{6}/.test(n));
    return names.sort().at(-1) ?? null;
  } catch {
    return null;
  }
}

/**
 * @param {object} ctx
 * @param {string} ctx.root リポジトリのフォルダ
 * @param {string} ctx.rawLogDir 走行の生データのフォルダ
 * @param {() => object} ctx.judge 判定の状態
 * @param {() => object[]} ctx.weatherPending 天気の取り直し待ち
 * @param {() => object} ctx.gmaps Google マップの状態
 * @param {() => object[]} ctx.logs 保存しているログ
 */
// 起動したとき(このファイルを読んだとき)のコミット。取り込んだのに再起動で入れ替わっていないのを見つける
const startedCommit = gitHead(resolve(import.meta.dirname, "..")).commit;

export function collectHealth(ctx) {
  const now = new Date();
  const repoData = join(ctx.root, "data");
  const head = gitHead(ctx.root);
  const built = readText(join(repoData, "built.txt"))?.trim() || null;
  const failedPath = join(repoData, "update.failed");
  const failed = existsSync(failedPath) ? { at: mtime(failedPath), what: readText(failedPath)?.trim() ?? "" } : null;

  let judge = {};
  try {
    judge = ctx.judge();
  } catch (e) {
    judge = { error: String(e) };
  }
  let weatherPending = [];
  try {
    weatherPending = ctx.weatherPending();
  } catch {
    weatherPending = [];
  }
  let gmaps = {};
  try {
    gmaps = ctx.gmaps();
  } catch (e) {
    gmaps = { error: String(e) };
  }
  let logs = [];
  try {
    logs = ctx.logs();
  } catch {
    logs = [];
  }
  const latestLog = logs.reduce((a, l) => (l.date && (!a || l.date > a) ? l.date : a), null);

  const rawExists = existsSync(ctx.rawLogDir);
  const releasePath = join(ctx.root, "public", "data", ".release-state.json");
  let release = null;
  try {
    const st = JSON.parse(readFileSync(releasePath, "utf8"));
    release = Object.fromEntries(Object.entries(st).map(([k, v]) => [k, v?.updated_at ?? null]));
  } catch {
    release = null;
  }

  const disks = [disk(ctx.root)];
  if (rawExists) {
    const d = disk(ctx.rawLogDir);
    // 同じドライブなら1つだけ出す
    if (d.totalGB !== disks[0].totalGB || d.freeGB !== disks[0].freeGB) disks.push(d);
  }

  const mem = process.memoryUsage();
  const health = {
    time: now.toISOString(),
    server: {
      startedAt: startedAt.toISOString(),
      uptimeMin: Math.round((now.getTime() - startedAt.getTime()) / 60000),
      node: process.version,
      pid: process.pid,
      memoryMB: Math.round(mem.rss / 1e6),
    },
    code: {
      branch: head.branch,
      commit: head.commit,
      startedCommit: ctx.startedCommit ?? startedCommit,
      built,
      // pull したのにまだビルドしていない(または失敗した)
      builtIsHead: !!built && built === head.commit,
    },
    update: {
      failed,
      logUpdatedAt: mtime(join(repoData, "update.log")),
      logTail: tail(join(repoData, "update.log"), 15) ?? [],
    },
    restarts: {
      logTail: tail(join(repoData, "server.log"), 10, "shift_jis") ?? [],
      errTail: tail(join(repoData, "server.err.log"), 10) ?? [],
    },
    judge,
    weather: {
      pending: weatherPending.length,
      oldest: weatherPending.map((p) => p.since ?? p.at ?? null).filter(Boolean).sort()[0] ?? null,
    },
    logs: { count: logs.length, latestDate: latestLog },
    rawlogs: {
      dir: ctx.rawLogDir,
      exists: rawExists,
      latestDrive: rawExists ? latestSession(ctx.rawLogDir) : null,
      latestTrip: rawExists ? latestSession(join(ctx.rawLogDir, "trips")) : null,
    },
    release,
    disks,
    gmaps,
  };
  health.warnings = warnings(health);
  health.ok = health.warnings.length === 0;
  return health;
}

function warnings(h) {
  const w = [];
  if (h.update.failed) w.push(`自動更新が失敗しています(${h.update.failed.at}): ${h.update.failed.what}`);
  if (h.code.commit && h.code.built && !h.code.builtIsHead) w.push("取り込んだコードがまだビルドされていません(自動更新の途中か、失敗)");
  else if (h.code.commit && h.code.startedCommit && h.code.commit !== h.code.startedCommit)
    w.push("取り込んだコードに再起動で入れ替わっていません(自動更新の途中か、再起動の失敗)");
  if (h.judge.error) w.push(`判定の状態を読めません: ${h.judge.error}`);
  else if (h.judge.enabled === false) w.push("サーバーで国道判定ができません(道路データの準備ができていない)");
  else if (h.judge.pending > 0 && !h.judge.running) w.push(`判定待ちのログが ${h.judge.pending} 件あるのに判定していません`);
  if (!h.rawlogs.exists) w.push(`走行の生データのフォルダが見つかりません: ${h.rawlogs.dir}`);
  for (const d of h.disks) if (d.freeGB !== null && d.freeGB < 5) w.push(`空き容量が少なくなっています: ${d.path}(残り ${d.freeGB} GB)`);
  if (h.gmaps.enabled && h.gmaps.overLimit) w.push("Google マップのタイルが上限に達しています(翌日・翌月に戻ります)");
  return w;
}

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const jst = (iso) => (iso ? new Date(iso).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" }) : "—");

/** 判定の1回分({ kind, done, total, failed, startedAt, finishedAt, current }) */
function runText(r) {
  if (!r) return "—";
  if (typeof r !== "object") return esc(r);
  const kind = r.kind === "rejudge" ? "全部判定し直し" : "届いたログ";
  const fail = Array.isArray(r.failed) && r.failed.length ? `・失敗 ${r.failed.length}` : "";
  const when = r.finishedAt ? `${jst(r.finishedAt)} 終了` : `${jst(r.startedAt)} 開始`;
  const cur = r.current && !r.finishedAt ? `・${r.current}` : "";
  return esc(`${kind} ${r.done ?? 0}/${r.total ?? 0} 件${fail}(${when})${cur}`);
}

export function renderHealthHtml(h) {
  const row = (k, v) => `<tr><th>${esc(k)}</th><td>${v}</td></tr>`;
  const lines = (arr) => (arr.length ? `<pre>${arr.map(esc).join("\n")}</pre>` : '<span class="muted">なし</span>');
  const short = (c) => (c ? esc(c.slice(0, 7)) : "—");
  const up = h.server.uptimeMin;
  const upText = up >= 1440 ? `${Math.floor(up / 1440)}日 ${Math.floor((up % 1440) / 60)}時間` : up >= 60 ? `${Math.floor(up / 60)}時間 ${up % 60}分` : `${up}分`;
  const j = h.judge;
  const g = h.gmaps;
  return `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>サーバーの状態</title>
<style>
:root { color-scheme: light dark; --ok: #2e7d32; --warn: #c62828; --muted: #888; --line: #8884; }
body { font: 14px/1.5 system-ui, sans-serif; margin: 0 auto; padding: 16px; max-width: 860px; }
h1 { font-size: 20px; margin: 0 0 8px; } h2 { font-size: 16px; margin: 20px 0 6px; }
.badge { display: inline-block; padding: 2px 10px; border-radius: 999px; color: #fff; font-weight: 700; }
.ok { background: var(--ok); } .ng { background: var(--warn); }
ul.warn { color: var(--warn); padding-left: 20px; }
table { border-collapse: collapse; width: 100%; } th, td { text-align: left; padding: 4px 8px; border-bottom: 1px solid var(--line); vertical-align: top; }
th { width: 38%; font-weight: 600; } th, td { overflow-wrap: anywhere; }
table { table-layout: fixed; }
pre { margin: 0; white-space: pre-wrap; word-break: break-all; font-size: 12px; }
.muted { color: var(--muted); } a { color: inherit; }
</style></head><body>
<h1>サーバーの状態 <span class="badge ${h.ok ? "ok" : "ng"}">${h.ok ? "正常" : `注意 ${h.warnings.length}件`}</span></h1>
<p class="muted">${esc(jst(h.time))} 時点 · <a href="/health">更新</a> · <a href="/api/health">JSON</a> · <a href="/">地図へ</a></p>
${h.warnings.length ? `<ul class="warn">${h.warnings.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : ""}
<h2>サーバー</h2><table>
${row("起動した時刻", `${esc(jst(h.server.startedAt))}(${esc(upText)}前)`)}
${row("動いているコード(起動時)", short(h.code.startedCommit))}
${row("取り込んだコード", `${short(h.code.commit)}(${esc(h.code.branch ?? "—")})`)}
${row("ビルドしたコード", short(h.code.built))}
${row("Node / メモリ", `${esc(h.server.node)} / ${h.server.memoryMB} MB`)}
${h.disks.map((d) => row(`空き容量 ${d.path}`, d.freeGB === null ? "—" : `${d.freeGB} GB / ${d.totalGB} GB`)).join("")}
</table>
<h2>国道判定</h2><table>
${row("サーバーで判定", j.enabled ? "できる" : "できない")}
${row("いま判定中", j.running ? runText(j.running) : "なし")}
${row("判定待ち", `${j.pending ?? "—"} 件`)}
${row("最後の判定", runText(j.last))}
</table>
<h2>走行ログ</h2><table>
${row("保存しているログ", `${h.logs.count} 件(最新 ${esc(h.logs.latestDate ?? "—")})`)}
${row("最後に届いた運転", esc(h.rawlogs.latestDrive ?? "—"))}
${row("最後に届いた旅の記録", esc(h.rawlogs.latestTrip ?? "—"))}
${row("生データのフォルダ", `${esc(h.rawlogs.dir)}${h.rawlogs.exists ? "" : " (見つからない)"}`)}
${row("天気の取り直し待ち", `${h.weather.pending} 本`)}
</table>
<h2>Google マップ</h2><table>
${g.enabled ? row("今日 / 今月", `${g.today} / ${g.dailyLimit} ・ ${g.month} / ${g.monthlyLimit} タイル`) : row("状態", "キーが置かれていません")}
</table>
<h2>国道データ(リリース)</h2><table>
${h.release ? Object.entries(h.release).map(([k, v]) => row(k, esc(jst(v)))).join("") : row("状態", "不明")}
</table>
<h2>自動更新の記録 <span class="muted">(update.log · ${esc(jst(h.update.logUpdatedAt))})</span></h2>
${lines(h.update.logTail)}
<h2>起動・再起動の記録 <span class="muted">(server.log)</span></h2>
${lines(h.restarts.logTail)}
<h2>エラー出力 <span class="muted">(server.err.log)</span></h2>
${lines(h.restarts.errTail)}
</body></html>`;
}
