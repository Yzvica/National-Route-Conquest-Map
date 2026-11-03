/** [経度, 緯度] */
export type LonLat = [number, number];

/**
 * 区間の種別。1区間が複数持つことがある(例: バイパス かつ 重複)。
 * main〜old は国道(old は国道指定を外れた旧ルート)、expressway〜toll は高速道路、major・general は都道府県道のデータで使う
 */
export type Category =
  | "main"
  | "bypass"
  | "dotted"
  | "old"
  | "ferry"
  | "expressway"
  | "urban"
  | "motorroad"
  | "toll"
  | "major"
  | "general"
  | "overlap";

export const CATEGORY_LABELS: Record<Category, string> = {
  main: "現道",
  bypass: "バイパス",
  dotted: "点線国道",
  old: "旧道",
  ferry: "海上区間",
  expressway: "高速自動車国道",
  urban: "都市高速",
  motorroad: "自動車専用道路",
  toll: "有料道路",
  major: "主要地方道",
  general: "一般都道府県道",
  overlap: "重複区間",
};

/** どの道路のデータか */
export type DatasetKind = "kokudo" | "expressway" | "prefroad";

export const DATASET_LABELS: Record<DatasetKind, string> = { kokudo: "国道", expressway: "高速道路", prefroad: "都道府県道" };

/** 判定の最小単位。OSM の way を約200mごとに切ったもの */
export interface Segment {
  /** "w<wayId>-<index>"(都道府県道は "p<wayId>-<index>")。データを作り直しても way が変わらなければ同じ ID */
  id: string;
  /** この区間が属する国道番号(重複区間なら複数)。高速道路は名前、都道府県道は "13-413" のような「都道府県コード-番号」 */
  routes: string[];
  cats: Category[];
  /** トンネル内なら、そのトンネル(way)の ID */
  tunnel?: string;
  /** メートル */
  len: number;
  /**
   * 上下線が別の道になっている道路で、反対車線の区間の ID。
   * どちらかを走れば制覇とし、距離は上下線で半分ずつ数える
   */
  pair?: string;
  /** 点線国道の区間の OSM の highway の値(path, track など。ないときは "none")。古いデータにはない */
  hw?: string;
  /**
   * 旧道の区間の OSM での名前(「旧国道1号」「○○旧道」など)。都道府県道では区間の通称(「三宿通り」など)。
   * 名前のない区間や、ほかの種別にはない
   */
  name?: string;
  /** 旧道のうち、旧道のリレーションから作ったものは "rel"(データを作るときだけ使う) */
  src?: "rel";
  /** 区間がある都道府県のコード(1〜47)。scripts/add_prefectures.py で付ける。古いデータにはない */
  pref?: number;
  /**
   * 都道府県の境をまたぐ区間だけにある、都道府県ごとの割合 [[コード, 割合], ...](割合の合計は1)。
   * 県別の距離はこの割合で分ける。古いデータにはない
   */
  prefs?: [number, number][];
  coords: LonLat[];
}

export interface Tunnel {
  id: string;
  /** 両端の坑口 */
  a: LonLat;
  b: LonLat;
  len: number;
}

export interface RouteData {
  version: number;
  /** 省略時は国道 */
  kind?: DatasetKind;
  generatedAt: string;
  routes: Record<string, { name: string }>;
  segments: Segment[];
  tunnels: Tunnel[];
  /**
   * 高速道路のデータだけにある、IC のランプ(進む向きの線)。in は下の道から本線へ、out は本線から下の道へ。
   * 走ったログが高速道路の上か下の道かを決める手がかりにする(src/layers.ts)。古いデータにはない
   */
  ramps?: Ramp[];
  /** 高速道路のデータだけにある、高速道路に出入りできる場所(ランプが本線につながる点と、本線の端)。古いデータにはない */
  access?: LonLat[];
}

export interface Ramp {
  c: LonLat[];
  k: "in" | "out";
}

/** 都道府県道の一覧(prefroads/index.json)。都道府県ごとのファイルは prefroads/01.json 〜 47.json */
export interface PrefRoadIndex {
  version: number;
  generatedAt: string;
  /** cells の格子の大きさ(度) */
  cell: number;
  prefs: {
    [code: string]: {
      name: string;
      routes: number;
      km: number;
      bytes: number;
      /** その都道府県の都道府県道が通る格子(経度の番号 * 1000 + 緯度の番号) */
      cells: number[];
    };
  };
}

export interface TrackPoint {
  lat: number;
  lon: number;
  /** UNIX ミリ秒。ログに時刻がなければ undefined */
  time?: number;
}

/** 区間ID → 走行済み割合(0〜1) */
export type Coverage = Map<string, number>;
