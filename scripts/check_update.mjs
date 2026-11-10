// 新しいコード(GitHub の main)や国道データ(リリース route-data)が出ているかを調べる。
// auto-update.ps1(タスク KokudoMapUpdate)が5分ごとに呼び、出ていれば update.ps1 で取り込んでサーバーを再起動する。
//   node scripts/check_update.mjs
// 終了コード: 0 = 最新 / 10 = 更新がある / 1 = 調べられなかった
// fetch のあとに process.exit() で終えると、Windows の Node 24 で libuv のアサーション
// (src\win\async.c)で落ち、終了コードが 0xC0000409 になる。exitCode を入れて自然に終わらせる。
// データは download_release.mjs が覚えた public/data/.release-state.json と比べる。
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO = process.env.ROUTE_DATA_REPO ?? "Yzvica/National-Route-Conquest-Map";
const TAG = "route-data";
/** update.ps1 が取るファイル。リリースにないものは比べない */
const FILES = ["routes.json", "expressways.json", "prefectures.json", "prefroads.tar.gz"];
const git = (...args) => execFileSync("git", args, { encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }).trim();

async function main() {
  const reasons = [];

  const branch = git("rev-parse", "--abbrev-ref", "HEAD");
  const head = git("rev-parse", "HEAD");
  const remote = git("ls-remote", "origin", `refs/heads/${branch}`).split(/\s+/)[0];
  if (!remote) throw new Error(`GitHub に ${branch} ブランチが見つかりません`);
  if (remote !== head) {
    // 手元にだけあるコミット(リモートより先)なら取り込めないので、更新とはしない
    let behind = true;
    try {
      git("merge-base", "--is-ancestor", remote, head);
      behind = false;
    } catch {}
    if (behind) reasons.push(`コード ${head.slice(0, 7)} → ${remote.slice(0, 7)}`);
  }

  const token = execFileSync("gh", ["auth", "token"], { encoding: "utf8" }).trim();
  const res = await fetch(`${process.env.GITHUB_API ?? "https://api.github.com"}/repos/${REPO}/releases/tags/${TAG}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "kokudo-update" },
  });
  if (!res.ok) throw new Error(`リリース ${TAG} を読めませんでした(${res.status})`);
  const assets = (await res.json()).assets;
  let state = {};
  try {
    state = JSON.parse(readFileSync(join("public", "data", ".release-state.json"), "utf8"));
  } catch {}
  for (const name of FILES) {
    const a = assets.find((x) => x.name === name);
    if (!a) continue;
    const prev = state[name];
    if (!prev || prev.id !== a.id || prev.updated_at !== a.updated_at || prev.size !== a.size) reasons.push(`データ ${name}`);
  }

  if (reasons.length) {
    console.log(`更新があります: ${reasons.join("、")}`);
    process.exitCode = 10;
    return;
  }
  console.log("最新です");
}

main().catch((e) => {
  console.error(`更新を調べられませんでした: ${e.message}`);
  process.exitCode = 1;
});
