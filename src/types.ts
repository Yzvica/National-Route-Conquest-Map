/** [経度, 緯度] */
export type LonLat = [number, number];

/** 区間の種別。1区間が複数持つことがある(例: バイパス かつ 重複) */
export type Category = "main" | "bypass" | "dotted" | "ferry" | "overlap";

export const CATEGORY_LABELS: Record<Category, string> = {
  main: "現道",
  bypass: "バイパス",
  dotted: "点線国道",
  ferry: "海上区間",
  overlap: "重複区間",
};

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
