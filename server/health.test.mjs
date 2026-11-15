import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { collectHealth, renderHealthHtml } from "./health.mjs";
import { createGmaps } from "./gmaps.mjs";

function setup() {
  const root = mkdtempSync(join(tmpdir(), "health-"));
  mkdirSync(join(root, "data"));
  mkdirSync(join(root, ".git", "refs", "heads"), { recursive: true });
  writeFileSync(join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
  writeFileSync(join(root, ".git", "refs", "heads", "main"), "abc1234def\n");
  const raw = join(root, "raw");
  mkdirSync(join(raw, "20261113-101500"), { recursive: true });
  mkdirSync(join(raw, "20261101-090000"));
  mkdirSync(join(raw, "trips", "20261112-080000"), { recursive: true });
  return { root, raw };
}

const ctx = (root, raw, judge = { enabled: true, pending: 0, running: null, last: null }) => ({
  root,
  rawLogDir: raw,
  startedCommit: "abc1234def",
  judge: () => judge,
  weatherPending: () => [{ dir: "x", since: "2026-11-10T00:00:00Z" }],
  gmaps: createGmaps(join(root, "data")).status,
  logs: () => [{ date: "2026-11-12" }, { date: "2026-11-13" }],
  os: { total: 8 * 2 ** 30, free: 3 * 2 ** 30 },
  judgeMemory: { running: false, limitMB: 1024, lowFreeMB: 1500, startedAt: null, heapMB: null, peakHeapMB: null, lastPeakHeapMB: 820, oom: null },
});

describe("collectHealth", () => {
  it("正常なときは注意なし", () => {
    const { root, raw } = setup();
    writeFileSync(join(root, "data", "built.txt"), "abc1234def\r\n");
    // PowerShell 5 の Add-Content(シフトJIS)
    writeFileSync(join(root, "data", "server.log"), Buffer.from([0x8b, 0x4e, 0x93, 0xae])); // 起動
    const h = collectHealth(ctx(root, raw));
    expect(h.warnings).toEqual([]);
    expect(h.ok).toBe(true);
    expect(h.code.commit).toBe("abc1234def");
    expect(h.code.builtIsHead).toBe(true);
    expect(h.rawlogs.latestDrive).toBe("20261113-101500");
    expect(h.rawlogs.latestTrip).toBe("20261112-080000");
    expect(h.logs).toEqual({ count: 2, latestDate: "2026-11-13" });
    expect(h.weather).toEqual({ pending: 1, oldest: "2026-11-10T00:00:00Z" });
    expect(h.restarts.logTail).toEqual(["起動"]);
    expect(renderHealthHtml(h)).toContain("正常");
  });

  it("自動更新の失敗・未ビルド・止まった判定を注意に出す", () => {
    const { root, raw } = setup();
    writeFileSync(join(root, "data", "built.txt"), "old\n");
    writeFileSync(join(root, "data", "update.failed"), "﻿npm ci に失敗");
    const h = collectHealth(ctx(root, raw, { enabled: true, pending: 3, running: null, last: null }));
    expect(h.ok).toBe(false);
    expect(h.warnings.join("\n")).toMatch(/自動更新が失敗/);
    expect(h.warnings.join("\n")).toMatch(/まだビルドされていません/);
    expect(h.warnings.join("\n")).toMatch(/判定待ちのログが 3 件/);
    expect(renderHealthHtml(h)).toContain("注意 3件");
  });

  it("空きメモリと node・判定の処理の使用量を出し、少ないときや上限で止まったときは注意に出す", () => {
    const { root, raw } = setup();
    writeFileSync(join(root, "data", "built.txt"), "abc1234def\n");
    const ok = collectHealth(ctx(root, raw));
    expect(ok.memory).toMatchObject({ totalMB: 8192, freeMB: 3072, judgeWorker: { limitMB: 1024, lastPeakHeapMB: 820 } });
    expect(ok.memory.node.rssMB).toBeGreaterThan(0);
    expect(ok.memory.node.heapUsedMB).toBeGreaterThan(0);
    expect(renderHealthHtml(ok)).toContain("3072 MB / 8192 MB");
    expect(renderHealthHtml(ok)).toContain("前回の判定後の最大 820 MB");

    const oomAt = new Date(Date.now() - 3600_000).toISOString();
    const low = collectHealth({
      ...ctx(root, raw),
      os: { total: 8 * 2 ** 30, free: 700 * 2 ** 20 },
      judgeMemory: { running: true, limitMB: 1024, heapMB: 400, peakHeapMB: 900, lastPeakHeapMB: null, oom: { at: oomAt, limitMB: 1024, freeMB: 600 } },
    });
    expect(low.ok).toBe(false);
    expect(low.warnings.join("\n")).toMatch(/空きメモリが少なくなっています\(残り 700 MB/);
    expect(low.warnings.join("\n")).toMatch(/メモリの上限\(1024 MB\)を超えて止まりました/);
    const html = renderHealthHtml(low);
    expect(html).toContain("ヒープ 400 MB(判定後の最大 900 MB)");
    expect(html).toContain("(少ない)");

    // 1日たてば上限で止まったことは注意に出さない(画面には残る)
    const old = collectHealth({ ...ctx(root, raw), judgeMemory: { running: false, limitMB: 1024, oom: { at: "2026-01-01T00:00:00Z", limitMB: 1024 } } });
    expect(old.warnings).toEqual([]);
  });
});
