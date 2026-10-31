// 実績・レベル・振り返り・チャレンジなど、ゲームとしての集計。
// 画面には依存しない純粋な計算だけを置く(src/game.test.ts で確かめる)。
import { REGIONS } from "./prefs";
import { computeStats, segmentWeight, type Progress, type Stats } from "./stats";
import type { PassDates } from "./store";
import type { Coverage, DatasetKind, RouteData } from "./types";

/** 路線の走行率がこれ以上なら「制覇」とする(脇道や GPS のずれで 100% にならないことがあるため) */
export const CONQUER_RATIO = 0.95;
/** 日付を記録する前に取り込んだ区間の日付 */
export const UNDATED = "";

export interface RouteProgress {
  ref: string;
  total: number;
  done: number;
  /** 初めて通った日(YYYY-MM-DD)。通っていなければ undefined、日付不明なら "" */
  firstDate?: string;
  /** 走行率が CONQUER_RATIO に達した日。未制覇なら undefined、日付不明なら "" */
  conqueredDate?: string;
}

/** 1つのデータ(国道か高速道路)についての集計 */
export interface DatasetSummary {
  kind: DatasetKind;
  stats: Stats;
  routes: Map<string, RouteProgress>;
  /** 初めて通った日ごとの、新たに走った距離(m)。日付不明の分は UNDATED */
  daily: Map<string, number>;
  /** 通ったトンネルの数 / 全トンネル */
  tunnels: { passed: number; total: number };
  /** トンネルごとの初めて通った日 */
  tunnelDates: string[];
  /** 通った区間のうち、いちばん多くの路線が重なっていた数 */
  maxOverlap: number;
  /** 通った区間の数 */
  passedSegments: number;
  /** 都道府県コード → 距離。データに都道府県がなければ undefined */
  byPref?: Map<number, Progress>;
}

const ratioOf = (coverage: Coverage, id: string) => coverage.get(id) ?? 0;

/** 区間を初めて通った日。上下線の組は反対側の日付も見る */
function firstDateOf(dates: Map<string, PassDates>, id: string, pair?: string): string {
  const a = dates.get(id)?.[0];
  const b = pair ? dates.get(pair)?.[0] : undefined;
  if (a && b) return a < b ? a : b;
  return a ?? b ?? UNDATED;
}

/**
 * coverage は上下線をならした後のもの(effectiveCoverage の結果)を渡す。
 */
export function summarize(data: RouteData, coverage: Coverage, dates: Map<string, PassDates>): DatasetSummary {
  const kind = data.kind ?? "kokudo";
  const stats = computeStats(data, coverage);
  const daily = new Map<string, number>();
  /** 路線ごとの [初めて通った日, 走った距離] */
  const perRoute = new Map<string, [string, number][]>();
  const tunnelFirst = new Map<string, string>();
  let maxOverlap = 0;
  let passedSegments = 0;
  const byPref = new Map<number, Progress>();

  for (const s of data.segments) {
    const r = ratioOf(coverage, s.id);
    if (s.pref) {
      let p = byPref.get(s.pref);
      if (!p) byPref.set(s.pref, (p = { total: 0, done: 0 }));
      p.total += s.len * segmentWeight(s);
      p.done += s.len * segmentWeight(s) * r;
    }
    if (r <= 0) continue;
    passedSegments++;
    const d = firstDateOf(dates, s.id, s.pair);
    const amount = s.len * segmentWeight(s) * r;
    daily.set(d, (daily.get(d) ?? 0) + amount);
    for (const ref of s.routes) {
      let list = perRoute.get(ref);
      if (!list) perRoute.set(ref, (list = []));
      list.push([d, amount]);
    }
    if (s.tunnel) {
      const cur = tunnelFirst.get(s.tunnel);
      if (cur === undefined || d < cur) tunnelFirst.set(s.tunnel, d);
    }
    maxOverlap = Math.max(maxOverlap, s.routes.length);
  }

  const routes = new Map<string, RouteProgress>();
  for (const [ref, rs] of stats.byRoute) {
    const p: RouteProgress = { ref, total: rs.overall.total, done: rs.overall.done };
    const list = perRoute.get(ref);
    if (list) {
      // 日付不明("")が先頭に来る。日付順に足していき、制覇の割合に届いた日が制覇した日
      list.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
      p.firstDate = list[0][0];
      const goal = p.total * CONQUER_RATIO;
      let acc = 0;
      for (const [d, amount] of list) {
        acc += amount;
        // 足し算の誤差で届かないことがないよう、ほんの少し余裕を持たせる
        if (acc >= goal - 1e-6) {
          p.conqueredDate = d;
          break;
        }
      }
    }
    routes.set(ref, p);
  }

  const tunnelIds = new Set(data.tunnels.map((t) => t.id));
  for (const s of data.segments) if (s.tunnel) tunnelIds.add(s.tunnel);
  return {
    kind,
    stats,
    routes,
    daily,
    tunnels: { passed: tunnelFirst.size, total: tunnelIds.size },
    tunnelDates: [...tunnelFirst.values()],
    maxOverlap,
    passedSegments,
    byPref: byPref.size ? byPref : undefined,
  };
}

export const isConquered = (p: RouteProgress) => p.conqueredDate !== undefined;
export const conqueredRoutes = (s?: DatasetSummary) => (s ? [...s.routes.values()].filter(isConquered) : []);
export const touchedRoutes = (s?: DatasetSummary) => (s ? [...s.routes.values()].filter((p) => p.done > 0) : []);

// ---------------------------------------------------------------- 都道府県(データにあれば)

export interface GameContext {
  kokudo?: DatasetSummary;
  expressway?: DatasetSummary;
  /** 都道府県ごとの集計(国道)。データに都道府県がなければ undefined */
  prefs?: PrefSummary;
}

export interface PrefSummary {
  /** 都道府県コード(1〜47) → 距離 */
  byPref: Map<number, Progress>;
}

/** 地方ごとの距離(都道府県を足したもの) */
export function regionProgress(byPref: Map<number, Progress>): { name: string; progress: Progress; prefs: number[] }[] {
  return REGIONS.map((r) => {
    const progress = { total: 0, done: 0 };
    const prefs: number[] = [];
    for (let code = r.from; code <= r.to; code++) {
      const p = byPref.get(code);
      if (!p) continue;
      prefs.push(code);
      progress.total += p.total;
      progress.done += p.done;
    }
    return { name: r.name, progress, prefs };
  }).filter((r) => r.progress.total > 0);
}

export const REGION_TITLES: [number, string][] = [
  [0.7, "の覇者"],
  [0.3, "の主"],
  [0.1, "の常連"],
];

/** いちばん制覇率の高い地方による称号(「関東の主」など)。どこも 10% 未満なら undefined */
export function regionTitle(c: GameContext): string | undefined {
  if (!c.prefs) return undefined;
  let best: { name: string; ratio: number } | undefined;
  for (const r of regionProgress(c.prefs.byPref)) {
    const ratio = r.progress.done / r.progress.total;
    if (!best || ratio > best.ratio) best = { name: r.name, ratio };
  }
  if (!best) return undefined;
  const t = REGION_TITLES.find(([min]) => best!.ratio >= min);
  return t ? `${best.name}${t[1]}` : undefined;
}

// ---------------------------------------------------------------- 実績

export interface Achievement {
  id: string;
  icon: string;
  name: string;
  desc: string;
  group: string;
  /** 今の値と目標。cur >= target で解除 */
  check: (c: GameContext) => { cur: number; target: number } | null;
  /** 進み具合を出すときの単位 */
  unit?: string;
  /** 段階のある実績(100km, 500km, …)のまとまり */
  series?: string;
}

export interface AchievementState {
  a: Achievement;
  cur: number;
  target: number;
  unlocked: boolean;
}

const km = (s?: DatasetSummary) => (s ? s.stats.overall.done / 1000 : 0);
const catKm = (s: DatasetSummary | undefined, cat: keyof Stats["byCategory"]) => (s ? s.stats.byCategory[cat].done / 1000 : 0);
const pctOf = (s?: DatasetSummary) => (s && s.stats.overall.total > 0 ? (s.stats.overall.done / s.stats.overall.total) * 100 : 0);
const goal = (cur: number, target: number) => ({ cur, target });

/** refs の国道をすべて制覇したか */
function routesConquered(c: GameContext, refs: string[]) {
  const s = c.kokudo;
  if (!s) return null;
  const present = refs.filter((r) => s.routes.has(r));
  if (present.length === 0) return null;
  return goal(present.filter((r) => isConquered(s.routes.get(r)!)).length, present.length);
}

/** いちばん長い/短い国道(データの長さで決める) */
function extremeRoute(s: DatasetSummary | undefined, longest: boolean): RouteProgress | undefined {
  if (!s) return undefined;
  let best: RouteProgress | undefined;
  for (const p of s.routes.values()) {
    if (!best || (longest ? p.total > best.total : p.total < best.total)) best = p;
  }
  return best;
}

/** 1日で新たに走った距離のいちばん大きい値(km) */
const bestDay = (s?: DatasetSummary) =>
  s ? Math.max(0, ...[...s.daily].filter(([d]) => d !== UNDATED).map(([, m]) => m / 1000)) : 0;
/** 新しく道を走った日の数 */
const drivingDays = (c: GameContext) => {
  const days = new Set<string>();
  for (const s of [c.kokudo, c.expressway]) for (const d of s?.daily.keys() ?? []) if (d !== UNDATED) days.add(d);
  return days.size;
};

const SINGLE_DIGIT = ["1", "2", "3", "4", "5", "6", "7", "8", "9"];
const TWO_DIGIT = Array.from({ length: 49 }, (_, i) => String(i + 10)); // 10〜58号

function tiers(
  idBase: string,
  group: string,
  icon: string,
  values: number[],
  name: (v: number) => string,
  desc: (v: number) => string,
  cur: (c: GameContext) => number | null,
  unit?: string,
): Achievement[] {
  return values.map((v) => ({
    id: `${idBase}-${v}`,
    icon,
    name: name(v),
    desc: desc(v),
    group,
    unit,
    series: idBase,
    check: (c) => {
      const x = cur(c);
      return x === null ? null : goal(x, v);
    },
  }));
}

const fmt = (n: number) => n.toLocaleString("ja-JP");

export const ACHIEVEMENTS: Achievement[] = [
  {
    id: "first-step",
    icon: "🚗",
    name: "はじめの一歩",
    desc: "国道を初めて走る",
    group: "国道",
    check: (c) => (c.kokudo ? goal(c.kokudo.passedSegments > 0 ? 1 : 0, 1) : null),
  },
  ...tiers(
    "kokudo-km",
    "国道",
    "🛣️",
    [100, 500, 1000, 3000, 5000, 10000, 20000, 40000],
    (v) => `国道 ${fmt(v)} km`,
    (v) => `国道を合わせて ${fmt(v)} km 走る`,
    (c) => (c.kokudo ? km(c.kokudo) : null),
    "km",
  ),
  ...tiers(
    "kokudo-pct",
    "国道",
    "📈",
    [1, 5, 10, 25, 50, 75, 100],
    (v) => (v === 100 ? "全国道制覇" : `制覇率 ${v}%`),
    (v) => (v === 100 ? "国道の総合制覇率 100% を達成する" : `国道の総合制覇率 ${v}% を達成する`),
    (c) => (c.kokudo ? pctOf(c.kokudo) : null),
    "%",
  ),
  ...tiers(
    "touched",
    "国道",
    "👣",
    [10, 50, 100, 200, 300, 459],
    (v) => `${fmt(v)} 路線に足跡`,
    (v) => `${fmt(v)} 本の国道を少しでも走る`,
    (c) => (c.kokudo ? touchedRoutes(c.kokudo).length : null),
    "本",
  ),
  ...tiers(
    "conquer",
    "国道",
    "🏁",
    [1, 5, 10, 30, 50, 100, 200],
    (v) => (v === 1 ? "初めての国道制覇" : `${fmt(v)} 路線制覇`),
    (v) => `国道を ${fmt(v)} 本制覇する(走行率 ${CONQUER_RATIO * 100}% 以上)`,
    (c) => (c.kokudo ? conqueredRoutes(c.kokudo).length : null),
    "本",
  ),
  {
    id: "route-1",
    icon: "🗼",
    name: "東海道を行く",
    desc: "国道1号を制覇する",
    group: "名所",
    check: (c) => routesConquered(c, ["1"]),
  },
  {
    id: "single-digit",
    icon: "🔟",
    name: "一桁国道コンプリート",
    desc: "国道1〜9号をすべて制覇する",
    group: "名所",
    unit: "本",
    check: (c) => routesConquered(c, SINGLE_DIGIT),
  },
  {
    id: "two-digit",
    icon: "🎖️",
    name: "二桁国道コンプリート",
    desc: "国道10〜58号をすべて制覇する",
    group: "名所",
    unit: "本",
    check: (c) => routesConquered(c, TWO_DIGIT),
  },
  {
    id: "longest",
    icon: "🐉",
    name: "最長国道を制す",
    desc: "いちばん長い国道を制覇する",
    group: "名所",
    check: (c) => {
      const r = extremeRoute(c.kokudo, true);
      return r ? goal(isConquered(r) ? 1 : 0, 1) : null;
    },
  },
  {
    id: "shortest",
    icon: "🐜",
    name: "最短国道を制す",
    desc: "いちばん短い国道を制覇する",
    group: "名所",
    check: (c) => {
      const r = extremeRoute(c.kokudo, false);
      return r ? goal(isConquered(r) ? 1 : 0, 1) : null;
    },
  },
  ...tiers(
    "dotted",
    "酷道・海",
    "🥾",
    [0.2, 10, 50],
    (v) => (v < 1 ? "点線国道デビュー" : `点線国道 ${v} km`),
    (v) => (v < 1 ? "点線国道(車道でない国道)を走る" : `点線国道を ${v} km 走る`),
    (c) => (c.kokudo ? catKm(c.kokudo, "dotted") : null),
    "km",
  ),
  ...tiers(
    "ferry",
    "酷道・海",
    "⛴️",
    [0.2, 50, 200],
    (v) => (v < 1 ? "海を渡る国道" : `海上区間 ${v} km`),
    (v) => (v < 1 ? "海上区間(フェリー)を通る" : `海上区間を ${v} km 通る`),
    (c) => (c.kokudo ? catKm(c.kokudo, "ferry") : null),
    "km",
  ),
  ...tiers(
    "bypass",
    "酷道・海",
    "🏎️",
    [100, 1000],
    (v) => `バイパス ${fmt(v)} km`,
    (v) => `バイパスを ${fmt(v)} km 走る`,
    (c) => (c.kokudo ? catKm(c.kokudo, "bypass") : null),
    "km",
  ),
  ...tiers(
    "tunnel",
    "酷道・海",
    "🚇",
    [10, 100, 500, 1000],
    (v) => `トンネル ${fmt(v)} 本`,
    (v) => `国道のトンネルを ${fmt(v)} 本通る`,
    (c) => (c.kokudo ? c.kokudo.tunnels.passed : null),
    "本",
  ),
  {
    id: "overlap-3",
    icon: "🪢",
    name: "三重奏",
    desc: "3本以上の国道が重なっている区間を走る",
    group: "酷道・海",
    check: (c) => (c.kokudo ? goal(Math.min(c.kokudo.maxOverlap, 3), 3) : null),
  },
  {
    id: "exp-first",
    icon: "🛫",
    name: "高速デビュー",
    desc: "高速道路を初めて走る",
    group: "高速道路",
    check: (c) => (c.expressway ? goal(c.expressway.passedSegments > 0 ? 1 : 0, 1) : null),
  },
  ...tiers(
    "exp-km",
    "高速道路",
    "💨",
    [500, 2000, 5000, 10000],
    (v) => `高速 ${fmt(v)} km`,
    (v) => `高速道路を合わせて ${fmt(v)} km 走る`,
    (c) => (c.expressway ? km(c.expressway) : null),
    "km",
  ),
  ...tiers(
    "exp-conquer",
    "高速道路",
    "🏆",
    [1, 10, 50, 100],
    (v) => (v === 1 ? "初めての高速制覇" : `高速 ${fmt(v)} 路線制覇`),
    (v) => `高速道路を ${fmt(v)} 路線制覇する`,
    (c) => (c.expressway ? conqueredRoutes(c.expressway).length : null),
    "本",
  ),
  {
    id: "urban",
    icon: "🌃",
    name: "都会の夜景",
    desc: "都市高速(首都高・阪神高速など)を走る",
    group: "高速道路",
    check: (c) => (c.expressway ? goal(catKm(c.expressway, "urban") > 0 ? 1 : 0, 1) : null),
  },
  ...tiers(
    "best-day",
    "ドライブ",
    "☀️",
    [100, 300, 500],
    (v) => `1日 ${v} km 開拓`,
    (v) => `1日で、初めて走る道を ${v} km 走る(国道)`,
    (c) => (c.kokudo ? bestDay(c.kokudo) : null),
    "km",
  ),
  ...tiers(
    "days",
    "ドライブ",
    "📅",
    [10, 30, 100],
    (v) => `開拓 ${v} 日`,
    (v) => `新しい道を走った日が ${v} 日になる`,
    (c) => drivingDays(c),
    "日",
  ),
  // 都道府県(データに都道府県があるときだけ)
  ...tiers(
    "pref-visit",
    "都道府県",
    "🗾",
    [10, 30, 47],
    (v) => (v === 47 ? "全都道府県に足跡" : `${v} 都道府県に足跡`),
    (v) => `${v} の都道府県で国道を走る`,
    (c) => (c.prefs ? [...c.prefs.byPref.values()].filter((p) => p.done > 0).length : null),
    "都道府県",
  ),
  ...tiers(
    "pref-half",
    "都道府県",
    "🎌",
    [1, 5, 10],
    (v) => (v === 1 ? "地元を極める" : `${v} 都道府県で過半数`),
    (v) => `${v === 1 ? "1つ" : v} の都道府県で、国道の制覇率 50% を超える`,
    (c) => (c.prefs ? [...c.prefs.byPref.values()].filter((p) => p.total > 0 && p.done / p.total >= 0.5).length : null),
    "都道府県",
  ),
  {
    id: "region-all",
    icon: "🧳",
    name: "全国行脚",
    desc: "8つの地方(北海道・東北・関東・中部・近畿・中国・四国・九州沖縄)すべてで国道を走る",
    group: "都道府県",
    unit: "地方",
    check: (c) => {
      if (!c.prefs) return null;
      const rs = regionProgress(c.prefs.byPref);
      return goal(rs.filter((r) => r.progress.done > 0).length, rs.length);
    },
  },
  {
    id: "region-conquer",
    icon: "🏯",
    name: "地方制覇",
    desc: `どこかの地方で、国道の制覇率 ${CONQUER_RATIO * 100}% を達成する`,
    group: "都道府県",
    check: (c) =>
      c.prefs
        ? goal(regionProgress(c.prefs.byPref).some((r) => r.progress.done / r.progress.total >= CONQUER_RATIO) ? 1 : 0, 1)
        : null,
  },
  {
    id: "pref-conquer",
    icon: "👑",
    name: "県内制覇",
    desc: `どこかの都道府県で、国道の制覇率 ${CONQUER_RATIO * 100}% を達成する`,
    group: "都道府県",
    check: (c) =>
      c.prefs
        ? goal([...c.prefs.byPref.values()].some((p) => p.total > 0 && p.done / p.total >= CONQUER_RATIO) ? 1 : 0, 1)
        : null,
  },
];

export function evaluateAchievements(c: GameContext): AchievementState[] {
  const out: AchievementState[] = [];
  for (const a of ACHIEVEMENTS) {
    const g = a.check(c);
    if (!g) continue; // データがなく判定できないもの(高速道路のデータがないときなど)は出さない
    out.push({ a, cur: g.cur, target: g.target, unlocked: g.cur >= g.target });
  }
  return out;
}

// ---------------------------------------------------------------- レベル・称号

/** レベル n になるのに要る経験値(1→0, 2→100, 3→300, 4→600, …) */
export const xpForLevel = (n: number) => 50 * n * (n - 1);

export const TITLES: [number, string][] = [
  [1, "見習いドライバー"],
  [3, "週末ドライバー"],
  [6, "ロングドライバー"],
  [10, "国道トラベラー"],
  [15, "国道ハンター"],
  [20, "国道マイスター"],
  [25, "酷道の達人"],
  [30, "国道の覇者"],
  [36, "国道王"],
];

export interface Level {
  xp: number;
  level: number;
  title: string;
  /** 今のレベルになった経験値と、次のレベルの経験値 */
  from: number;
  to: number;
  /** 経験値の内訳 */
  parts: { label: string; xp: number }[];
}

/**
 * 経験値: 国道 1km = 1、高速 1km = 0.5、国道の制覇 1本 = 30、高速の制覇 1路線 = 15、実績 1つ = 50
 */
export function computeLevel(c: GameContext, unlocked: number): Level {
  const parts = [
    { label: "国道の走行距離", xp: Math.floor(km(c.kokudo)) },
    { label: "高速道路の走行距離", xp: Math.floor(km(c.expressway) * 0.5) },
    { label: "国道の制覇", xp: conqueredRoutes(c.kokudo).length * 30 },
    { label: "高速道路の制覇", xp: conqueredRoutes(c.expressway).length * 15 },
    { label: "実績", xp: unlocked * 50 },
  ];
  const xp = parts.reduce((a, p) => a + p.xp, 0);
  let level = 1;
  while (xpForLevel(level + 1) <= xp && level < 99) level++;
  const title = TITLES.filter(([lv]) => lv <= level).at(-1)![1];
  return { xp, level, title, from: xpForLevel(level), to: xpForLevel(level + 1), parts };
}

// ---------------------------------------------------------------- 振り返り

export interface YearSummary {
  year: string;
  /** 新たに走った距離(m) */
  newKm: number;
  firstRoutes: number;
  conquered: number;
}

export function yearly(s: DatasetSummary): YearSummary[] {
  const years = new Map<string, YearSummary>();
  const get = (d: string) => {
    const y = d.slice(0, 4);
    let ys = years.get(y);
    if (!ys) years.set(y, (ys = { year: y, newKm: 0, firstRoutes: 0, conquered: 0 }));
    return ys;
  };
  for (const [d, m] of s.daily) if (d !== UNDATED) get(d).newKm += m;
  for (const p of s.routes.values()) {
    if (p.firstDate) get(p.firstDate).firstRoutes++;
    if (p.conqueredDate) get(p.conqueredDate).conquered++;
  }
  return [...years.values()].sort((a, b) => b.year.localeCompare(a.year));
}

/** 月("YYYY-MM")ごとの新たに走った距離(m)。最初の月から今月まで、走らなかった月も 0 で埋める */
export function monthly(s: DatasetSummary, today: string): [string, number][] {
  const byMonth = new Map<string, number>();
  for (const [d, m] of s.daily) if (d !== UNDATED) byMonth.set(d.slice(0, 7), (byMonth.get(d.slice(0, 7)) ?? 0) + m);
  if (byMonth.size === 0) return [];
  const first = [...byMonth.keys()].sort()[0];
  const out: [string, number][] = [];
  for (let m = first; m <= today.slice(0, 7); m = nextMonth(m)) out.push([m, byMonth.get(m) ?? 0]);
  return out;
}

export function nextMonth(ym: string): string {
  let [y, m] = ym.split("-").map(Number);
  if (++m > 12) {
    m = 1;
    y++;
  }
  return `${y}-${String(m).padStart(2, "0")}`;
}

export function prevMonth(ym: string): string {
  let [y, m] = ym.split("-").map(Number);
  if (--m < 1) {
    m = 12;
    y--;
  }
  return `${y}-${String(m).padStart(2, "0")}`;
}

/** 制覇率の推移: 日付ごとの累計(m)。日付不明の分は最初から走っていたことにする */
export function cumulative(s: DatasetSummary): { start: number; points: [string, number][] } {
  const start = s.daily.get(UNDATED) ?? 0;
  let acc = start;
  const points: [string, number][] = [];
  for (const d of [...s.daily.keys()].filter((d) => d !== UNDATED).sort()) {
    acc += s.daily.get(d)!;
    points.push([d, acc]);
  }
  return { start, points };
}

export interface TimelineEvent {
  date: string;
  ref: string;
  type: "first" | "conquer";
}

/** 路線を初めて走った日・制覇した日の一覧(新しい順。日付不明は除く) */
export function timeline(s: DatasetSummary): TimelineEvent[] {
  const out: TimelineEvent[] = [];
  for (const p of s.routes.values()) {
    if (p.firstDate) out.push({ date: p.firstDate, ref: p.ref, type: "first" });
    if (p.conqueredDate) out.push({ date: p.conqueredDate, ref: p.ref, type: "conquer" });
  }
  // 同じ日なら制覇を先に
  return out.sort((a, b) => b.date.localeCompare(a.date) || (a.type === b.type ? 0 : a.type === "conquer" ? -1 : 1));
}

// ---------------------------------------------------------------- チャレンジ

export interface Challenge {
  id: string;
  icon: string;
  title: string;
  cur: number;
  target: number;
  unit: string;
}

const inMonth = (d: string | undefined, ym: string) => !!d && d.startsWith(ym);

/** その月に新たに走った距離(m) */
const monthKm = (s: DatasetSummary | undefined, ym: string) =>
  s ? [...s.daily].filter(([d]) => inMonth(d, ym)).reduce((a, [, m]) => a + m, 0) : 0;

/**
 * 月ごとのお題。毎月「開拓距離」「未踏の国道」と、月替わりのお題を1つ出す。
 * ym は "YYYY-MM"
 */
export function monthlyChallenges(c: GameContext, ym: string): Challenge[] {
  const k = c.kokudo;
  const list: Challenge[] = [];
  if (k) {
    list.push({ id: "new-km", icon: "🧭", title: "国道を新たに 200 km 開拓する", cur: monthKm(k, ym) / 1000, target: 200, unit: "km" });
    list.push({
      id: "new-routes",
      icon: "🆕",
      title: "まだ走ったことのない国道を 3 本走る",
      cur: [...k.routes.values()].filter((p) => inMonth(p.firstDate, ym)).length,
      target: 3,
      unit: "本",
    });
  }
  const rotating: Challenge[] = [];
  if (k) {
    rotating.push({
      id: "conquer",
      icon: "🏁",
      title: "国道を 1 本制覇する",
      cur: [...k.routes.values()].filter((p) => inMonth(p.conqueredDate, ym)).length,
      target: 1,
      unit: "本",
    });
    rotating.push({
      id: "tunnels",
      icon: "🚇",
      title: "初めてのトンネルを 10 本通る",
      cur: k.tunnelDates.filter((d) => inMonth(d, ym)).length,
      target: 10,
      unit: "本",
    });
  }
  if (c.expressway) {
    rotating.push({
      id: "exp-km",
      icon: "💨",
      title: "高速道路を新たに 100 km 走る",
      cur: monthKm(c.expressway, ym) / 1000,
      target: 100,
      unit: "km",
    });
  }
  if (k) {
    rotating.push({
      id: "days",
      icon: "📅",
      title: "新しい国道を走る日を 4 日つくる",
      cur: [...k.daily.keys()].filter((d) => inMonth(d, ym)).length,
      target: 4,
      unit: "日",
    });
  }
  if (rotating.length) {
    const [y, m] = ym.split("-").map(Number);
    list.push(rotating[(y * 12 + m) % rotating.length]);
  }
  return list;
}

// ---------------------------------------------------------------- おすすめ

export interface Suggestion {
  ref: string;
  total: number;
  done: number;
  /** 近くの未踏路線のとき、よく走るあたりからの距離(m) */
  distance?: number;
}

/** あと少しで制覇できる路線(残り距離が短い順) */
export function almostConquered(s: DatasetSummary, limit = 5): Suggestion[] {
  return [...s.routes.values()]
    .filter((p) => !isConquered(p) && p.total > 0 && p.done / p.total >= 0.4)
    .sort((a, b) => a.total * CONQUER_RATIO - a.done - (b.total * CONQUER_RATIO - b.done))
    .slice(0, limit)
    .map((p) => ({ ref: p.ref, total: p.total, done: p.done }));
}

const median = (xs: number[]) => {
  const a = [...xs].sort((x, y) => x - y);
  return a[Math.floor(a.length / 2)];
};

function meters(a: [number, number], b: [number, number]) {
  const kx = 111_320 * Math.cos((((a[1] + b[1]) / 2) * Math.PI) / 180);
  return Math.hypot((a[0] - b[0]) * kx, (a[1] - b[1]) * 110_540);
}

/**
 * よく走るあたり(通った区間の中央値の位置)から近い、まだ走っていない路線。
 * 走った区間がなければ空
 */
export function nearbyUntouched(data: RouteData, s: DatasetSummary, coverage: Coverage, limit = 5): Suggestion[] {
  const lons: number[] = [];
  const lats: number[] = [];
  for (const seg of data.segments) {
    if (ratioOf(coverage, seg.id) <= 0) continue;
    lons.push(seg.coords[0][0]);
    lats.push(seg.coords[0][1]);
  }
  if (lons.length === 0) return [];
  const home: [number, number] = [median(lons), median(lats)];
  const nearest = new Map<string, number>();
  for (const seg of data.segments) {
    for (const r of seg.routes) {
      const pr = s.routes.get(r);
      if (!pr || pr.done > 0) continue;
      const d = meters(home, seg.coords[0] as [number, number]);
      if (d < (nearest.get(r) ?? Infinity)) nearest.set(r, d);
    }
  }
  return [...nearest]
    .sort((a, b) => a[1] - b[1])
    .slice(0, limit)
    .map(([ref, distance]) => ({ ref, total: s.routes.get(ref)!.total, done: 0, distance }));
}

/** 画面用: すべてのデータの集計をまとめて作る */
export function buildContext(
  datasets: Partial<Record<DatasetKind, RouteData>>,
  coverageOf: (d: RouteData) => Coverage,
  dates: Map<string, PassDates>,
): GameContext {
  const c: GameContext = {};
  for (const kind of ["kokudo", "expressway"] as DatasetKind[]) {
    const d = datasets[kind];
    if (d) c[kind] = summarize(d, coverageOf(d), dates);
  }
  if (c.kokudo?.byPref) c.prefs = { byPref: c.kokudo.byPref };
  return c;
}
