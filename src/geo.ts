import type { LonLat } from "./types";

const R = 6371008.8;
const toRad = (d: number) => (d * Math.PI) / 180;

export function distance(a: LonLat, b: LonLat): number {
  const dLat = toRad(b[1] - a[1]);
  const dLon = toRad(b[0] - a[0]);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export function lineLength(coords: LonLat[]): number {
  let sum = 0;
  for (let i = 1; i < coords.length; i++) sum += distance(coords[i - 1], coords[i]);
  return sum;
}

/** 線上に step メートルおきの点を取る(両端を含む) */
export function samplePoints(coords: LonLat[], step: number): LonLat[] {
  const out: LonLat[] = [coords[0]];
  let carry = 0;
  for (let i = 1; i < coords.length; i++) {
    const a = coords[i - 1];
    const b = coords[i];
    const d = distance(a, b);
    let t = step - carry;
    while (t < d) {
      const f = t / d;
      out.push([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f]);
      t += step;
    }
    carry = d - (t - step);
  }
  const last = coords[coords.length - 1];
  const prev = out[out.length - 1];
  if (prev[0] !== last[0] || prev[1] !== last[1]) out.push(last);
  return out;
}

/**
 * 点を約 cellMeters 四方のマスに振り分ける簡易空間インデックス。
 * 近傍検索は周囲 3x3 マスだけを見るので、検索半径は cellMeters 以下にすること。
 */
export class PointGrid<T> {
  private cells = new Map<string, { p: LonLat; v: T }[]>();
  private readonly latStep: number;
  private readonly lonStep: number;

  constructor(cellMeters: number, refLat = 36) {
    this.latStep = cellMeters / 111_320;
    this.lonStep = cellMeters / (111_320 * Math.cos(toRad(refLat)));
  }

  private key(x: number, y: number) {
    return `${x},${y}`;
  }

  private cellOf(p: LonLat): [number, number] {
    return [Math.floor(p[0] / this.lonStep), Math.floor(p[1] / this.latStep)];
  }

  add(p: LonLat, v: T) {
    const [x, y] = this.cellOf(p);
    const k = this.key(x, y);
    let cell = this.cells.get(k);
    if (!cell) this.cells.set(k, (cell = []));
    cell.push({ p, v });
  }

  /** radius メートル以内の点をすべて返す */
  near(p: LonLat, radius: number): { p: LonLat; v: T; d: number }[] {
    const [x, y] = this.cellOf(p);
    const out: { p: LonLat; v: T; d: number }[] = [];
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const cell = this.cells.get(this.key(x + dx, y + dy));
        if (!cell) continue;
        for (const e of cell) {
          const d = distance(p, e.p);
          if (d <= radius) out.push({ ...e, d });
        }
      }
    }
    return out;
  }

  hasNear(p: LonLat, radius: number): boolean {
    const [x, y] = this.cellOf(p);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const cell = this.cells.get(this.key(x + dx, y + dy));
        if (cell?.some((e) => distance(p, e.p) <= radius)) return true;
      }
    }
    return false;
  }
}
