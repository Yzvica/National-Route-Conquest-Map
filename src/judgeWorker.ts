// MiniPC のサーバーで走行ログを判定する worker(server/server.mjs が worker_threads で動かす)。
// npm run build で server/build/judgeWorker.js にまとめる。
// 道路データ(数百MB)は読み込みに時間がかかるので、HTTP を受けるスレッドとは分けて動かす
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parentPort, workerData } from "node:worker_threads";
import { gunzipSync } from "node:zlib";
import { judgeLog, type JudgeData } from "./judge";
import { prefFileName, prefsOfTrack } from "./prefroads";
import { RAIL_FILL_OPTIONS, railsFromData, type RailData } from "./railFill";
import { fillTunnels, roadsFromData, type FilledSection, type SkippedSection } from "./tunnelFill";
import type { PrefRoadIndex, RouteData, TrackPoint } from "./types";

export interface JudgeRequest {
  seq: number;
  /** data/logs にある保存済みのログ(「保存時刻-名前.gz」) */
  logId?: string;
  /** iPhone の走行ロガーの走行フォルダ。location.csv のトンネルなどで途切れた区間を道路(電車は線路)に沿って補う */
  fillDir?: string;
}

/** トンネルの補間の結果(走行フォルダの tunnel_fill.json にも書く) */
export interface FillSummary {
  version: 1;
  generatedAt: string;
  /**
   * 補い方の版。補い方を直したら上げる。電車の補い方が変わったら server.mjs の RAIL_FILL_REV も合わせる(サーバーは起動時に、版の古い電車の記録を補い直す)。
   * 2: 止まりかけ・向きの精度が悪い端の点の向きで道を絞り込まない
   * 3: 短い途切れ(15秒未満・直線300m未満)も補う、復帰直後の精度の悪い点(±30m超)を捨てる(車・同乗だけ。電車は変わらない)
   */
  rev?: number;
  /** 何に沿って補ったか(電車は線路、それ以外は道路)。古い結果にはない */
  source?: "road" | "rail";
  sections: FilledSection[];
  skipped: SkippedSection[];
  /** 捨てた復帰直後の精度の悪い点の数(rev 3 から) */
  dropped?: number;
}

export interface JudgeResponse {
  seq: number;
  error?: string;
  result?: {
    name: string;
    points: number;
    trip: { date: string; m: number; start?: number };
    tripKey: string;
    coverage: { [id: string]: number };
    dates: { [id: string]: [string, string] };
  };
}

/** 補い方の版(FillSummary.rev) */
const FILL_REV = 3;

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

/** 線路のデータ(電車の記録を補うときだけ読む。読めなければ undefined) */
let rails: RailData | undefined | null = null;
function loadRails(): RailData | undefined {
  if (rails === null) {
    try {
      rails = JSON.parse(gunzipSync(readFileSync(join(dataDir, "railways.json.gz"))).toString("utf8")) as RailData;
    } catch {
      rails = undefined;
    }
  }
  return rails;
}

/** 走行フォルダの location.csv を補って、location_filled.csv と tunnel_fill.json を書く。電車は線路に沿って補う */
async function fillDir(dir: string): Promise<FillSummary> {
  const text = readFileSync(join(dir, "location.csv"), "utf8");
  const meta = readJson<{ mode?: string }>(join(dir, "meta.json"));
  let r;
  let source: "road" | "rail";
  if (meta?.mode === "train") {
    const rd = loadRails();
    if (!rd) throw new Error("線路のデータ(dist/data/railways.json.gz)がありません");
    r = fillTunnels(text, railsFromData(rd), RAIL_FILL_OPTIONS);
    source = "rail";
  } else {
    if (!data.kokudo) throw new Error("国道のデータ(dist/data/routes.json)がありません");
    // 都道府県道は、ログが通った都道府県のものを使う
    const pts: TrackPoint[] = [];
    for (const line of text.split(/\r?\n/).slice(1)) {
      const f = line.split(",");
      const lat = Number(f[1]), lon = Number(f[2]);
      if (f.length > 2 && Number.isFinite(lat) && Number.isFinite(lon)) pts.push({ lat, lon });
    }
    const prefs: (RouteData | undefined)[] = [];
    if (data.prefIndex) for (const code of prefsOfTrack(data.prefIndex, pts)) prefs.push(await data.loadPref(code));
    r = fillTunnels(text, roadsFromData([data.kokudo, data.expressway, ...prefs]));
    source = "road";
  }
  const summary: FillSummary = { version: 1, rev: FILL_REV, generatedAt: new Date().toISOString(), source, sections: r.sections, skipped: r.skipped, dropped: r.dropped };
  writeAtomic(join(dir, "location_filled.csv"), r.csv);
  writeAtomic(join(dir, "tunnel_fill.json"), JSON.stringify(summary, null, 1));
  return summary;
}

parentPort!.on("message", async ({ seq, logId, fillDir: dir }: JudgeRequest) => {
  const reply = (r: Omit<JudgeResponse, "seq">) => parentPort!.postMessage({ seq, ...r } satisfies JudgeResponse);
  if (dir !== undefined) {
    try {
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
