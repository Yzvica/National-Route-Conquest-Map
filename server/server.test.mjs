import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.RECORD_FILE = join(mkdtempSync(join(tmpdir(), "kokudo-")), "record.json");
process.env.LOGS_DIR = mkdtempSync(join(tmpdir(), "kokudo-logs-"));
const { createApp, mergeRecord } = await import("./server.mjs");

describe("mergeRecord", () => {
  it("区間ごとに大きい方を残し、ログは足す", () => {
    const merged = mergeRecord(
      { coverage: { a: 1, b: 0.3 }, logs: [{ name: "x" }] },
      { coverage: { b: 0.6, c: 0.2, a: 0.5 }, logs: [{ name: "y" }] },
    );
    expect(merged.coverage).toEqual({ a: 1, b: 0.6, c: 0.2 });
    expect(merged.logs.map((l) => l.name)).toEqual(["x", "y"]);
  });

  it("通った日は最初と最後を広げ、日付のない古い記録とも混ぜられる", () => {
    const merged = mergeRecord(
      { coverage: { a: 1 }, logs: [] },
      { coverage: { a: 1 }, dates: { a: ["2026-05-01", "2026-05-01"] }, logs: [] },
    );
    expect(merged.dates).toEqual({ a: ["2026-05-01", "2026-05-01"] });
    const again = mergeRecord(merged, {
      coverage: {},
      dates: { a: ["2026-03-10", "2026-03-10"], b: ["2026-09-01", "2026-09-01"], c: "bad" },
      logs: [],
    });
    expect(again.dates).toEqual({ a: ["2026-03-10", "2026-05-01"], b: ["2026-09-01", "2026-09-01"] });
  });
});

describe("点線国道の自己申告", () => {
  it("申告した時刻が新しい方を残し、取り消しもできる", () => {
    const on = mergeRecord({ coverage: {}, logs: [] }, { declared: { 339: { on: true, at: "2026-10-31T10:00:00Z" } } });
    expect(on.declared).toEqual({ 339: { on: true, at: "2026-10-31T10:00:00Z" } });
    const off = mergeRecord(on, { declared: { 339: { on: false, at: "2026-10-31T11:00:00Z" }, 1: "bad" } });
    expect(off.declared).toEqual({ 339: { on: false, at: "2026-10-31T11:00:00Z" } });
    // 古い申告は無視する
    expect(mergeRecord(off, { declared: { 339: { on: true, at: "2026-10-30T00:00:00Z" } } }).declared[339].on).toBe(false);
  });
});

describe("/api/record", () => {
  let server;
  let base;
  beforeAll(async () => {
    server = createApp();
    await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
    base = `http://127.0.0.1:${server.address().port}/api/record`;
  });
  afterAll(() => server.close());

  it("2台の端末から足した記録が両方残る", async () => {
    const post = (body) =>
      fetch(base, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    await post({ coverage: { a: 1 }, logs: [{ name: "pc.csv" }] });
    await post({ coverage: { b: 0.5 }, logs: [{ name: "phone.csv" }] });
    const rec = await (await fetch(base)).json();
    expect(rec.coverage).toEqual({ a: 1, b: 0.5 });
    expect(rec.logs).toHaveLength(2);

    await fetch(base, { method: "DELETE" });
    expect(await (await fetch(base)).json()).toEqual({ coverage: {}, dates: {}, logs: [], declared: {} });
  });
});

describe("/api/logs", () => {
  let server;
  let base;
  beforeAll(async () => {
    server = createApp();
    await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
    base = `http://127.0.0.1:${server.address().port}/api/logs`;
  });
  afterAll(() => server.close());

  it("保存したログを一覧から取り出せる", async () => {
    const text = "#GBOWLCSV,2026-09-19 20:05:37\nTime(sec),Latitude(deg),Longitude(deg)\n0,35,139\n";
    const { id } = await (await fetch(`${base}?name=${encodeURIComponent("走行 1.csv")}`, { method: "POST", body: text })).json();
    const list = await (await fetch(base)).json();
    expect(list).toEqual([expect.objectContaining({ id, name: "走行_1.csv" })]);
    expect(await (await fetch(`${base}/${encodeURIComponent(id)}`)).text()).toBe(text);
  });

  it("ログフォルダの外は読めない", async () => {
    expect((await fetch(`${base}/..%2Frecord.json`)).status).toBe(404);
  });
});
