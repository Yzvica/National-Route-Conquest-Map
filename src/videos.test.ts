import { describe, expect, it } from "vitest";
import { videoAt, videosInRange, videoTime, watchUrl, youtubeId, type Video } from "./videos";

const v1: Video = {
  id: "2026-11-13_23-47-08",
  youtube: "8U_c9mUY-Sg",
  clips: [
    { start: 1000_000_000, dur: 600, offset: 0 },
    // 2 本目は 3 秒重ねてつないである
    { start: 1000_001_000, dur: 300, offset: 597 },
  ],
};
const v2: Video = { id: "2026-11-20_10-00-00", clips: [{ start: 1000_100_000, dur: 100, offset: 0 }] };

describe("youtubeId", () => {
  it("いろいろな形の URL と ID そのものを読む", () => {
    for (const s of [
      "https://www.youtube.com/watch?v=8U_c9mUY-Sg",
      "https://youtube.com/watch?v=8U_c9mUY-Sg&t=10s",
      "https://youtu.be/8U_c9mUY-Sg?si=abc",
      "https://m.youtube.com/watch?v=8U_c9mUY-Sg",
      "https://www.youtube.com/live/8U_c9mUY-Sg",
      "https://www.youtube.com/shorts/8U_c9mUY-Sg",
      " 8U_c9mUY-Sg ",
    ])
      expect(youtubeId(s)).toBe("8U_c9mUY-Sg");
  });
  it("YouTube 以外や壊れた URL は読まない", () => {
    expect(youtubeId("https://example.com/watch?v=8U_c9mUY-Sg")).toBeUndefined();
    expect(youtubeId("https://youtu.be/short")).toBeUndefined();
    expect(youtubeId("abc")).toBeUndefined();
  });
});

describe("videoAt", () => {
  it("録画の中の時刻を動画の位置にする(2 本目は重ねた分だけ前から)", () => {
    expect(videoAt([v1], 1000_000_100_000)?.sec).toBe(100);
    expect(videoAt([v1], 1000_001_010_000)?.sec).toBe(607);
  });
  it("録画の間(動画に入っていない時刻)や動画の無い時刻は undefined", () => {
    expect(videoAt([v1], 1000_000_700_000)).toBeUndefined();
    expect(videoAt([v1, v2], 999_000_000_000)).toBeUndefined();
  });
  it("同じ時刻が 2 本に入っていたら URL を貼ってある方", () => {
    const dup: Video = { id: "x", clips: [{ start: 1000_000_000, dur: 600, offset: 50 }] };
    expect(videoAt([dup, v1], 1000_000_100_000)?.video.id).toBe(v1.id);
  });
});

describe("videosInRange", () => {
  it("ログの時間帯と重なる動画と、重なりの始まりの位置", () => {
    const hits = videosInRange([v2, v1], 999_999_900_000, 1000_100_050_000);
    expect(hits.map((h) => [h.video.id, h.sec])).toEqual([
      [v1.id, 0],
      [v2.id, 0],
    ]);
    expect(videosInRange([v1], 1000_000_700_000, 1000_001_100_000)[0].sec).toBe(597);
  });
  it("重ならなければ空", () => {
    expect(videosInRange([v1], 1000_000_600_000, 1000_001_000_000)).toEqual([]);
  });
});

describe("表示", () => {
  it("動画の位置", () => {
    expect(videoTime(65.9)).toBe("1:05");
    expect(videoTime(3725)).toBe("1:02:05");
    expect(watchUrl("8U_c9mUY-Sg", 607.8)).toBe("https://www.youtube.com/watch?v=8U_c9mUY-Sg&t=607s");
  });
});
