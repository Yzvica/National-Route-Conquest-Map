import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { listTrips, simplify, tripLines } from "./trips.mjs";

const HEAD = "unix_s,lat,lon,alt_m,h_acc_m,v_acc_m,speed_ms,speed_acc_ms,course_deg,course_acc_deg,floor,speed_est_ms";
const row = (t, lat, lon, acc = 10, alt = 30) => `${t},${lat},${lon},${alt},${acc},5,10,1,90,5,,`;

describe("tripLines", () => {
  it("まっすぐな線は両端だけに間引き、精度の悪い点と飛びは捨てる", () => {
    const rows = [HEAD];
    for (let i = 0; i <= 100; i++) rows.push(row(1000 + i, 35, 139 + i * 0.0001));
    rows.splice(50, 0, row(1049.5, 35.5, 139.005)); // 1秒で50km 飛ぶ
    rows.splice(30, 0, row(1029.5, 35.01, 139.003, 1000)); // 基地局の測位(±1km)
    const r = tripLines(rows.join("\n") + "\n");
    expect(r.lines).toEqual([[[139, 35], [139.01, 35]]]);
    expect(r.gaps).toEqual([]);
    expect(r.m).toBeGreaterThan(900);
    expect(r.m).toBeLessThan(920);
    expect(r.first).toBe(1000);
    expect(r.last).toBe(1100);
  });

  it("点が3分より空いた間は点線(gaps)に分ける", () => {
    const csv = [HEAD, row(0, 35, 139), row(10, 35, 139.001), row(600, 35, 139.1), row(610, 35, 139.101)].join("\n");
    const r = tripLines(csv);
    expect(r.lines).toHaveLength(2);
    expect(r.gaps).toEqual([[[139.001, 35], [139.1, 35]]]);
  });

  it("列がなければエラー", () => {
    expect(() => tripLines("a,b\n1,2")).toThrow();
  });
});

describe("simplify", () => {
  it("曲がり角は残す", () => {
    const l = [[139, 35], [139.005, 35], [139.01, 35], [139.01, 35.005], [139.01, 35.01]];
    expect(simplify(l)).toEqual([[139, 35], [139.01, 35], [139.01, 35.01]]);
  });
});

describe("listTrips", () => {
  it("trips フォルダの移動を新しい順に返し、車と位置のないものは出さない", () => {
    const root = mkdtempSync(join(tmpdir(), "kokudo-trips-"));
    const put = (id, meta, csv) => {
      mkdirSync(join(root, "trips", id), { recursive: true });
      if (meta) writeFileSync(join(root, "trips", id, "meta.json"), JSON.stringify(meta));
      if (csv) writeFileSync(join(root, "trips", id, "location.csv"), csv);
    };
    const csv = [HEAD, row(0, 35, 139, 10, 100), row(60, 35.1, 139.1, 10, 12000)].join("\n");
    put("a", { mode: "train", start: "2026-11-08T01:00:00.000Z", end: "2026-11-08T02:00:00.000Z", distanceM: 52000 }, csv);
    put("b", { mode: "plane", start: "2026-11-09T01:00:00.000Z", maxAltitudeM: 12388.4 }, csv);
    put("c", { mode: "car" }, csv);
    put("d", { mode: "train" }, null);
    put("e", null, csv); // meta.json がまだ届いていない
    const trips = listTrips(root);
    expect(trips.map((t) => [t.id, t.mode])).toEqual([["b", "plane"], ["a", "train"], ["e", "other"]]);
    expect(trips[0].maxAltM).toBe(12388);
    expect(trips[1].m).toBe(52000);
    expect(trips[2].start).toBe("1970-01-01T00:00:00.000Z");
    expect(listTrips(join(root, "none"))).toEqual([]);
  });
});

describe("listTrips(補った位置)", () => {
  it("サーバーが線路に沿って補った location_filled.csv があればそちらで線を作る", () => {
    const root = mkdtempSync(join(tmpdir(), "kokudo-trips-"));
    const dir = join(root, "trips", "t");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "meta.json"), JSON.stringify({ mode: "train" }));
    writeFileSync(join(dir, "location.csv"), [HEAD, row(0, 35, 139), row(600, 35, 139.1)].join("\n"));
    expect(listTrips(root)[0].gaps).toHaveLength(1);
    // 補った点は精度・速度が空(src=road)
    const filled = [`${HEAD},src`, `${row(0, 35, 139)},gps`];
    for (let t = 10; t < 600; t += 10) {
      const f = t / 600;
      filled.push(`${t},${35 + 0.05 * (1 - Math.abs(1 - 2 * f))},${139 + 0.1 * f},,,,,,,,,15,road`);
    }
    filled.push(`${row(600, 35, 139.1)},gps`);
    writeFileSync(join(dir, "location_filled.csv"), filled.join("\n"));
    const t = listTrips(root)[0];
    expect(t.gaps).toEqual([]);
    expect(t.lines).toEqual([[[139, 35], [139.05, 35.05], [139.1, 35]]]);
  });
});
