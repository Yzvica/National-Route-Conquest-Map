import type { Coverage } from "./types";

const KEY = "nrcm:coverage:v1";
const LOGS_KEY = "nrcm:logs:v1";

export interface LogEntry {
  name: string;
  importedAt: string;
  points: number;
}

// 記録は自分のブラウザの中だけに保存する(サーバーには送らない)
export function loadCoverage(): Coverage {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? new Map(Object.entries(JSON.parse(raw) as Record<string, number>)) : new Map();
  } catch {
    return new Map();
  }
}

export function saveCoverage(c: Coverage) {
  try {
    localStorage.setItem(KEY, JSON.stringify(Object.fromEntries(c)));
  } catch (e) {
    console.warn("走行記録を保存できませんでした", e);
  }
}

export function loadLogs(): LogEntry[] {
  try {
    return JSON.parse(localStorage.getItem(LOGS_KEY) ?? "[]");
  } catch {
    return [];
  }
}

export function saveLogs(logs: LogEntry[]) {
  try {
    localStorage.setItem(LOGS_KEY, JSON.stringify(logs));
  } catch {
    /* 履歴は表示用なので保存できなくても続ける */
  }
}

export function exportBackup(c: Coverage, logs: LogEntry[]): string {
  return JSON.stringify({ coverage: Object.fromEntries(c), logs });
}

export function importBackup(text: string): { coverage: Coverage; logs: LogEntry[] } {
  const j = JSON.parse(text);
  return { coverage: new Map(Object.entries(j.coverage ?? {})), logs: j.logs ?? [] };
}
