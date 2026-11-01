// リリース route-data のファイルを、1MB ずつに分けて同時に取ってくる(scripts/update.ps1 から使う)。
//   node scripts/download_release.mjs <保存先フォルダ> <ファイル名>
// MiniPC の回線では GitHub のファイル配信サーバーへの1本あたりの速度が数KB/秒まで落ちることがあり、
// gh release download(1本で取る)だと 58MB の routes.json に2時間かかって途中で切れた(2026-11-01)。
// 分けて同時に取れば合計の速度は上がる。認証には gh のログイン(gh auth token)を使う。
// 終了コード: 0 = 取れた / 2 = リリースにそのファイルがない / 1 = 失敗
import { execFileSync } from "node:child_process";
import { closeSync, mkdirSync, openSync, renameSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";

const REPO = process.env.ROUTE_DATA_REPO ?? "Yzvica/National-Route-Conquest-Map";
const TAG = "route-data";
const CHUNK = 1024 * 1024;
const PARALLEL = 32;
const TRIES = 8;
/** 1つの部分をこの時間(ミリ秒)で取れなければやり直す */
const CHUNK_TIMEOUT = 90_000;
/** 配信先の署名付き URL は数分で切れるので、この時間がたったら取り直す */
const URL_TTL = 4 * 60_000;

const [dir, name] = process.argv.slice(2);
if (!dir || !name) {
  console.error("使い方: node scripts/download_release.mjs <保存先フォルダ> <ファイル名>");
  process.exit(1);
}

const token = execFileSync("gh", ["auth", "token"], { encoding: "utf8" }).trim();
const api = (path, accept = "application/vnd.github+json") =>
  fetch(`${process.env.GITHUB_API ?? "https://api.github.com"}/${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: accept, "User-Agent": "kokudo-update" },
    redirect: "manual",
  });

const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));

async function findAsset() {
  const res = await api(`repos/${REPO}/releases/tags/${TAG}`);
  if (!res.ok) throw new Error(`リリース ${TAG} を読めませんでした(${res.status})`);
  return (await res.json()).assets.find((a) => a.name === name);
}

let signed = { url: "", at: 0 };
/** 配信先の署名付き URL(api.github.com がリダイレクトで返す)。期限が近ければ取り直す */
async function signedUrl(assetId, force = false) {
  if (!force && signed.url && Date.now() - signed.at < URL_TTL) return signed.url;
  const res = await api(`repos/${REPO}/releases/assets/${assetId}`, "application/octet-stream");
  const loc = res.headers.get("location");
  if (!loc) throw new Error(`ダウンロード先を取れませんでした(${res.status})`);
  signed = { url: loc, at: Date.now() };
  return loc;
}

async function fetchChunk(assetId, start, end) {
  let lastErr;
  for (let t = 0; t < TRIES; t++) {
    const url = await signedUrl(assetId, t > 0 && lastErr?.expired);
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), CHUNK_TIMEOUT);
    try {
      const res = await fetch(url, { headers: { Range: `bytes=${start}-${end}` }, signal: ctl.signal });
      if (res.status === 401 || res.status === 403) {
        lastErr = Object.assign(new Error(`署名の期限切れ(${res.status})`), { expired: true });
        continue;
      }
      if (res.status !== 206) throw new Error(`部分取得に失敗(${res.status})`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length !== end - start + 1) throw new Error(`大きさが合いません(${buf.length})`);
      return buf;
    } catch (e) {
      lastErr = e;
      await sleep(1000 * (t + 1));
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(`${start} バイト目からの部分が取れませんでした: ${lastErr?.message}`);
}

async function main() {
  const asset = await findAsset();
  if (!asset) {
    console.log(`リリースに ${name} はありません`);
    process.exit(2);
  }
  mkdirSync(dir, { recursive: true });
  const dest = join(dir, name);
  const tmp = `${dest}.part`;
  const size = asset.size;
  const ranges = [];
  for (let s = 0; s < size; s += CHUNK) ranges.push([s, Math.min(s + CHUNK, size) - 1]);

  const started = Date.now();
  const fd = openSync(tmp, "w");
  let done = 0;
  let got = 0;
  let next = 0;
  try {
    const worker = async () => {
      while (next < ranges.length) {
        const [s, e] = ranges[next++];
        const buf = await fetchChunk(asset.id, s, e);
        writeSync(fd, buf, 0, buf.length, s);
        got += buf.length;
        done++;
        const sec = (Date.now() - started) / 1000;
        process.stdout.write(
          `\r${name}: ${done} / ${ranges.length}(${(got / 1e6).toFixed(1)} / ${(size / 1e6).toFixed(1)} MB、${(got / 1024 / sec).toFixed(0)} KB/秒)   `,
        );
      }
    };
    await Promise.all(Array.from({ length: Math.min(PARALLEL, ranges.length) }, worker));
  } catch (e) {
    closeSync(fd);
    rmSync(tmp, { force: true });
    throw e;
  }
  closeSync(fd);
  // 全部そろってから置き換える(途中で切れても、前のファイルが壊れないように)
  renameSync(tmp, dest);
  console.log(`\n${name} を取得しました(${((Date.now() - started) / 1000).toFixed(0)} 秒)`);
}

main().catch((e) => {
  console.error(`\n${name} を取得できませんでした: ${e.message}`);
  process.exit(1);
});
