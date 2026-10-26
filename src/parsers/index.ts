import type { TrackPoint } from "../types";
import { parseTrackCsv } from "./csv";
import { parseGpx } from "./gpx";

export async function parseTrackFile(file: File): Promise<TrackPoint[]> {
  const text = await file.text();
  if (/\.gpx$/i.test(file.name) || text.trimStart().startsWith("<")) return parseGpx(text);
  return parseTrackCsv(text);
}
