// 走行した時刻・場所の天気を Open-Meteo(https://open-meteo.com/ 無料・キー不要)から取る。
// 走り終えて生データが届いたあとに MiniPC で取り、走行フォルダの weather.json に残す。
// 値は気象モデルの解析値(日本では気象庁のモデルなど)で、アメダスの観測値ではない。
// 直近(約3か月以内)は予報 API の過去分、それより前は過去データ API(ERA5、1940年〜)を使う。
// Node.js の標準機能だけで動く。

const FORECAST_URL = () => process.env.WEATHER_FORECAST_URL ?? "https://api.open-meteo.com/v1/forecast";
const ARCHIVE_URL = () => process.env.WEATHER_ARCHIVE_URL ?? "https://archive-api.open-meteo.com/v1/archive";
/** これより古い走行は過去データ API で取る(予報 API の過去分は約3か月まで) */
const FORECAST_MAX_AGE_DAYS = 80;

/** 天気を調べる点の間隔(時間・距離のどちらかを超えたら次の点) */
const SAMPLE_S = 30 * 60;
const SAMPLE_M = 30_000;
const MAX_SAMPLES = 48;

const HOURLY = [
  "temperature_2m",
  "apparent_temperature",
  "relative_humidity_2m",
  "precipitation",
  "snowfall",
  "weather_code",
  "cloud_cover",
  "pressure_msl",
  "wind_speed_10m",
  "wind_direction_10m",
  "wind_gusts_10m",
  "is_day",
];

/** WMO の天気コード → 日本語とアイコン */
const WMO = {
  0: ["快晴", "☀️"],
  1: ["晴れ", "🌤️"],
  2: ["晴れ時々くもり", "⛅"],
  3: ["くもり", "☁️"],
  45: ["霧", "🌫️"],
  48: ["霧(着氷)", "🌫️"],
  51: ["弱い霧雨", "🌦️"],
  53: ["霧雨", "🌦️"],
  55: ["強い霧雨", "🌧️"],
  56: ["着氷性の霧雨", "🌧️"],
  57: ["強い着氷性の霧雨", "🌧️"],
  61: ["小雨", "🌧️"],
  63: ["雨", "🌧️"],
  65: ["強い雨", "🌧️"],
  66: ["着氷性の雨", "🌧️"],
  67: ["強い着氷性の雨", "🌧️"],
  71: ["小雪", "🌨️"],
  73: ["雪", "🌨️"],
  75: ["大雪", "❄️"],
  77: ["霧雪", "🌨️"],
  80: ["弱いにわか雨", "🌦️"],
  81: ["にわか雨", "🌧️"],
  82: ["激しいにわか雨", "⛈️"],
  85: ["にわか雪", "🌨️"],
  86: ["強いにわか雪", "❄️"],
  95: ["雷雨", "⛈️"],
  96: ["ひょうを伴う雷雨", "⛈️"],
  99: ["強いひょうを伴う雷雨", "⛈️"],
};

export function weatherLabel(code) {
  const w = WMO[code];
  return w ? { label: w[0], icon: w[1] } : { label: "不明", icon: "❔" };
}

const R = 6371000;
const rad = (d) => (d * Math.PI) / 180;
function distM(a, b) {
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/**
 * 走行ロガーの location.csv(または location_filled.csv)から { t(UNIX秒), lat, lon } を読む。
 * 精度が悪すぎる点(±1km の基地局測位など)は使わない
 */
export function parseLocationCsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return [];
  const head = lines[0].split(",").map((s) => s.trim());
  const cT = head.indexOf("unix_s");
  const cLat = head.indexOf("lat");
  const cLon = head.indexOf("lon");
  const cAcc = head.indexOf("h_acc_m");
  if (cT < 0 || cLat < 0 || cLon < 0) return [];
  const out = [];
  for (const line of lines.slice(1)) {
    const c = line.split(",");
    const t = Number(c[cT]);
    const lat = Number(c[cLat]);
    const lon = Number(c[cLon]);
    const acc = cAcc >= 0 && c[cAcc] !== "" ? Number(c[cAcc]) : 0;
    if (!Number.isFinite(t) || !Number.isFinite(lat) || !Number.isFinite(lon) || (lat === 0 && lon === 0)) continue;
    if (Number.isFinite(acc) && acc > 300) continue;
    out.push({ t, lat, lon });
  }
  return out.sort((a, b) => a.t - b.t);
}

/** 天気を調べる点を選ぶ: 最初と最後、その間は 30 分か 30km ごと(多すぎれば間引く) */
export function sampleTrack(points) {
  const pts = points.filter((p) => Number.isFinite(p.t) && Number.isFinite(p.lat) && Number.isFinite(p.lon));
  if (pts.length === 0) return [];
  const out = [pts[0]];
  let moved = 0;
  for (let i = 1; i < pts.length; i++) {
    moved += distM(pts[i - 1], pts[i]);
    const last = out[out.length - 1];
    if (pts[i].t - last.t >= SAMPLE_S || moved >= SAMPLE_M) {
      out.push(pts[i]);
      moved = 0;
    }
  }
  const end = pts[pts.length - 1];
  const last = out[out.length - 1];
  if (end !== last) {
    // 最後の点のすぐ近くで終わったなら、置き換える(ほぼ同じ所を2回調べないように)
    if (out.length > 1 && end.t - last.t < 5 * 60 && distM(last, end) < 3000) out[out.length - 1] = end;
    else out.push(end);
  }
  if (out.length <= MAX_SAMPLES) return out.map(({ t, lat, lon }) => ({ t, lat, lon }));
  const step = (out.length - 1) / (MAX_SAMPLES - 1);
  return Array.from({ length: MAX_SAMPLES }, (_, i) => out[Math.round(i * step)]).map(({ t, lat, lon }) => ({ t, lat, lon }));
}

/** 地点のタイムゾーンでの日付(YYYY-MM-DD)。日本以外でも1日前後に広げて取るので、ずれても困らない */
const ymd = (unix) => new Date(unix * 1000).toISOString().slice(0, 10);

/** Open-Meteo に問い合わせる URL(地点はまとめて1回で聞く) */
export function weatherUrl(samples, now = Date.now()) {
  const t0 = Math.min(...samples.map((s) => s.t));
  const t1 = Math.max(...samples.map((s) => s.t));
  const archive = now / 1000 - t1 > FORECAST_MAX_AGE_DAYS * 86400;
  const q = new URLSearchParams({
    latitude: samples.map((s) => s.lat.toFixed(4)).join(","),
    longitude: samples.map((s) => s.lon.toFixed(4)).join(","),
    hourly: HOURLY.join(","),
    daily: "sunrise,sunset",
    start_date: ymd(t0 - 86400),
    end_date: ymd(t1 + 86400),
    timezone: "auto",
    timeformat: "unixtime",
    wind_speed_unit: "ms",
  });
  return { url: `${archive ? ARCHIVE_URL() : FORECAST_URL()}?${q}`, api: archive ? "archive" : "forecast" };
}

const round = (v, d = 1) => (typeof v === "number" && Number.isFinite(v) ? Math.round(v * 10 ** d) / 10 ** d : null);

/** 1時間ごとの値から、時刻 t の値を取る。気温などは前後の時間で補間、降水量は「その時刻を含む1時間」の値 */
function pick(hourly, t) {
  const times = hourly.time;
  let i = times.findIndex((x) => x >= t);
  if (i < 0) i = times.length - 1;
  const j = Math.max(0, i - 1);
  const w = i === j || times[i] === times[j] ? 1 : (t - times[j]) / (times[i] - times[j]);
  const lerp = (name) => {
    const a = hourly[name]?.[j];
    const b = hourly[name]?.[i];
    if (typeof a !== "number") return typeof b === "number" ? b : null;
    if (typeof b !== "number") return a;
    return a + (b - a) * Math.min(Math.max(w, 0), 1);
  };
  const near = w < 0.5 ? j : i;
  const at = (name, k) => (typeof hourly[name]?.[k] === "number" ? hourly[name][k] : null);
  return {
    code: at("weather_code", near),
    temp: round(lerp("temperature_2m")),
    feels: round(lerp("apparent_temperature")),
    humidity: round(lerp("relative_humidity_2m"), 0),
    // Open-Meteo の降水量は「その時刻までの1時間」の量なので、t を含む1時間 = t 以降で最初の時刻の値
    precip: round(at("precipitation", i)),
    snow: round(at("snowfall", i)),
    cloud: round(lerp("cloud_cover"), 0),
    pressure: round(lerp("pressure_msl")),
    wind: round(lerp("wind_speed_10m")),
    windDir: round(at("wind_direction_10m", near), 0),
    gust: round(lerp("wind_gusts_10m")),
    isDay: at("is_day", near) === null ? null : at("is_day", near) === 1,
  };
}

/** 降水のある天気ほど大きい(まとめの天気を選ぶため) */
const severity = (code) => (code >= 95 ? 6 : code >= 71 && code <= 86 && code !== 80 && code !== 81 && code !== 82 ? 5 : code >= 61 ? 4 : code >= 51 ? 3 : code >= 45 ? 2 : 0);

/** 地点ごとの天気から、走行全体のまとめを作る */
export function summarize(samples) {
  const ok = samples.filter((s) => typeof s.code === "number");
  if (ok.length === 0) return null;
  const temps = ok.map((s) => s.temp).filter((v) => typeof v === "number");
  // 雨や雪に一度でも当たったら、それをまとめの天気にする。降っていなければ、いちばん多かった天気
  const wet = ok.filter((s) => severity(s.code) >= 3 || (s.precip ?? 0) >= 0.5);
  let code;
  if (wet.length) code = wet.reduce((a, b) => (severity(b.code) > severity(a.code) ? b : a)).code;
  else {
    const n = new Map();
    for (const s of ok) n.set(s.code, (n.get(s.code) ?? 0) + 1);
    code = [...n.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0][0];
  }
  const max = (k) => {
    const v = ok.map((s) => s[k]).filter((x) => typeof x === "number");
    return v.length ? Math.max(...v) : null;
  };
  return {
    code,
    ...weatherLabel(code),
    tMin: temps.length ? Math.min(...temps) : null,
    tMax: temps.length ? Math.max(...temps) : null,
    precipMax: max("precip"),
    windMax: max("wind"),
    gustMax: max("gust"),
    rain: wet.length > 0,
    night: ok.some((s) => s.isDay === false),
  };
}

/**
 * 地点ごとに天気を調べて、weather.json に書く中身を返す。
 * fetchImpl はテストで差し替える
 */
export async function fetchWeather(points, { fetchImpl = fetch, now = Date.now() } = {}) {
  const samples = sampleTrack(points);
  if (samples.length === 0) throw new Error("位置の記録がないので天気を調べられません");
  const { url, api } = weatherUrl(samples, now);
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`天気を取れませんでした(HTTP ${res.status}: ${(await res.text()).slice(0, 200)})`);
  let body = await res.json();
  // 地点が1つのときは配列でなく1つの結果が返る
  if (!Array.isArray(body)) body = [body];
  if (body.length !== samples.length) throw new Error(`天気の結果の数が合いません(${body.length} / ${samples.length})`);
  const out = samples.map((s, k) => {
    const r = body[k];
    if (!r?.hourly?.time?.length) throw new Error("天気の結果に時刻がありません");
    const v = pick(r.hourly, s.t);
    return { t: s.t, lat: round(s.lat, 5), lon: round(s.lon, 5), ...v, ...weatherLabel(v.code) };
  });
  // 日の出・日の入り(走り始めた日・場所)
  let sun = null;
  const d0 = body[0]?.daily;
  if (d0?.time?.length) {
    const t = samples[0].t;
    let i = d0.time.findIndex((x, k) => x <= t && (k + 1 >= d0.time.length || d0.time[k + 1] > t));
    if (i < 0) i = 0;
    if (typeof d0.sunrise?.[i] === "number" && typeof d0.sunset?.[i] === "number") sun = { sunrise: d0.sunrise[i], sunset: d0.sunset[i] };
  }
  const summary = summarize(out);
  if (!summary) throw new Error("天気の値がありません(まだ公開されていない時刻かもしれません)");
  return {
    version: 1,
    source: "Open-Meteo",
    api,
    fetchedAt: new Date(now).toISOString(),
    summary: { ...summary, ...(sun ?? {}) },
    samples: out,
  };
}
