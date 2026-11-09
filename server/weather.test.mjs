import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fetchWeather, parseLocationCsv, sampleTrack, summarize, weatherUrl } from "./weather.mjs";

// Open-Meteo の代わり。地点ごとに、0時(UTC)から1時間ごとの値を返す。気温は「時」+10℃、10時(UTC)だけ雨
const calls = [];
let failNext = false;
function fakeBody(url) {
  const q = new URL(url, "http://x").searchParams;
  const lats = q.get("latitude").split(",");
  const start = Date.parse(`${q.get("start_date")}T00:00:00Z`) / 1000;
  const end = Date.parse(`${q.get("end_date")}T23:00:00Z`) / 1000;
  const time = [];
  for (let t = start; t <= end; t += 3600) time.push(t);
  const hour = (t) => new Date(t * 1000).getUTCHours();
  const one = () => ({
    hourly: {
      time,
      temperature_2m: time.map((t) => hour(t) + 10),
      apparent_temperature: time.map((t) => hour(t) + 8),
      relative_humidity_2m: time.map(() => 70),
      precipitation: time.map((t) => (hour(t) === 10 ? 2.5 : 0)),
      snowfall: time.map(() => 0),
      weather_code: time.map((t) => (hour(t) === 10 ? 63 : 3)),
      cloud_cover: time.map(() => 90),
      pressure_msl: time.map(() => 1012),
      wind_speed_10m: time.map(() => 3),
      wind_direction_10m: time.map(() => 180),
      wind_gusts_10m: time.map(() => 6),
      is_day: time.map((t) => (hour(t) < 9 ? 1 : 0)),
    },
    daily: { time: [start, start + 86400, start + 2 * 86400], sunrise: [0, 1, 2].map((d) => start + d * 86400 + 21600), sunset: [0, 1, 2].map((d) => start + d * 86400 + 61200) },
  });
  return lats.length === 1 ? one() : lats.map(one);
}
const fakeFetch = async (url) => {
  calls.push(url);
  return { ok: true, json: async () => fakeBody(url), text: async () => "" };
};

// 2026-11-09 08:00〜10:30(UTC)。東京から北へ 1分ごと 約1km
const T0 = Date.parse("2026-11-09T08:00:00Z") / 1000;
const track = Array.from({ length: 151 }, (_, i) => ({ t: T0 + i * 60, lat: 35.6 + i * 0.009, lon: 139.7 }));
const NOW = Date.parse("2026-11-09T12:00:00Z");

describe("天気を調べる点", () => {
  it("最初と最後、間は30分か30kmごと", () => {
    const s = sampleTrack(track);
    expect(s[0].t).toBe(T0);
    expect(s.at(-1).t).toBe(T0 + 150 * 60);
    // 1km/分なので 30km(約30分)ごと → 0,30,60,90,120,150 分あたり
    expect(s.length).toBeGreaterThanOrEqual(5);
    expect(s.length).toBeLessThanOrEqual(7);
  });

  it("多すぎる点は48まで間引く", () => {
    const long = Array.from({ length: 3000 }, (_, i) => ({ t: T0 + i * 600, lat: 35, lon: 139 }));
    expect(sampleTrack(long)).toHaveLength(48);
  });

  it("location.csv を読み、精度の悪い点は使わない", () => {
    const csv = "unix_s,lat,lon,alt_m,h_acc_m\n10,35,139,1,5\n5,35.1,139.1,1,1000\n1,35.2,139.2,1,\n";
    expect(parseLocationCsv(csv)).toEqual([
      { t: 1, lat: 35.2, lon: 139.2 },
      { t: 10, lat: 35, lon: 139 },
    ]);
  });

  it("3か月より古い走行は過去データ API で取る", () => {
    expect(weatherUrl([{ t: T0, lat: 35, lon: 139 }], NOW).api).toBe("forecast");
    expect(weatherUrl([{ t: T0, lat: 35, lon: 139 }], NOW + 200 * 86400_000).api).toBe("archive");
  });
});

describe("天気を取る", () => {
  it("地点ごとの天気と、まとめ(雨に当たれば雨)を作る", async () => {
    const w = await fetchWeather(track, { fetchImpl: fakeFetch, now: NOW });
    expect(w.api).toBe("forecast");
    expect(w.samples[0]).toMatchObject({ t: T0, code: 3, label: "くもり", temp: 18, isDay: true, wind: 3 });
    // 降水量は「その時刻までの1時間」の量なので、10時(UTC)の雨は 9時台の点に付く
    const rainy = w.samples.find((s) => s.precip > 0);
    expect(rainy.t).toBeGreaterThanOrEqual(T0 + 60 * 60);
    expect(rainy.t).toBeLessThanOrEqual(T0 + 120 * 60);
    expect(w.summary).toMatchObject({ rain: true, precipMax: 2.5, night: true, windMax: 3, sunrise: Date.parse("2026-11-09T06:00:00Z") / 1000 });
    expect(w.summary.tMin).toBe(18);
    expect(w.summary.tMax).toBe(20.5);
    expect(w.summary.label).toBe("雨");
  });

  it("降っていなければ、いちばん多かった天気", () => {
    const s = summarize([{ code: 1 }, { code: 3 }, { code: 3 }].map((x) => ({ ...x, temp: 10, precip: 0 })));
    expect(s).toMatchObject({ code: 3, label: "くもり", rain: false });
  });
});

// サーバーに組み込んだ動き
process.env.WEATHER = "on";
process.env.RECORD_FILE = join(mkdtempSync(join(tmpdir(), "kokudo-wx-")), "record.json");
process.env.LOGS_DIR = mkdtempSync(join(tmpdir(), "kokudo-wx-logs-"));
process.env.RAW_LOG_DIR = mkdtempSync(join(tmpdir(), "kokudo-wx-raw-"));
process.env.JUDGE_WORKER = "";
const { createApp, weatherIdle, weatherMissingDirs, retryWeather } = await import("./server.mjs");

describe("サーバーでの天気", () => {
  let app;
  let meteo;
  let root;
  const raw = (...p) => join(process.env.RAW_LOG_DIR, ...p);
  beforeAll(async () => {
    meteo = createServer((req, res) => {
      calls.push(req.url);
      if (failNext) {
        failNext = false;
        res.writeHead(503);
        return res.end("busy");
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(fakeBody(req.url)));
    });
    await new Promise((ok) => meteo.listen(0, "127.0.0.1", ok));
    process.env.WEATHER_FORECAST_URL = `http://127.0.0.1:${meteo.address().port}/v1/forecast`;
    process.env.WEATHER_ARCHIVE_URL = `http://127.0.0.1:${meteo.address().port}/v1/archive`;
    app = createApp();
    await new Promise((ok) => app.listen(0, "127.0.0.1", ok));
    root = `http://127.0.0.1:${app.address().port}/api`;
  });
  afterAll(() => {
    app.close();
    meteo.close();
  });

  const csv = "unix_s,lat,lon,h_acc_m\n" + track.map((p) => `${p.t},${p.lat},${p.lon},5`).join("\n") + "\n";
  const put = (q, body) => fetch(`${root}/rawlog?${q}`, { method: "PUT", body });

  it("生データを受け取り終えたら天気を取り、アプリが GET で取れる", async () => {
    await put("session=20261109-170000&file=location.csv", csv);
    await put("session=20261109-170000&file=meta.json", JSON.stringify({ mode: "car" }));
    await weatherIdle();
    expect(existsSync(raw("20261109-170000", "weather.json"))).toBe(true);
    const r = await fetch(`${root}/rawlog?session=20261109-170000&file=weather.json`);
    expect(r.status).toBe(200);
    expect((await r.json()).summary.label).toBe("雨");
    expect((await fetch(`${root}/rawlog/weather?session=20261109-170000`)).status).toBe(200);
  });

  it("飛行機は取らない。取れなかった走行は残して、あとで取り直す", async () => {
    await put("session=20261109-180000&file=location.csv&kind=trip", csv);
    await put("session=20261109-180000&file=meta.json&kind=trip", JSON.stringify({ mode: "plane" }));
    await weatherIdle();
    expect(existsSync(raw("trips", "20261109-180000", "weather.json"))).toBe(false);

    failNext = true;
    await put("session=20261109-190000&file=location.csv&kind=trip", csv);
    await put("session=20261109-190000&file=meta.json&kind=trip", JSON.stringify({ mode: "train" }));
    await weatherIdle();
    expect(existsSync(raw("trips", "20261109-190000", "weather.json"))).toBe(false);
    const pending = JSON.parse(readFileSync(join(process.env.RECORD_FILE, "..", "weather_pending.json"), "utf8"));
    expect(pending.map((p) => p.dir)).toEqual([raw("trips", "20261109-190000")]);
    expect(retryWeather()).toBe(1);
    await weatherIdle();
    expect(existsSync(raw("trips", "20261109-190000", "weather.json"))).toBe(true);
    expect(JSON.parse(readFileSync(join(process.env.RECORD_FILE, "..", "weather_pending.json"), "utf8"))).toEqual([]);
  });

  it("前からある走行フォルダで天気のないものを見つける", () => {
    mkdirSync(raw("old", "20261001-090000"), { recursive: true });
    writeFileSync(raw("old", "20261001-090000", "location.csv"), csv);
    writeFileSync(raw("old", "20261001-090000", "meta.json"), "{}");
    expect(weatherMissingDirs()).toEqual([raw("old", "20261001-090000")]);
  });

  it("地図のログ一覧に天気が付き、iPhone 以外のログはブラウザが送った点で取る", async () => {
    mkdirSync(process.env.LOGS_DIR, { recursive: true });
    writeFileSync(join(process.env.LOGS_DIR, "1-20261109-170000.gpx.gz"), gzipSync("x"));
    writeFileSync(join(process.env.LOGS_DIR, "2-gopro.csv.gz"), gzipSync("y"));
    const list = await (await fetch(`${root}/logs`)).json();
    expect(list.find((l) => l.name === "20261109-170000.gpx").weather).toMatchObject({ label: "雨", icon: "🌧️" });
    expect(list.find((l) => l.name === "gopro.csv").weather).toBeUndefined();

    expect((await fetch(`${root}/logs/2-gopro.csv.gz/weather`)).status).toBe(404);
    const points = track.map((p) => [p.t, p.lat, p.lon]);
    const r = await fetch(`${root}/logs/2-gopro.csv.gz/weather`, { method: "POST", body: JSON.stringify({ points }) });
    expect(r.status).toBe(200);
    expect(existsSync(raw("weather", "gopro.json"))).toBe(true);
    expect((await fetch(`${root}/logs/2-gopro.csv.gz/weather`)).status).toBe(200);
    expect((await fetch(`${root}/logs/2-gopro.csv.gz/weather`, { method: "POST", body: "{}" })).status).toBe(400);
    expect((await fetch(`${root}/logs/nope.gz/weather`)).status).toBe(404);
  });
});
