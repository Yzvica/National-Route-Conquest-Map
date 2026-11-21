import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createGmaps } from "./gmaps.mjs";

describe("Google の Routes API の中継", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("Essentials の使い方で問い合わせ、上限を超えたら 429 にする", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gmaps-"));
    writeFileSync(join(dir, "google-maps.json"), JSON.stringify({ key: "k", routesDailyLimit: 2 }));
    const calls = [];
    vi.stubGlobal("fetch", async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ routes: [{ distanceMeters: 1234, duration: "300s", polyline: { encodedPolyline: "abc" } }] }), { status: 200 });
    });
    const g = createGmaps(dir);
    const p = { lat: 38.26, lon: 140.88 };
    const ways = Array.from({ length: 10 }, () => p);
    expect((await g.route({ origin: p, destination: p, waypoints: ways }))[0]).toBe(400);
    expect((await g.route({ origin: p, destination: { lat: "x" }, waypoints: [] }))[0]).toBe(400);
    const [code, out] = await g.route({ origin: p, destination: p, waypoints: ways.slice(0, 9) });
    expect(code).toBe(200);
    expect(out).toEqual({ distance: 1234, duration: 300, polyline: "abc" });
    const body = JSON.parse(calls[0].init.body);
    expect(body.intermediates.length).toBe(9);
    expect(body.routingPreference).toBe("TRAFFIC_UNAWARE");
    expect(calls[0].init.headers["X-Goog-Api-Key"]).toBe("k");
    await g.route({ origin: p, destination: p, waypoints: [] });
    expect((await g.route({ origin: p, destination: p, waypoints: [] }))[0]).toBe(429);
    expect(calls.length).toBe(2);
    expect(g.status().routes).toMatchObject({ today: 2, dailyLimit: 2, overLimit: true });
  });
});
