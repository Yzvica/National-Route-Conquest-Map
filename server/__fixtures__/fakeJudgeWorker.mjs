// テスト用の判定 worker。ログの各行「区間ID,割合,日付」をそのまま判定結果として返す。"BAD" を含むログは読めないことにする。
// "HOG" を含むログはメモリを使い続ける(上限で止まる)。
// トンネルの補間(fillDir)は、location.csv の行数だけをまとめに入れて返す
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parentPort, workerData } from "node:worker_threads";
import { gunzipSync } from "node:zlib";

parentPort.on("message", ({ seq, logId, fillDir }) => {
  if (fillDir) {
    const rows = readFileSync(join(fillDir, "location.csv"), "utf8").trim().split("\n").length - 1;
    const fill = { version: 1, generatedAt: "x", sections: [{ points: rows }], skipped: [] };
    writeFileSync(join(fillDir, "tunnel_fill.json"), JSON.stringify(fill));
    return parentPort.postMessage({ seq, fill });
  }
  const text = gunzipSync(readFileSync(join(workerData.logsDir, logId))).toString("utf8");
  // メモリの上限を超えるまで使い続ける(上限で止まったときのテスト)
  if (text.includes("HOG")) {
    const hog = [];
    for (;;) hog.push(new Array(1e5).fill({ x: hog.length }));
  }
  if (text.includes("BAD")) return parentPort.postMessage({ seq, error: "読めないログ" });
  const rows = text.trim().split("\n").map((l) => l.split(","));
  const day = rows[0][2];
  parentPort.postMessage({
    seq,
    result: {
      name: logId.replace(/^\d+-/, "").replace(/\.gz$/, ""),
      points: rows.length,
      trip: { date: day, m: 1000 * rows.length },
      tripKey: `t-${logId}`,
      coverage: Object.fromEntries(rows.map(([id, r]) => [id, Number(r)])),
      dates: Object.fromEntries(rows.map(([id]) => [id, [day, day]])),
    },
  });
});
parentPort.postMessage({ ready: true });
