// Google マップ(Map Tiles API の 2D タイル)を背景の地図に使うための中継。
// API キーはリポジトリに入れず、MiniPC の data/google-maps.json(または環境変数 GOOGLE_MAPS_API_KEY)に置く。
// ブラウザにはキーを渡さず、タイルはこのサーバーが取って渡す。保存(キャッシュ)はしない(Google の規約で禁止)。
// 無料枠(2D Map Tiles は月 10 万回)を超えないよう、1日・1か月の回数に上限を設けて、超えたらタイルを返さない。
//
// ナビのリンクの確かめ(Routes API の Compute Routes)も中継する。Essentials の使い方(経由地10個まで・渋滞を見ない)だけにして、
// 無料枠(月 1 万回)を超えないよう、タイルとは別に 1日・1か月の上限を設ける。
//
// data/google-maps.json の例:
//   { "key": "AIza...", "dailyLimit": 3000, "monthlyLimit": 90000, "routesDailyLimit": 100, "routesMonthlyLimit": 3000 }
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const TYPES = { roadmap: "roadmap", satellite: "satellite" };
const DEFAULT_DAILY = 3000;
const DEFAULT_MONTHLY = 90000;
const API = "https://tile.googleapis.com";
const DEFAULT_ROUTES_DAILY = 100;
const DEFAULT_ROUTES_MONTHLY = 3000;
const ROUTES_API = "https://routes.googleapis.com/directions/v2:computeRoutes";

export function createGmaps(dataDir) {
  const configPath = join(dataDir, "google-maps.json");
  const usagePath = join(dataDir, "google-maps-usage.json");
  let config = {
    key: "",
    dailyLimit: DEFAULT_DAILY,
    monthlyLimit: DEFAULT_MONTHLY,
    routesDailyLimit: DEFAULT_ROUTES_DAILY,
    routesMonthlyLimit: DEFAULT_ROUTES_MONTHLY,
  };
  let configMtime = -1;
  /** 種類ごとのセッション { token, expiry(ms) } */
  const sessions = {};
  const pendingSession = {};

  // 設定ファイルは変わっていたら読み直す(キーを置いたあと再起動しなくても使えるように)
  function loadConfig() {
    const envKey = process.env.GOOGLE_MAPS_API_KEY ?? "";
    let mtime = 0;
    try {
      mtime = existsSync(configPath) ? statSync(configPath).mtimeMs : 0;
    } catch {
      mtime = 0;
    }
    if (mtime !== configMtime) {
      configMtime = mtime;
      let file = {};
      if (mtime) {
        try {
          // メモ帳で保存すると先頭に BOM が付くことがある
          file = JSON.parse(readFileSync(configPath, "utf8").replace(/^﻿/, ""));
        } catch (e) {
          console.error(`data/google-maps.json を読めません: ${e.message}`);
        }
      }
      const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : d);
      config = {
        key: String(file.key ?? "").trim(),
        dailyLimit: num(file.dailyLimit, DEFAULT_DAILY),
        monthlyLimit: num(file.monthlyLimit, DEFAULT_MONTHLY),
        routesDailyLimit: num(file.routesDailyLimit, DEFAULT_ROUTES_DAILY),
        routesMonthlyLimit: num(file.routesMonthlyLimit, DEFAULT_ROUTES_MONTHLY),
      };
      for (const t of Object.keys(sessions)) delete sessions[t];
    }
    if (!config.key && envKey) config = { ...config, key: envKey.trim() };
    return config;
  }

  // 使った回数(日本時間の日付・月ごと)
  const jstDay = () => new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
  let usage = { day: "", dayCount: 0, month: "", monthCount: 0, routesDay: "", routesDayCount: 0, routesMonth: "", routesMonthCount: 0 };
  try {
    if (existsSync(usagePath)) usage = { ...usage, ...JSON.parse(readFileSync(usagePath, "utf8")) };
  } catch {
    // 壊れていたら 0 から数える
  }
  let saveTimer = null;
  function rollUsage() {
    const day = jstDay();
    if (usage.day !== day) usage = { ...usage, day, dayCount: 0 };
    if (usage.month !== day.slice(0, 7)) usage = { ...usage, month: day.slice(0, 7), monthCount: 0 };
    if (usage.routesDay !== day) usage = { ...usage, routesDay: day, routesDayCount: 0 };
    if (usage.routesMonth !== day.slice(0, 7)) usage = { ...usage, routesMonth: day.slice(0, 7), routesMonthCount: 0 };
  }
  function countOne() {
    rollUsage();
    usage.dayCount++;
    usage.monthCount++;
    scheduleSave();
  }
  function countRoute() {
    rollUsage();
    usage.routesDayCount++;
    usage.routesMonthCount++;
    scheduleSave();
  }
  function routesOverLimit() {
    rollUsage();
    return usage.routesDayCount >= config.routesDailyLimit || usage.routesMonthCount >= config.routesMonthlyLimit;
  }
  function scheduleSave() {
    if (!saveTimer) {
      saveTimer = setTimeout(() => {
        saveTimer = null;
        try {
          writeFileSync(usagePath, JSON.stringify(usage));
        } catch (e) {
          console.error(`Google マップの回数を保存できません: ${e.message}`);
        }
      }, 5000);
      saveTimer.unref?.();
    }
  }
  function overLimit() {
    rollUsage();
    return usage.dayCount >= config.dailyLimit || usage.monthCount >= config.monthlyLimit;
  }

  async function createSession(type) {
    const res = await fetch(`${API}/v1/createSession?key=${encodeURIComponent(config.key)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mapType: TYPES[type],
        language: "ja-JP",
        region: "JP",
        // Retina でもにじまないよう 2 倍の解像度で取る(タイルの数は同じ)
        scale: "scaleFactor2x",
        highDpi: true,
      }),
    });
    if (!res.ok) throw new Error(`createSession ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const body = await res.json();
    // 期限(約2週間)の1時間前には取り直す
    return { token: body.session, expiry: Number(body.expiry) * 1000 - 3600_000 };
  }

  async function session(type, renew = false) {
    const s = sessions[type];
    if (!renew && s && s.expiry > Date.now()) return s.token;
    pendingSession[type] ??= createSession(type).finally(() => delete pendingSession[type]);
    sessions[type] = await pendingSession[type];
    return sessions[type].token;
  }

  function status() {
    loadConfig();
    rollUsage();
    return {
      enabled: !!config.key,
      today: usage.dayCount,
      month: usage.monthCount,
      dailyLimit: config.dailyLimit,
      monthlyLimit: config.monthlyLimit,
      overLimit: overLimit(),
      routes: {
        today: usage.routesDayCount,
        month: usage.routesMonthCount,
        dailyLimit: config.routesDailyLimit,
        monthlyLimit: config.routesMonthlyLimit,
        overLimit: routesOverLimit(),
      },
    };
  }

  /**
   * /api/gmaps/route: 出発・経由地(9個まで)・目的地を Google の Compute Routes に問い合わせて、道の長さと線を返す。
   * body: { origin: {lat, lon}, destination: {lat, lon}, waypoints: [{lat, lon}, ...] }
   * 返すもの: { distance(m), duration(秒), polyline(encoded) } か { error }
   */
  async function route(body) {
    loadConfig();
    if (!config.key) return [404, { error: "Google マップのキー(data/google-maps.json)がありません" }];
    const pt = (p) => {
      const lat = Number(p?.lat);
      const lon = Number(p?.lon);
      return Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? { lat, lon } : null;
    };
    const origin = pt(body?.origin);
    const dest = pt(body?.destination);
    const ways = Array.isArray(body?.waypoints) ? body.waypoints.map(pt) : [];
    // 経由地が10個を超えると高い料金(Pro)になるので受け付けない
    if (!origin || !dest || ways.some((w) => !w) || ways.length > 9) return [400, { error: "bad request" }];
    if (routesOverLimit())
      return [429, { error: `Google への問い合わせが上限(1日 ${config.routesDailyLimit} 回・1か月 ${config.routesMonthlyLimit} 回)に達しました` }];
    const loc = (p) => ({ location: { latLng: { latitude: p.lat, longitude: p.lon } } });
    countRoute();
    const res = await fetch(ROUTES_API, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": config.key,
        "X-Goog-FieldMask": "routes.distanceMeters,routes.duration,routes.polyline.encodedPolyline",
      },
      body: JSON.stringify({
        origin: loc(origin),
        destination: loc(dest),
        intermediates: ways.map(loc),
        travelMode: "DRIVE",
        // 渋滞を見ると高い料金(Pro)になる。道の選び方を見たいだけなので見ない
        routingPreference: "TRAFFIC_UNAWARE",
        polylineQuality: "HIGH_QUALITY",
        languageCode: "ja",
        regionCode: "JP",
      }),
    });
    const text = await res.text();
    if (!res.ok) {
      console.error(`Google Routes API: ${res.status} ${text.slice(0, 300)}`);
      const hint = res.status === 403 ? "(Google Cloud のコンソールで、このキーに Routes API を有効にしてください)" : "";
      return [502, { error: `Google の応答 ${res.status}${hint}` }];
    }
    const r = JSON.parse(text).routes?.[0];
    if (!r) return [200, { error: "Google が道を見つけられませんでした" }];
    return [200, { distance: Number(r.distanceMeters ?? 0), duration: parseInt(String(r.duration ?? "0"), 10) || 0, polyline: r.polyline?.encodedPolyline ?? "" }];
  }

  /** /api/gmaps/tile/<type>/<z>/<x>/<y> */
  async function tile(req, res, type, z, x, y) {
    loadConfig();
    if (!config.key || !TYPES[type]) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      return res.end("google maps is not configured");
    }
    if (overLimit()) {
      res.writeHead(429, { "Content-Type": "text/plain", "Cache-Control": "no-store" });
      return res.end("daily or monthly limit reached");
    }
    const get = async (renew) => {
      const token = await session(type, renew);
      const headers = {};
      const inm = req.headers["if-none-match"];
      if (inm) headers["If-None-Match"] = inm;
      countOne();
      return fetch(`${API}/v1/2dtiles/${z}/${x}/${y}?session=${encodeURIComponent(token)}&key=${encodeURIComponent(config.key)}`, { headers });
    };
    let up = await get(false);
    // セッションが切れていたら一度だけ取り直す
    if (up.status === 400 || up.status === 401 || up.status === 403) up = await get(true);
    const out = { "Content-Type": up.headers.get("content-type") ?? "application/octet-stream" };
    // ブラウザには Google の指定どおりにキャッシュしてもらう(サーバーでは保存しない)
    for (const h of ["cache-control", "etag", "expires", "last-modified"]) {
      const v = up.headers.get(h);
      if (v) out[h] = v;
    }
    if (up.status === 304) {
      res.writeHead(304, out);
      return res.end();
    }
    const body = Buffer.from(await up.arrayBuffer());
    if (!up.ok) console.error(`Google マップのタイル ${type}/${z}/${x}/${y}: ${up.status} ${body.toString("utf8").slice(0, 200)}`);
    res.writeHead(up.status, out);
    res.end(body);
  }

  /** 表示している範囲の著作権表示(Google の規約で表示が必要) */
  async function viewport(type, q) {
    loadConfig();
    if (!config.key || !TYPES[type]) return { copyright: "" };
    const token = await session(type);
    const p = new URLSearchParams({ session: token, key: config.key });
    for (const k of ["zoom", "north", "south", "east", "west"]) p.set(k, String(q.get(k) ?? ""));
    const res = await fetch(`${API}/tile/v1/viewport?${p}`);
    if (!res.ok) return { copyright: "" };
    const body = await res.json();
    return { copyright: String(body.copyright ?? "") };
  }

  return { status, tile, viewport, route };
}
