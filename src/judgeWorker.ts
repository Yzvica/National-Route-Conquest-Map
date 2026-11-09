// MiniPC のサーバーで走行ログを判定する worker(server/server.mjs が worker_threads で動かす)。
// npm run build で server/build/judgeWorker.js にまとめる。
// 道路データ(数百MB)は読み込みに時間がかかるので、HTTP を受けるスレッドとは分けて動かす
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parentPort, workerData } from "node:worker_threads";
import { gunzipSync } from "node:zlib";
import { judgeLog, type JudgeData } from "./judge";
import { prefFileName, prefsOfTrack } from "./prefroads";
import { fillTunnels, roadsFromData, type FilledSection, type SkippedSection } from "./tunnelFill";
import type { PrefRoadIndex, RouteData, TrackPoint } from "./types";

export interface JudgeRequest {
  seq: number;
  /** data/logs にある保存済みのログ(「保存時刻-名前.gz」) */
  logId?: string;
  /** iPhone の走行ロガーの走行フォルダ。location.csv のトンネルなどで途切れた区間を道路に沿って補う */
  fillDir?: string;
}

/** トンネルの補間の結果(走行フォルダの tunnel_fill.json にも書く) */
export interface FillSummary {
  version: 1;
  generatedAt: string;
  sections: FilledSection[];
  skipped: SkippedSection[];
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

/** 書きかけで落ちても壊れたファイルが残らないよう、別名で書いてから置き換える */
function writeAtomic(path: string, text: string) {
  writeFileSync(`${path}.part`, text);
  renameSync(`${path}.part`, path);
}

/** 走行フォルダの location.csv を補って、location_filled.csv と tunnel_fill.json を書く */
async function fillDir(dir: string): Promise<FillSummary> {
  const text = readFileSync(join(dir, "location.csv"), "utf8");
  // 都道府県道は、ログが通った都道府県のものを使う
  const pts: TrackPoint[] = [];
  for (const line of text.split(/\r?\n/).slice(1)) {
    const f = line.split(",");
    const lat = Number(f[1]), lon = Number(f[2]);
    if (f.length > 2 && Number.isFinite(lat) && Number.isFinite(lon)) pts.push({ lat, lon });
  }
  const prefs: (RouteData | undefined)[] = [];
  if (data.prefIndex) for (const code of prefsOfTrack(data.prefIndex, pts)) prefs.push(await data.loadPref(code));
  const r = fillTunnels(text, roadsFromData([data.kokudo, data.expressway, ...prefs]));
  const summary: FillSummary = { version: 1, generatedAt: new Date().toISOString(), sections: r.sections, skipped: r.skipped };
  writeAtomic(join(dir, "location_filled.csv"), r.csv);
  writeAtomic(join(dir, "tunnel_fill.json"), JSON.stringify(summary, null, 1));
  return summary;
}

parentPort!.on("message", async ({ seq, logId, fillDir: dir }: JudgeRequest) => {
  const reply = (r: Omit<JudgeResponse, "seq">) => parentPort!.postMessage({ seq, ...r } satisfies JudgeResponse);
  if (dir !== undefined) {
    try {
      if (!data.kokudo) throw new Error("国道のデータ(dist/data/routes.json)がありません");
      parentPort!.postMessage({ seq, fill: await fillDir(dir) });
    } catch (e) {
      reply({ error: (e as Error).message });
    }
    return;
  }
  try {
    if (!logId) throw new Error("bad request");
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
