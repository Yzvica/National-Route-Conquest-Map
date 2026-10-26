import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.RECORD_FILE = join(mkdtempSync(join(tmpdir(), "kokudo-")), "record.json");
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
    expect(await (await fetch(base)).json()).toEqual({ coverage: {}, logs: [] });
  });
});
