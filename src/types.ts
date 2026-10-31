/** [経度, 緯度] */
export type LonLat = [number, number];

/**
 * 区間の種別。1区間が複数持つことがある(例: バイパス かつ 重複)。
 * main〜ferry は国道、expressway〜toll は高速道路のデータで使う
 */
export type Category =
  | "main"
  | "bypass"
  | "dotted"
  | "ferry"
  | "expressway"
  | "urban"
  | "motorroad"
  | "toll"
  | "overlap";

export const CATEGORY_LABELS: Record<Category, string> = {
  main: "現道",
  bypass: "バイパス",
  dotted: "点線国道",
  ferry: "海上区間",
  expressway: "高速自動車国道",
  urban: "都市高速",
  motorroad: "自動車専用道路",
  toll: "有料道路",
  overlap: "重複区間",
};

/** どの道路のデータか */
export type DatasetKind = "kokudo" | "expressway";

export const DATASET_LABELS: Record<DatasetKind, string> = { kokudo: "国道", expressway: "高速道路" };

/** 判定の最小単位。OSM の way を約200mごとに切ったもの */
export interface Segment {
  /** "w<wayId>-<index>" 。データを作り直しても way が変わらなければ同じ ID */
  id: string;
  /** この区間が属する国道番号(重複区間なら複数) */
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
}

export interface TrackPoint {
  lat: number;
  lon: number;
  /** UNIX ミリ秒。ログに時刻がなければ undefined */
  time?: number;
}

/** 区間ID → 走行済み割合(0〜1) */
export type Coverage = Map<string, number>;
