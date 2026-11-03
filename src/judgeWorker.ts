// MiniPC のサーバーで走行ログを判定する worker(server/server.mjs が worker_threads で動かす)。
// npm run build で server/build/judgeWorker.js にまとめる。
// 道路データ(数百MB)は読み込みに時間がかかるので、HTTP を受けるスレッドとは分けて動かす
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parentPort, workerData } from "node:worker_threads";
import { gunzipSync } from "node:zlib";
import { judgeLog, type JudgeData } from "./judge";
import { prefFileName } from "./prefroads";
import type { PrefRoadIndex, RouteData } from "./types";

export interface JudgeRequest {
  seq: number;
  /** data/logs にある保存済みのログ(「保存時刻-名前.gz」) */
  logId: string;
}

export interface JudgeResponse {
  seq: number;
  error?: string;
  result?: {
    name: string;
    points: number;
    trip: { date: string; m: number };
    tripKey: string;
    coverage: { [id: string]: number };
    dates: { [id: string]: [string, string] };
  };
}

const { dataDir, logsDir } = workerData as { dataDir: string; logsDir: string };

const readJson = <T>(path: string): T | undefined => {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return undefined;
  }
};

// 都道府県ごとのファイルは、近いところを続けて走ったログで使い回せるよう少しだけ覚えておく
const PREF_CACHE = 6;
const prefCache = new Map<number, RouteData | undefined>();

const data: JudgeData = {
  kokudo: readJson<RouteData>(join(dataDir, "routes.json")),
  expressway: readJson<RouteData>(join(dataDir, "expressways.json")),
  prefIndex: readJson<PrefRoadIndex>(join(dataDir, "prefroads", "index.json")) ?? null,
  async loadPref(code) {
    if (prefCache.has(code)) {
      const d = prefCache.get(code);
      prefCache.delete(code);
      prefCache.set(code, d);
      return d;
    }
    const d = readJson<RouteData>(join(dataDir, prefFileName(code)));
    prefCache.set(code, d);
    if (prefCache.size > PREF_CACHE) prefCache.delete(prefCache.keys().next().value!);
    return d;
  },
};

const logName = (id: string) => id.replace(/^\d+-/, "").replace(/\.gz$/, "");

parentPort!.on("message", async ({ seq, logId }: JudgeRequest) => {
  const reply = (r: Omit<JudgeResponse, "seq">) => parentPort!.postMessage({ seq, ...r } satisfies JudgeResponse);
  try {
    if (!data.kokudo) throw new Error("国道のデータ(dist/data/routes.json)がありません");
    if (logId.includes("/") || logId.includes("\\")) throw new Error("bad log id");
    const text = gunzipSync(readFileSync(join(logsDir, logId))).toString("utf8");
    const name = logName(logId);
    const j = await judgeLog(text, name, Number(logId.split("-")[0]) || Date.now(), data);
    reply({
      result: {
        name,
        points: j.track.length,
        trip: j.trip,
        tripKey: j.tripKey,
        coverage: Object.fromEntries(j.coverage),
        dates: Object.fromEntries([...j.coverage.keys()].map((id) => [id, [j.day, j.day]])),
      },
    });
  } catch (e) {
    reply({ error: (e as Error).message });
  }
});

parentPort!.postMessage({ ready: true });
