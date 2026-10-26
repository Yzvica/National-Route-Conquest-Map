import type { TrackPoint } from "../types";

export function parseGpx(text: string): TrackPoint[] {
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
