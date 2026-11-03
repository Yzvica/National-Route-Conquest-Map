import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const recordDir = mkdtempSync(join(tmpdir(), "kokudo-judge-"));
process.env.RECORD_FILE = join(recordDir, "record.json");
process.env.LOGS_DIR = mkdtempSync(join(tmpdir(), "kokudo-judge-logs-"));
process.env.JUDGE_WORKER = join(import.meta.dirname, "__fixtures__", "fakeJudgeWorker.mjs");
process.env.JUDGE_DATA_DIR = mkdtempSync(join(tmpdir(), "kokudo-judge-data-"));
process.env.JUDGE_IDLE_MS = "10";
writeFileSync(join(process.env.JUDGE_DATA_DIR, "routes.json"), "{}");
const { createApp, judgeIdle } = await import("./server.mjs");

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
});
