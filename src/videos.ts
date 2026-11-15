// 車載動画(YouTube)とログのひも付け。
// _drivelog の YouTubeDesc.bat が、1 本の動画にどの録画(ログの時間帯)がどこから入っているかを
// MiniPC に送る(POST /api/videos)。地図では YouTube の URL を一度貼るだけで、
// ログ詳細やリプレイから、その場面の時刻で動画を開ける。

/** 動画に入っている 1 本の録画 */
export interface VideoClip {
  /** 録画の始まり(UNIX 秒) */
  start: number;
  /** 録画の長さ(秒) */
  dur: number;
  /** 動画の中で、この録画が始まる位置(秒) */
  offset: number;
}

export interface Video {
  /** 最初のメーター動画の名前(YYYY-MM-DD_HH-MM-SS) */
  id: string;
  /** YouTube の動画 ID(URL を貼るまでは無い) */
  youtube?: string;
  /** 動画全体の長さ(秒) */
  total?: number;
  clips: VideoClip[];
}

/** ログのある時刻が入っている動画と、その動画の中の位置 */
export interface VideoHit {
  video: Video;
  /** 動画の中の位置(秒) */
  sec: number;
}

/** YouTube の URL(watch?v= / youtu.be / shorts / live / embed)か、動画 ID そのものから ID を取り出す */
export function youtubeId(text: string): string | undefined {
  const s = text.trim();
  if (/^[\w-]{11}$/.test(s)) return s;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return undefined;
  }
  const host = u.hostname.replace(/^(www|m|music)\./, "");
  let id: string | null | undefined;
  if (host === "youtu.be") id = u.pathname.split("/")[1];
  else if (host === "youtube.com" || host === "youtube-nocookie.com") {
    id = u.searchParams.get("v") ?? /^\/(?:shorts|live|embed)\/([^/?#]+)/.exec(u.pathname)?.[1];
  }
  return id && /^[\w-]{11}$/.test(id) ? id : undefined;
}

/** 動画をその位置から開く URL */
export const watchUrl = (youtube: string, sec: number) =>
  `https://www.youtube.com/watch?v=${youtube}&t=${Math.max(0, Math.floor(sec))}s`;

/** 0:00 / 1:02:03 の形 */
export function videoTime(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** ある時刻(UNIX ミリ秒)が入っている動画。複数あれば URL を貼ってあるものを先に */
export function videoAt(videos: Video[], tMs: number): VideoHit | undefined {
  const t = tMs / 1000;
  const hits: VideoHit[] = [];
  for (const v of videos) {
    for (const c of v.clips) {
      if (t >= c.start && t < c.start + c.dur) {
        hits.push({ video: v, sec: c.offset + (t - c.start) });
        break;
      }
    }
  }
  return hits.sort((a, b) => Number(!!b.video.youtube) - Number(!!a.video.youtube))[0];
}

/**
 * ログの時間帯(UNIX ミリ秒)と重なる動画と、重なりの始まりの動画の中の位置。
 * 動画の古い順(同じ動画は 1 回だけ)
 */
export function videosInRange(videos: Video[], startMs: number, endMs: number): VideoHit[] {
  const a = startMs / 1000;
  const b = endMs / 1000;
  const out: VideoHit[] = [];
  for (const v of videos) {
    let best: VideoHit | undefined;
    for (const c of v.clips) {
      const from = Math.max(a, c.start);
      if (from >= Math.min(b, c.start + c.dur)) continue;
      const sec = c.offset + (from - c.start);
      if (!best || sec < best.sec) best = { video: v, sec };
    }
    if (best) out.push(best);
  }
  return out.sort((x, y) => x.video.clips[0].start - y.video.clips[0].start);
}

const API = `${import.meta.env.BASE_URL}api/videos`;

export async function fetchVideos(): Promise<Video[]> {
  const r = await fetch(API);
  return r.ok && r.headers.get("content-type")?.includes("json") ? r.json() : [];
}

/** 動画に YouTube の URL を貼る(空にすると外す)。全体の一覧を返す */
export async function setVideoUrl(id: string, url: string): Promise<Video[]> {
  const r = await fetch(`${API}/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ url }) });
  if (!r.ok) throw new Error(((await r.json().catch(() => ({}))) as { error?: string }).error ?? `保存できませんでした(${r.status})`);
  return r.json();
}
