import type { TrackPoint } from "../types";

export function parseGpx(text: string): TrackPoint[] {
  // MiniPC のサーバー(Node.js)には DOMParser がないので、そのときは文字列から読む
  if (typeof DOMParser === "undefined") return parseGpxText(text);
  const doc = new DOMParser().parseFromString(text, "application/xml");
  const points: TrackPoint[] = [];
  for (const el of Array.from(doc.querySelectorAll("trkpt, rtept"))) {
    const lat = Number(el.getAttribute("lat"));
    const lon = Number(el.getAttribute("lon"));
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const t = el.querySelector("time")?.textContent;
    points.push({ lat, lon, time: t ? Date.parse(t) : undefined });
  }
  return points;
}

const attr = (tag: string, name: string) => new RegExp(`\\s${name}\\s*=\\s*["']([^"']*)["']`).exec(tag)?.[1];

/** DOMParser を使わずに trkpt・rtept を読む(名前空間の接頭辞が付いていても読む) */
export function parseGpxText(text: string): TrackPoint[] {
  const points: TrackPoint[] = [];
  const open = /<(?:\w+:)?(trkpt|rtept)\b([^>]*?)(\/)?>/g;
  for (let m; (m = open.exec(text)); ) {
    const lat = attr(m[2], "lat");
    const lon = attr(m[2], "lon");
    let time: number | undefined;
    if (!m[3]) {
      const close = new RegExp(`</(?:\\w+:)?${m[1]}\\s*>`, "g");
      close.lastIndex = open.lastIndex;
      const end = close.exec(text)?.index ?? open.lastIndex;
      const t = /<(?:\w+:)?time\b[^>]*>([^<]*)</.exec(text.slice(open.lastIndex, end))?.[1]?.trim();
      if (t) time = Date.parse(t);
    }
    if (!lat || !lon || !Number.isFinite(Number(lat)) || !Number.isFinite(Number(lon))) continue;
    points.push({ lat: Number(lat), lon: Number(lon), time });
  }
  return points;
}
