import type { Coverage } from "./types";

export interface LogEntry {
  name: string;
  importedAt: string;
  points: number;
}

/** 区間を通った日 [初めて, 最後](YYYY-MM-DD) */
export type PassDates = [string, string];

export interface Record {
  coverage: Coverage;
  /** 区間ID → 通った日。日付を記録する前に取り込んだ区間にはない */
  dates: Map<string, PassDates>;
  logs: LogEntry[];
}

interface RecordJson {
  coverage: { [id: string]: number };
  dates?: { [id: string]: PassDates };
  logs: LogEntry[];
}

const KEY = "nrcm:coverage:v1";
const LOGS_KEY = "nrcm:logs:v1";
const API = `${import.meta.env.BASE_URL}api/record`;

const DATES_KEY = "nrcm:dates:v1";

export const emptyRecord = (): Record => ({ coverage: new Map(), dates: new Map(), logs: [] });

const toRecord = (j: RecordJson): Record => ({
  coverage: new Map(Object.entries(j.coverage ?? {})),
  dates: new Map(Object.entries(j.dates ?? {})),
  logs: j.logs ?? [],
});
const toJson = (r: Record): RecordJson => ({
  coverage: Object.fromEntries(r.coverage),
  dates: Object.fromEntries(r.dates),
  logs: r.logs,
});

/**
 * 走行記録の保存先。MiniPC のサーバー(server/server.mjs)から開いたときはサーバーに保存して
 * 全端末で共有し、サーバーがないとき(npm run dev 単体など)はこのブラウザの中に保存する。
 */
export interface RecordStore {
  readonly shared: boolean;
  load(): Promise<Record>;
  /** 追加分を保存し、ほかの端末の分も含めた最新の記録を返す */
  add(added: Record): Promise<Record>;
  clear(): Promise<void>;
}

class ServerStore implements RecordStore {
  readonly shared = true;

  async load() {
    const res = await fetch(API);
    if (!res.ok) throw new Error(`記録を読み込めませんでした(${res.status})`);
    return toRecord(await res.json());
  }

  async add(added: Record) {
    const res = await fetch(API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(toJson(added)),
    });
    if (!res.ok) throw new Error(`記録を保存できませんでした(${res.status})`);
    return toRecord(await res.json());
  }

  async clear() {
    await fetch(API, { method: "DELETE" });
  }
}

class LocalStore implements RecordStore {
  readonly shared = false;

  async load(): Promise<Record> {
    try {
      return toRecord({
        coverage: JSON.parse(localStorage.getItem(KEY) ?? "{}"),
        dates: JSON.parse(localStorage.getItem(DATES_KEY) ?? "{}"),
        logs: JSON.parse(localStorage.getItem(LOGS_KEY) ?? "[]"),
      });
    } catch {
      return emptyRecord();
    }
  }

  async add(added: Record) {
    const cur = await this.load();
    const merged = mergeRecord(cur, added);
    try {
      localStorage.setItem(KEY, JSON.stringify(Object.fromEntries(merged.coverage)));
      localStorage.setItem(DATES_KEY, JSON.stringify(Object.fromEntries(merged.dates)));
      localStorage.setItem(LOGS_KEY, JSON.stringify(merged.logs));
    } catch (e) {
      console.warn("走行記録を保存できませんでした", e);
    }
    return merged;
  }

  async clear() {
    try {
      localStorage.removeItem(KEY);
      localStorage.removeItem(DATES_KEY);
      localStorage.removeItem(LOGS_KEY);
    } catch {
      /* 消せなくても表示は空にする */
    }
  }
}

export function mergeRecord(base: Record, add: Record): Record {
  const coverage = new Map(base.coverage);
  for (const [id, r] of add.coverage) coverage.set(id, Math.max(coverage.get(id) ?? 0, r));
  const dates = new Map(base.dates);
  for (const [id, d] of add.dates) dates.set(id, mergeDates(dates.get(id), d));
  return { coverage, dates, logs: [...base.logs, ...add.logs] };
}

/** 初めて通った日は早い方、最後に通った日は遅い方を残す(server/server.mjs と同じ規則) */
export function mergeDates(a: PassDates | undefined, b: PassDates): PassDates {
  if (!a) return b;
  return [a[0] < b[0] ? a[0] : b[0], a[1] > b[1] ? a[1] : b[1]];
}

/** サーバーがあればサーバー、なければブラウザ内の保存先を返す */
export async function openStore(): Promise<RecordStore> {
  try {
    const res = await fetch(API);
    const isJson = res.headers.get("content-type")?.includes("application/json");
    if (res.ok && isJson) {
      const server = new ServerStore();
      // このブラウザだけに残っていた記録があれば、共有の記録に移す
      const local = new LocalStore();
      const old = await local.load();
      if (old.coverage.size > 0) {
        await server.add(old);
        await local.clear();
      }
      return server;
    }
  } catch {
    /* サーバーなし */
  }
  return new LocalStore();
}

export function exportBackup(r: Record): string {
  return JSON.stringify(toJson(r));
}

export function importBackup(text: string): Record {
  return toRecord(JSON.parse(text));
}
