import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const recordDir = mkdtempSync(join(tmpdir(), "kokudo-judge-"));
process.env.WEATHER = "off";
process.env.RECORD_FILE = join(recordDir, "record.json");
process.env.LOGS_DIR = mkdtempSync(join(tmpdir(), "kokudo-judge-logs-"));
process.env.JUDGE_WORKER = join(import.meta.dirname, "__fixtures__", "fakeJudgeWorker.mjs");
process.env.JUDGE_DATA_DIR = mkdtempSync(join(tmpdir(), "kokudo-judge-data-"));
process.env.JUDGE_IDLE_MS = "10";
// テスト用の worker は小さいので、上限を小さくしてメモリの上限で止まったときを試す
process.env.JUDGE_MAX_MB = "64";
process.env.RAW_LOG_DIR = mkdtempSync(join(tmpdir(), "kokudo-judge-raw-"));
writeFileSync(join(process.env.JUDGE_DATA_DIR, "routes.json"), "{}");
const { createApp, judgeIdle, shouldFill, trainsToFill } = await import("./server.mjs");

describe("サーバーでの判定", () => {
  let server;
  let root;
  beforeAll(async () => {
    server = createApp();
    await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
    root = `http://127.0.0.1:${server.address().port}/api`;
  });
  afterAll(() => server.close());

  const get = (path) => fetch(`${root}${path}`).then((r) => r.json());
  const send = (name, body) => fetch(`${root}/inbox?name=${encodeURIComponent(name)}`, { method: "POST", body }).then((r) => r.json());

  it("自動で送られてきたログは、地図を開かなくてもサーバーで判定して記録に足す", async () => {
    expect((await get("/judge")).enabled).toBe(true);
    const { id } = await send("a.csv", "s1,1,2026-11-01\ns2,0.5,2026-11-01\n");
    await judgeIdle();
    const rec = await get("/record");
    expect(rec.coverage).toEqual({ s1: 1, s2: 0.5 });
    expect(rec.dates.s1).toEqual(["2026-11-01", "2026-11-01"]);
    expect(rec.logs.map((l) => l.name)).toEqual(["a.csv"]);
    expect(rec.trips[`t-${id}`]).toEqual({ date: "2026-11-01", m: 2000 });
    // 判定したので、ブラウザが判定する一覧には残らない。ログ一覧には日付と距離が付く
    expect(await get("/inbox")).toEqual([]);
    expect((await get("/logs")).find((l) => l.id === id)).toMatchObject({ date: "2026-11-01", m: 2000 });
    const st = await get("/judge");
    expect(st.rev).toBe(1);
    expect(st.last).toMatchObject({ kind: "inbox", done: 1, total: 1, failed: [] });
  });

  it("判定し直すと、保存したログの結果で通った区間を置き換え、前の記録の控えを残す", async () => {
    // 前の判定の誤り(ログにない区間)
    await fetch(`${root}/record`, { method: "POST", body: JSON.stringify({ coverage: { wrong: 1 }, dates: { wrong: ["2026-01-01", "2026-01-01"] }, logs: [] }) });
    await send("b.csv", "s3,0.8,2026-11-02\n");
    await judgeIdle();
    const res = await fetch(`${root}/rejudge`, { method: "POST" });
    expect(res.status).toBe(202);
    await judgeIdle();
    const rec = await get("/record");
    expect(rec.coverage).toEqual({ s1: 1, s2: 0.5, s3: 0.8 });
    expect(rec.dates.wrong).toBeUndefined();
    expect(rec.logs).toHaveLength(2); // 読み込み履歴は増やさない
    const st = await get("/judge");
    expect(st.last).toMatchObject({ kind: "rejudge", done: 2, total: 2, failed: [], replaced: true, passed: 3 });
    expect(st.running).toBeNull();
    expect(readdirSync(join(recordDir, "backup")).length).toBe(1);
  });

  it("読めないログがあれば、前の記録は消さずに足すだけにする", async () => {
    await fetch(`${root}/record`, { method: "POST", body: JSON.stringify({ coverage: { manual: 1 }, logs: [] }) });
    await send("bad.csv", "BAD\n");
    await judgeIdle();
    expect((await get("/judge")).last).toMatchObject({ kind: "inbox", failed: ["bad.csv: 読めないログ"] });
    await fetch(`${root}/rejudge`, { method: "POST" });
    await judgeIdle();
    const st = await get("/judge");
    expect(st.last).toMatchObject({ kind: "rejudge", done: 3, total: 3, replaced: false });
    expect(st.last.failed).toEqual(["bad.csv: 読めないログ"]);
    expect((await get("/record")).coverage.manual).toBe(1);
  });

  it("worker を止めたあとでも、また判定できる", async () => {
    await new Promise((ok) => setTimeout(ok, 50));
    await send("c.csv", "s9,1,2026-11-03\n");
    await judgeIdle();
    expect((await get("/record")).coverage.s9).toBe(1);
    expect(existsSync(dirname(process.env.RECORD_FILE))).toBe(true);
  });

  it("判定がメモリの上限を超えたら、その判定だけ失敗にして /health に出し、次のログはまた判定できる", async () => {
    await send("hog.csv", "HOG\n");
    await judgeIdle();
    const st = await get("/judge");
    expect(st.last.failed.join("\n")).toMatch(/メモリの上限\(64MB\)/);
    const h = await get("/health");
    expect(h.memory.judgeWorker).toMatchObject({ limitMB: 64, oom: { limitMB: 64 } });
    expect(h.warnings.join("\n")).toMatch(/メモリの上限\(64 MB\)を超えて止まりました/);
    await send("d.csv", "s10,1,2026-11-04\n");
    await judgeIdle();
    expect((await get("/record")).coverage.s10).toBe(1);
  }, 30_000);
});

describe("トンネルの補間", () => {
  let server;
  let root;
  beforeAll(async () => {
    server = createApp();
    await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
    root = `http://127.0.0.1:${server.address().port}/api`;
  });
  afterAll(() => server.close());

  const put = (q, body) => fetch(`${root}/rawlog?${q}`, { method: "PUT", body });
  const raw = (...p) => join(process.env.RAW_LOG_DIR, ...p);

  it("車・同乗と、線路のデータがあれば電車を自動で補う(mode のない古い記録は、車のフォルダなら車)", () => {
    expect(shouldFill("drive", { mode: "car" })).toBe(true);
    expect(shouldFill("trip", { mode: "ride" })).toBe(true);
    expect(shouldFill("trip", { mode: "train" }, false)).toBe(false);
    expect(shouldFill("trip", { mode: "train" }, true)).toBe(true);
    expect(shouldFill("trip", { mode: "plane" })).toBe(false);
    expect(shouldFill("drive", null)).toBe(true);
    expect(shouldFill("trip", {})).toBe(false);
  });

  it("生データを受け取り終えたら補い、結果を GET で返す", async () => {
    await put("session=20261109-100000&file=location.csv", "unix_s,lat,lon\n1,35,139\n2,35,139\n");
    expect(existsSync(raw("20261109-100000", "tunnel_fill.json"))).toBe(false);
    await put("session=20261109-100000&file=meta.json", JSON.stringify({ mode: "car" }));
    await judgeIdle();
    const r = await fetch(`${root}/rawlog/fill?session=20261109-100000`);
    expect(r.status).toBe(200);
    expect((await r.json()).sections[0].points).toBe(2);
  });

  it("電車は自動では補わず、POST すれば補う", async () => {
    await put("session=20261109-110000&file=location.csv&kind=trip", "unix_s,lat,lon\n1,35,139\n");
    await put("session=20261109-110000&file=meta.json&kind=trip", JSON.stringify({ mode: "train" }));
    await judgeIdle();
    expect(existsSync(raw("trips", "20261109-110000", "tunnel_fill.json"))).toBe(false);
    expect((await fetch(`${root}/rawlog/fill?session=20261109-110000&kind=trip`)).status).toBe(404);
    const r = await fetch(`${root}/rawlog/fill?session=20261109-110000&kind=trip`, { method: "POST" });
    expect(r.status).toBe(200);
    expect((await r.json()).sections[0].points).toBe(1);
    expect(existsSync(raw("trips", "20261109-110000", "tunnel_fill.json"))).toBe(true);
  });

  it("補った結果はアプリが GET で取れる(生データは取れない)", async () => {
    const get = (q) => fetch(`${root}/rawlog?${q}`);
    const r = await get("session=20261109-100000&file=tunnel_fill.json");
    expect(r.status).toBe(200);
    expect((await r.json()).sections[0].points).toBe(2);
    expect((await get("session=20261109-100000&file=location.csv")).status).toBe(403);
    expect((await get("session=20261109-100000&file=location_filled.csv")).status).toBe(404);
    expect((await get("session=..&file=tunnel_fill.json")).status).toBe(400);
  });

  it("おかしな走行IDやない走行は断る", async () => {
    expect((await fetch(`${root}/rawlog/fill?session=..`, { method: "POST" })).status).toBe(400);
    expect((await fetch(`${root}/rawlog/fill?session=a&kind=x`)).status).toBe(400);
    expect((await fetch(`${root}/rawlog/fill?session=20200101-000000`, { method: "POST" })).status).toBe(404);
  });
});

describe("trainsToFill", () => {
  it("まだ線路で補っていない・補い方の版が古い電車の記録だけ返す", () => {
    const root = mkdtempSync(join(tmpdir(), "kokudo-trains-"));
    const put = (id, mode, fill) => {
      const dir = join(root, "trips", id);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "location.csv"), "unix_s,lat,lon\n");
      writeFileSync(join(dir, "meta.json"), JSON.stringify({ mode }));
      if (fill) writeFileSync(join(dir, "tunnel_fill.json"), JSON.stringify(fill));
    };
    put("new", "train");
    put("road", "train", { source: "road", rev: 2 });
    put("old", "train", { source: "rail" });
    put("done", "train", { source: "rail", rev: 2 });
    put("bus", "ride");
    expect(trainsToFill(root).map((d) => d.split(/[\\/]/).pop()).sort()).toEqual(["new", "old", "road"]);
  });
});
