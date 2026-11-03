import { describe, expect, it } from "vitest";
import { parseGpx, parseGpxText } from "./gpx";

describe("parseGpxText(サーバーで GPX を読む)", () => {
  it("trkpt・rtept の位置と時刻を読み、位置のない点は飛ばす", () => {
    const text = `<?xml version="1.0"?>
<gpx xmlns="http://www.topografix.com/GPX/1/1"><trk><trkseg>
  <trkpt lat="35.1" lon='139.2'><ele>10</ele><time>2026-10-21T01:00:00Z</time></trkpt>
  <trkpt lon="139.3" lat="35.2"/>
  <trkpt lat="" lon="139.4"><time>2026-10-21T01:00:02Z</time></trkpt>
</trkseg></trk><rte><gpx:rtept lat="35.5" lon="139.5"></gpx:rtept></rte></gpx>`;
    expect(parseGpxText(text)).toEqual([
      { lat: 35.1, lon: 139.2, time: Date.parse("2026-10-21T01:00:00Z") },
      { lat: 35.2, lon: 139.3, time: undefined },
      { lat: 35.5, lon: 139.5, time: undefined },
    ]);
  });

  it("DOMParser がないときは文字列から読む", () => {
    expect(parseGpx('<gpx><trkpt lat="1" lon="2"></trkpt></gpx>')).toEqual([{ lat: 1, lon: 2, time: undefined }]);
  });
});
