import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.WEATHER = "off";
process.env.RECORD_FILE = join(mkdtempSync(join(tmpdir(), "kokudo-")), "record.json");
process.env.LOGS_DIR = mkdtempSync(join(tmpdir(), "kokudo-logs-"));
process.env.RAW_LOG_DIR = mkdtempSync(join(tmpdir(), "kokudo-raw-"));
process.env.JUDGE_WORKER = ""; // サーバーでの判定は server/judge.test.mjs で確かめる
const { createApp, dedupeLogs, mergeRecord } = await import("./server.mjs");

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

describe("ログの走行距離", () => {
  it("同じログは上書きし、おかしな値は無視する", () => {
    const a = mergeRecord({ coverage: {}, logs: [] }, { trips: { t1: { date: "2026-10-01", m: 1000 }, t2: { date: "x" } } });
    expect(a.trips).toEqual({ t1: { date: "2026-10-01", m: 1000 } });
    expect(mergeRecord(a, { trips: { t1: { date: "2026-10-01", m: 1200 } } }).trips).toEqual({ t1: { date: "2026-10-01", m: 1200 } });
  });

  it("時刻を読み違えた 1970年の記録は捨て、正しい日付で入れ直せる", () => {
    const old = { coverage: {}, logs: [], dates: { s1: ["1970-01-01", "2024-03-01"] }, trips: { t0: { date: "1970-01-01", m: 52100 } } };
    const merged = mergeRecord(old, {
      dates: { s1: ["2024-02-04", "2024-02-04"], s2: ["1970-01-01", "1970-01-01"] },
      trips: { t1707000000000: { date: "2024-02-04", m: 52100 }, t0: { date: "1970-01-01", m: 1 } },
    });
    expect(merged.trips).toEqual({ t1707000000000: { date: "2024-02-04", m: 52100 } });
    expect(merged.dates).toEqual({ s1: ["2024-02-04", "2024-02-04"] });
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

    // 判定し直した結果で、通った区間だけを置き換える(ログの履歴は残す)
    await fetch(base, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ coverage: { a: 0.8 }, dates: { a: ["2026-10-01", "2026-10-01"] }, logs: [] }) });
    const replaced = await (await fetch(base)).json();
    expect(replaced.coverage).toEqual({ a: 0.8 });
    expect(replaced.dates).toEqual({ a: ["2026-10-01", "2026-10-01"] });
    expect(replaced.logs).toHaveLength(2);

    await fetch(base, { method: "DELETE" });
    expect(await (await fetch(base)).json()).toEqual({ coverage: {}, dates: {}, logs: [], declared: {}, trips: {} });
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
    expect(list).toContainEqual(expect.objectContaining({ id, name: "走行_1.csv" }));
    expect(await (await fetch(`${base}/${encodeURIComponent(id)}`)).text()).toBe(text);
  });

  it("ログの日付と距離を一緒に残し、あとからも付けられる", async () => {
    const { id } = await (await fetch(`${base}?name=a.gpx&date=2022-02-26&m=25712.4`, { method: "POST", body: "<gpx/>" })).json();
    const { id: old } = await (await fetch(`${base}?name=b.gpx`, { method: "POST", body: "<gpx/>" })).json();
    let list = await (await fetch(base)).json();
    expect(list.find((l) => l.id === id)).toMatchObject({ date: "2022-02-26", m: 25712 });
    expect(list.find((l) => l.id === old).date).toBeUndefined();

    const patch = (body) => fetch(`${base}/${encodeURIComponent(old)}`, { method: "PATCH", body: JSON.stringify(body) });
    expect((await patch({ date: "bad", m: 1 })).status).toBe(400);
    expect((await patch({ date: "2021-08-28", m: 59000 })).status).toBe(200);
    list = await (await fetch(base)).json();
    expect(list.find((l) => l.id === old)).toMatchObject({ date: "2021-08-28", m: 59000 });
    expect(list.some((l) => l.id === "meta.json")).toBe(false);
  });

  it("同じログをもう一度読み込んでも、新しく保存しない", async () => {
    const post = (name, body, q = "") => fetch(`${base}?name=${name}${q}`, { method: "POST", body }).then((r) => r.json());
    const { id } = await post("again.csv", "1,2,3\n");
    expect((await post("again.csv", "1,2,3\n", "&date=2025-01-02&m=10")).id).toBe(id);
    expect((await post("again.csv", "4,5,6\n")).id).not.toBe(id);
    const list = await (await fetch(base)).json();
    expect(list.filter((l) => l.name === "again.csv")).toHaveLength(2);
    expect(list.find((l) => l.id === id)).toMatchObject({ date: "2025-01-02", m: 10 });
  });

  it("前に重複して保存されたログは古いものだけ残し、ほかは duplicates に移す", async () => {
    const dir = process.env.LOGS_DIR;
    writeFileSync(join(dir, "100-dup.csv.gz"), gzipSync("a\n"));
    writeFileSync(join(dir, "200-dup.csv.gz"), gzipSync("a\n"));
    writeFileSync(join(dir, "300-dup.csv.gz"), gzipSync("b\n"));
    await fetch(`${base}/200-dup.csv.gz`, { method: "PATCH", body: JSON.stringify({ date: "2024-05-06", m: 7 }) });
    expect(dedupeLogs()).toBe(1);
    expect(existsSync(join(dir, "duplicates", "200-dup.csv.gz"))).toBe(true);
    const list = await (await fetch(base)).json();
    expect(list.filter((l) => l.name === "dup.csv").map((l) => l.id)).toEqual(["100-dup.csv.gz", "300-dup.csv.gz"]);
    // 移したログの日付と距離は、残したログに引き継ぐ
    expect(list.find((l) => l.id === "100-dup.csv.gz")).toMatchObject({ date: "2024-05-06", m: 7 });
    expect(dedupeLogs()).toBe(0);
  });

  it("ログフォルダの外は読めない", async () => {
    expect((await fetch(`${base}/..%2Frecord.json`)).status).toBe(404);
    expect((await fetch(`${base}/meta.json`)).status).toBe(404);
  });
});

describe("/api/inbox", () => {
  let server;
  let root;
  beforeAll(async () => {
    server = createApp();
    await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
    root = `http://127.0.0.1:${server.address().port}/api`;
  });
  afterAll(() => server.close());

  const send = (name, body) => fetch(`${root}/inbox?name=${encodeURIComponent(name)}`, { method: "POST", body }).then((r) => r.json());

  it("送られたログは保存され、判定するまで一覧に残る", async () => {
    const text = "#GBOWLCSV,2026-11-01 09:00:00 (30m) DriverA\nTime(sec),Latitude(deg),Longitude(deg)\n0,35,139\n";
    const { id, duplicate } = await send("2026-11-01 09_00_00 (30m) DriverA.csv", text);
    expect(duplicate).toBe(false);
    expect((await (await fetch(`${root}/inbox`)).json()).map((l) => l.id)).toEqual([id]);
    // 保存したログの一覧にも出る(あとで判定し直せる)
    expect((await (await fetch(`${root}/logs`)).json()).some((l) => l.id === id)).toBe(true);
    expect(await (await fetch(`${root}/logs/${encodeURIComponent(id)}`)).text()).toBe(text);

    // 判定する端末が一覧から外す。2台目は外せない
    const claim = () => fetch(`${root}/inbox/${encodeURIComponent(id)}`, { method: "DELETE" }).then((r) => r.json());
    expect(await claim()).toEqual({ claimed: true });
    expect(await claim()).toEqual({ claimed: false });
    expect(await (await fetch(`${root}/inbox`)).json()).toEqual([]);
  });

  it("同じログをもう一度送っても、判定し直さない", async () => {
    const first = await send("same.csv", "a,b\n1,2\n");
    await fetch(`${root}/inbox/${encodeURIComponent(first.id)}`, { method: "DELETE" });
    const again = await send("same.csv", "a,b\n1,2\n");
    expect(again).toEqual({ id: first.id, duplicate: true });
    expect(await (await fetch(`${root}/inbox`)).json()).toEqual([]);
  });

  it("空のログは受け取らない", async () => {
    expect((await fetch(`${root}/inbox?name=x.csv`, { method: "POST", body: "" })).status).toBe(400);
  });
});

describe("配信", () => {
  let server;
  let base;
  beforeAll(async () => {
    server = createApp();
    await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(() => server.close());

  it("変わっていないファイルは 304 で返し、送り直さない", async () => {
    const first = await fetch(`${base}/index.html`);
    if (first.status === 404) return; // dist がない(ビルド前)ときは確かめられない
    const etag = first.headers.get("etag");
    expect(etag).toBeTruthy();
    expect(first.headers.get("cache-control")).toBe("no-cache");
    const again = await fetch(`${base}/index.html`, { headers: { "If-None-Match": etag } });
    expect(again.status).toBe(304);
  });
});

describe("/api/rawlog", () => {
  let server;
  let root;
  beforeAll(async () => {
    server = createApp();
    await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
    root = `http://127.0.0.1:${server.address().port}/api`;
  });
  afterAll(() => server.close());

  const put = (session, file, body) =>
    fetch(`${root}/rawlog?session=${encodeURIComponent(session)}&file=${encodeURIComponent(file)}`, { method: "PUT", body });

  it("走行ごとのフォルダに保存し、送り直すと上書きする", async () => {
    expect((await put("20261107-093000", "motion.csv", "t,ax\n0,1\n")).status).toBe(200);
    expect((await put("20261107-093000", "motion.csv", "t,ax\n0,2\n")).status).toBe(200);
    expect(readFileSync(join(process.env.RAW_LOG_DIR, "20261107-093000", "motion.csv"), "utf8")).toBe("t,ax\n0,2\n");
  });

  it("車以外の移動(kind=trip)は trips フォルダの下に置く", async () => {
    const res = await fetch(`${root}/rawlog?session=20261108-161500&file=location.csv&kind=trip`, { method: "PUT", body: "a\n" });
    expect(res.status).toBe(200);
    expect((await res.json()).saved).toBe("trips/20261108-161500/location.csv");
    expect(readFileSync(join(process.env.RAW_LOG_DIR, "trips", "20261108-161500", "location.csv"), "utf8")).toBe("a\n");
    expect((await fetch(`${root}/rawlog?session=a&file=b.csv&kind=../x`, { method: "PUT", body: "a" })).status).toBe(400);
  });

  it("フォルダの外には書けない", async () => {
    expect((await put("..", "x.csv", "a")).status).toBe(400);
    expect((await put("a", "../x.csv", "a")).status).toBe(400);
    expect((await put("a", ".hidden", "a")).status).toBe(400);
  });
});

describe("運転評価", () => {
  let server;
  let base;
  beforeAll(async () => {
    server = createApp();
    await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
    base = `http://127.0.0.1:${server.address().port}/api/logs`;
  });
  afterAll(() => server.close());

  const ev = (score) => JSON.stringify({ version: 1, score, items: [], moving_s: 600, stops: 2, events: [] });
  const upload = async (name, body) => (await (await fetch(`${base}?name=${encodeURIComponent(name)}`, { method: "POST", body })).json()).id;

  it("走行フォルダの evaluation.json を返し、一覧に総合点を付ける", async () => {
    const id = await upload("20261108-002228.gpx", "<gpx>eval</gpx>");
    expect((await fetch(`${base}/${encodeURIComponent(id)}/eval`)).status).toBe(404);
    const dir = join(process.env.RAW_LOG_DIR, "20261108-002228");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "evaluation.json"), ev(59));
    const res = await fetch(`${base}/${encodeURIComponent(id)}/eval`);
    expect(res.status).toBe(200);
    expect((await res.json()).score).toBe(59);
    const list = await (await fetch(base)).json();
    expect(list.find((l) => l.id === id).score).toBe(59);
  });

  it("old に移した走行フォルダも探す", async () => {
    const id = await upload("20261101-120000.gpx", "<gpx>old</gpx>");
    const dir = join(process.env.RAW_LOG_DIR, "old", "20261101-120000");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "evaluation.json"), ev(72.5));
    expect((await (await fetch(`${base}/${encodeURIComponent(id)}/eval`)).json()).score).toBe(72.5);
  });

  it("GBowl のログは evals フォルダの評価を使う", async () => {
    const id = await upload("2026-10-24_11-21-05.csv", "a,b\n3,4\n");
    mkdirSync(join(process.env.RAW_LOG_DIR, "evals"), { recursive: true });
    writeFileSync(join(process.env.RAW_LOG_DIR, "evals", "2026-10-24_11-21-05.json"), ev(73.1));
    expect((await (await fetch(`${base}/${encodeURIComponent(id)}/eval`)).json()).score).toBe(73.1);
  });

  it("評価のないログには点数を付けない", async () => {
    const id = await upload("2026-11-01_12-00-00.csv", "a,b\n1,2\n");
    expect((await fetch(`${base}/${encodeURIComponent(id)}/eval`)).status).toBe(404);
    const list = await (await fetch(base)).json();
    expect(list.find((l) => l.id === id).score).toBeUndefined();
  });
});

describe("GET /api/trips", () => {
  it("trips フォルダの電車などの移動を線にして返す", async () => {
    const dir = join(process.env.RAW_LOG_DIR, "trips", "20261109-090000");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "meta.json"), JSON.stringify({ mode: "train", start: "2026-11-09T00:00:00.000Z" }));
    writeFileSync(join(dir, "location.csv"), "unix_s,lat,lon,h_acc_m\n0,35,139,10\n60,35,139.01,10\n");
    const app = createApp().listen(0);
    await new Promise((ok) => app.once("listening", ok));
    try {
      const r = await fetch(`http://localhost:${app.address().port}/api/trips`);
      expect(r.status).toBe(200);
      const { trips } = await r.json();
      expect(trips).toHaveLength(1);
      expect(trips[0]).toMatchObject({ id: "20261109-090000", mode: "train", lines: [[[139, 35], [139.01, 35]]] });
    } finally {
      app.close();
    }
  });
});

describe("旅行(/api/journeys)", () => {
  it("足す・同じ期間は名前を付け直す・逆の日付は入れ替える・消す", async () => {
    const app = createApp().listen(0);
    await new Promise((ok) => app.once("listening", ok));
    const base = `http://localhost:${app.address().port}/api/journeys`;
    try {
      const post = (b) => fetch(base, { method: "POST", body: JSON.stringify(b) });
      expect((await post({ name: "", from: "2026-11-07", to: "2026-11-10" })).status).toBe(400);
      let list = await (await post({ name: "九州", from: "2026-11-10", to: "2026-11-07" })).json();
      expect(list).toMatchObject([{ name: "九州", from: "2026-11-07", to: "2026-11-10" }]);
      list = await (await post({ name: "北海道", from: "2026-12-01", to: "2026-12-03" })).json();
      list = await (await post({ name: "九州旅行", from: "2026-11-07", to: "2026-11-10" })).json();
      expect(list.map((j) => j.name)).toEqual(["北海道", "九州旅行"]);
      list = await (await fetch(`${base}/${list[0].id}`, { method: "DELETE" })).json();
      expect((await (await fetch(base)).json()).map((j) => j.name)).toEqual(["九州旅行"]);
    } finally {
      app.close();
    }
  });
});

describe("旅行から外す(PATCH /api/journeys/<id>)", () => {
  it("外すものを置き換え、名前を付け直しても残る", async () => {
    const app = createApp().listen(0);
    await new Promise((ok) => app.once("listening", ok));
    const base = `http://localhost:${app.address().port}/api/journeys`;
    try {
      const list = await (await fetch(base, { method: "POST", body: JSON.stringify({ name: "四国", from: "2027-01-01", to: "2027-01-03" }) })).json();
      const j = list.find((x) => x.name === "四国");
      expect(j.exclude).toEqual([]);
      const r = await fetch(`${base}/${j.id}`, { method: "PATCH", body: JSON.stringify({ exclude: ["log:1-a.gz", "trip:t1", "log:1-a.gz", "bad", 3] }) });
      expect((await r.json()).find((x) => x.id === j.id).exclude).toEqual(["log:1-a.gz", "trip:t1"]);
      const renamed = await (await fetch(base, { method: "POST", body: JSON.stringify({ name: "四国旅行", from: "2027-01-01", to: "2027-01-03" }) })).json();
      expect(renamed.find((x) => x.id === j.id)).toMatchObject({ name: "四国旅行", exclude: ["log:1-a.gz", "trip:t1"] });
      expect((await fetch(`${base}/none`, { method: "PATCH", body: "{}" })).status).toBe(404);
    } finally {
      app.close();
    }
  });
});

describe("移動手段を直す(/api/rawlog/mode)", () => {
  let server;
  let root;
  beforeAll(async () => {
    server = createApp();
    await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
    root = `http://127.0.0.1:${server.address().port}/api`;
  });
  afterAll(() => server.close());

  const RAW = () => process.env.RAW_LOG_DIR;
  const csv =
    "unix_s,lat,lon,alt_m,h_acc_m,v_acc_m,speed_ms,speed_acc_ms,course_deg,course_acc_deg,floor,speed_est_ms\n" +
    "1762900000.000,35.6000000,139.7000000,10.00,5.0,3.0,10.00,0.5,90.0,5.0,,\n" +
    "1762900001.000,35.6001000,139.7001000,10.00,80.0,3.0,10.00,0.5,90.0,5.0,,\n" +
    "1762900002.000,35.6002000,139.7002000,,5.0,,,,,,,\n";
  const mode = (session, m) => fetch(`${root}/rawlog/mode?session=${session}&mode=${m}`, { method: "POST" });
  const logsOf = async (session) => (await (await fetch(`${root}/logs`)).json()).filter((l) => l.name === `${session}.gpx`);

  it("location.csv から精度のよい点だけで GPX を作る", async () => {
    const { gpxFromLocationCsv } = await import("./server.mjs");
    const { gpx, points } = gpxFromLocationCsv(csv, "x");
    expect(points).toBe(2);
    expect(gpx).toContain('<trkpt lat="35.6000000" lon="139.7000000"><ele>10.0</ele><time>2025-11-11T22:26:40.000Z</time><extensions><speed>10.00</speed></extensions></trkpt>');
    expect(gpx).toContain('<trkpt lat="35.6002000" lon="139.7002000"><time>2025-11-11T22:26:42.000Z</time></trkpt>');
  });

  it("電車で記録したものを車に直すと、車のフォルダに移して地図のログを作り、判定待ちにする", async () => {
    const s = "20261111-090000";
    const dir = join(RAW(), "trips", s);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "location.csv"), csv);
    writeFileSync(join(dir, "meta.json"), JSON.stringify({ id: s, mode: "train" }));
    writeFileSync(join(dir, "location_filled.csv"), "x");
    expect(await (await fetch(`${root}/rawlog/mode?session=${s}`)).json()).toEqual({ session: s, mode: "train", kind: "trip", sent: true });

    const r = await (await mode(s, "car")).json();
    expect(r).toMatchObject({ session: s, mode: "car", from: "train", kind: "drive", moved: true, gpx: true, removed: 0, rejudge: null });
    expect(existsSync(dir)).toBe(false);
    expect(JSON.parse(readFileSync(join(RAW(), s, "meta.json"), "utf8")).mode).toBe("car");
    expect(existsSync(join(RAW(), s, "location_filled.csv"))).toBe(false); // 線路で補ったものは捨てる
    const logs = await logsOf(s);
    expect(logs).toHaveLength(1);
    expect((await (await fetch(`${root}/inbox`)).json()).map((l) => l.id)).toContain(logs[0].id);

    // アプリがあとから同じ走行の GPX を送っても、二重に保存しない
    const again = await (await fetch(`${root}/inbox?name=${s}.gpx`, { method: "POST", body: "<gpx/>" })).json();
    expect(again).toEqual({ id: logs[0].id, duplicate: true });
  });

  it("車で記録したものを電車に直すと、trips に移して地図のログを判定から外す(消さずに removed へ)", async () => {
    const s = "20261111-100000";
    const dir = join(RAW(), s);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "location.csv"), csv);
    writeFileSync(join(dir, "meta.json"), JSON.stringify({ id: s, mode: "car" }));
    const { id } = await (await fetch(`${root}/inbox?name=${s}.gpx`, { method: "POST", body: "<trkpt lat=\"35\" lon=\"139\"><time>2026-11-11T01:00:00Z</time></trkpt>" })).json();
    await fetch(`${root}/record`, { method: "POST", body: JSON.stringify({ trips: { t1794358800000: { date: "2026-11-11", m: 100 } } }) });

    const r = await (await mode(s, "train")).json();
    expect(r).toMatchObject({ mode: "train", from: "car", kind: "trip", moved: true, gpx: false, removed: 1, rejudge: "browser" });
    expect(JSON.parse(readFileSync(join(RAW(), "trips", s, "meta.json"), "utf8")).mode).toBe("train");
    expect(await logsOf(s)).toEqual([]);
    expect(existsSync(join(process.env.LOGS_DIR, "removed", id))).toBe(true);
    expect((await (await fetch(`${root}/inbox`)).json()).map((l) => l.id)).not.toContain(id);
    expect((await (await fetch(`${root}/record`)).json()).trips.t1794358800000).toBeUndefined();
    // 車以外にした走行の GPX が届いても、地図には入れない
    expect(await (await fetch(`${root}/inbox?name=${s}.gpx`, { method: "POST", body: "<gpx/>" })).json()).toMatchObject({ id: null, ignored: "trip" });

    // 車に戻すと、外したログを戻して判定し直す
    const back = await (await mode(s, "car")).json();
    expect(back).toMatchObject({ mode: "car", from: "train", moved: true, gpx: true });
    expect((await logsOf(s)).map((l) => l.id)).toEqual([id]);
  });

  it("同乗⇔その他など車以外どうしは、フォルダを移さず meta.json だけ直す", async () => {
    const s = "20261111-110000";
    const dir = join(RAW(), "trips", s);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "meta.json"), JSON.stringify({ id: s, mode: "ride" }));
    expect(await (await mode(s, "other")).json()).toMatchObject({ moved: false, from: "ride", kind: "trip" });
    expect(JSON.parse(readFileSync(join(dir, "meta.json"), "utf8")).mode).toBe("other");
  });

  it("ない走行は 404、おかしな値は 400", async () => {
    expect((await mode("20000101-000000", "car")).status).toBe(404);
    expect((await mode("20261111-110000", "bike")).status).toBe(400);
    expect((await mode("../x", "car")).status).toBe(400);
  });
});

describe("走行を忘れる(DELETE /api/rawlog/session)", () => {
  let server;
  let root;
  beforeAll(async () => {
    server = createApp();
    await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
    root = `http://127.0.0.1:${server.address().port}/api`;
  });
  afterAll(() => server.close());

  it("走行フォルダを replaced に移し、地図のログを判定から外す。そのあと同じ走行を送り直せる", async () => {
    const s = "20261109-222555";
    const dir = join(process.env.RAW_LOG_DIR, s);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "meta.json"), JSON.stringify({ id: s, mode: "car" }));
    const { id } = await (await fetch(`${root}/inbox?name=${s}.gpx`, { method: "POST", body: "<trkpt lat=\"35\" lon=\"139\"><time>2026-11-09T13:26:00Z</time></trkpt>" })).json();
    const r = await (await fetch(`${root}/rawlog/session?session=${s}`, { method: "DELETE" })).json();
    expect(r).toMatchObject({ session: s, moved: true, removed: 1, rejudge: "browser" });
    expect(existsSync(dir)).toBe(false);
    expect(existsSync(join(process.env.LOGS_DIR, "replaced", id))).toBe(true);
    const again = await (await fetch(`${root}/inbox?name=${s}.gpx`, { method: "POST", body: "<trkpt lat=\"35\" lon=\"139\"><time>2026-11-09T13:26:00Z</time></trkpt><x/>" })).json();
    expect(again.duplicate).toBe(false);
    expect((await fetch(`${root}/rawlog/session?session=20000101-000000`, { method: "DELETE" })).status).toBe(404);
  });
});
