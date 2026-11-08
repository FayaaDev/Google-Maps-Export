import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readConfig, run, splitBounds } from "./export.js";

const env = { GOOGLE_MAPS_API_KEY: "test-key", SEARCH_BOUNDS: "0,0,2,2", GRID_SIZE: "1" };
const directories = [];
const quiet = () => {};

afterEach(async () => {
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

async function config(overrides = {}) {
  const directory = await mkdtemp(join(tmpdir(), "maps-keywords-test-"));
  directories.push(directory);
  return {
    ...readConfig({ ...env, SEARCH_KEYWORDS: "coffee shops,bakeries" }),
    output: join(directory, "results.csv"),
    ...overrides,
  };
}

const place = (id, name = `Business ${id}`, latitude = 0.5, longitude = 0.5) => ({
  id, displayName: { text: name }, formattedAddress: "Test address",
  location: { latitude, longitude },
});

test("keyword config preserves the default and trimmed legacy single query", () => {
  expect(readConfig(env)).toMatchObject({ queries: ["coffee shops"], query: "coffee shops" });
  expect(readConfig({ ...env, SEARCH_QUERY: "  bakeries  " }))
    .toMatchObject({ queries: ["bakeries"], query: "bakeries" });
  expect(() => readConfig({ ...env, SEARCH_QUERY: "   " })).toThrow("SEARCH_QUERY");
});

test("keyword config trims Unicode keywords and removes only exact duplicates in order", () => {
  const cfg = readConfig({ ...env, SEARCH_KEYWORDS: "  مقاهي , Coffee shops,مقاهي, coffee shops ,Coffee shops,مخابز  " });
  expect(cfg.queries).toEqual(["مقاهي", "Coffee shops", "coffee shops", "مخابز"]);
  expect(cfg.query).toBe("مقاهي");
  expect(readConfig({ ...env, SEARCH_KEYWORDS: "  مخابز  " }).queries).toEqual(["مخابز"]);
});

test("SEARCH_KEYWORDS overrides SEARCH_QUERY, including a blank legacy query", () => {
  for (const legacy of ["ignored", ""]) {
    expect(readConfig({ ...env, SEARCH_KEYWORDS: "cafes,bakeries", SEARCH_QUERY: legacy }))
      .toMatchObject({ queries: ["cafes", "bakeries"], query: "cafes" });
  }
});

test("blank keyword lists and entries fail instead of falling back to SEARCH_QUERY", () => {
  for (const keywords of ["", "   ", ",", " , ", ",cafes", "cafes,", "cafes, ,bakeries", "cafes,,cafes"]) {
    expect(() => readConfig({ ...env, SEARCH_KEYWORDS: keywords, SEARCH_QUERY: "fallback" }))
      .toThrow("SEARCH_KEYWORDS");
  }
});

test("export filenames include all unique keywords with Unicode sanitization and explicit override", () => {
  expect(readConfig({ ...env, SEARCH_KEYWORDS: " ../../Cafes / Tea , مخابز , Cafes / Tea " }).output)
    .toMatch(/^cafes-tea-مخابز-cafes-tea-\d+\.csv$/);
  expect(readConfig({ ...env, SEARCH_KEYWORDS: "Cafes,مخابز,Cafes" }).output)
    .toMatch(/^cafes-مخابز-\d+\.csv$/);
  expect(readConfig({ ...env, SEARCH_KEYWORDS: "Cafe\u0301,مخابز" }).output)
    .toMatch(/^café-مخابز-\d+\.csv$/);
  expect(readConfig({ ...env, SEARCH_KEYWORDS: "!!!,???" }).output)
    .toMatch(/^places-\d+\.csv$/);
  expect(readConfig({ ...env, SEARCH_KEYWORDS: "cafes,bakeries", OUTPUT_CSV: "custom.csv" }).output)
    .toBe("custom.csv");
});

test("finishes every grid cell and page for one keyword before starting the next", async () => {
  const cfg = await config({ gridSize: 2 });
  const bodies = [];
  const stats = await run(cfg, async (url, options) => {
    const body = JSON.parse(options.body);
    bodies.push(body);
    return Response.json({
      places: [place("shared")],
      ...(!body.pageToken ? { nextPageToken: "same-token-for-each-cell-and-keyword" } : {}),
    });
  }, quiet);
  expect(stats).toEqual({ unique: 1, requests: 16, cells: 8, saturated: 0 });
  expect(bodies.map(body => body.textQuery)).toEqual([
    ...Array(8).fill("coffee shops"), ...Array(8).fill("bakeries"),
  ]);
  const bounds = splitBounds(cfg.bounds, cfg.gridSize);
  for (let keyword = 0; keyword < 2; keyword++) {
    for (let cell = 0; cell < 4; cell++) {
      const first = bodies[keyword * 8 + cell * 2];
      const second = bodies[keyword * 8 + cell * 2 + 1];
      const [south, west, north, east] = bounds[cell];
      expect(first).not.toHaveProperty("pageToken");
      expect(first.locationRestriction.rectangle).toEqual({
        low: { latitude: south, longitude: west }, high: { latitude: north, longitude: east },
      });
      expect(second).toEqual({ ...first, pageToken: "same-token-for-each-cell-and-keyword" });
    }
  }
  const lines = (await readFile(cfg.output, "utf8")).split("\r\n").filter(Boolean);
  expect(lines).toHaveLength(2);
  expect(lines[0]).toContain('"place_id"');
});

test("raw result saturation subdivides each keyword before moving to the next", async () => {
  const cfg = await config({ maxDepth: 1 });
  const bodies = [];
  const stats = await run(cfg, async (url, options) => {
    const body = JSON.parse(options.body);
    bodies.push(body);
    const call = (bodies.length - 1) % 7;
    return Response.json(call < 3 ? {
      places: Array.from({ length: 20 }, () => place("shared")),
      ...(call < 2 ? { nextPageToken: `page-${call + 2}` } : {}),
    } : {});
  }, quiet);
  expect(stats).toEqual({ unique: 1, requests: 14, cells: 10, saturated: 0 });
  expect(bodies.map(body => body.textQuery)).toEqual([
    ...Array(7).fill("coffee shops"), ...Array(7).fill("bakeries"),
  ]);
  for (const offset of [0, 7]) {
    expect(bodies[offset]).not.toHaveProperty("pageToken");
    expect(bodies[offset + 1].pageToken).toBe("page-2");
    expect(bodies[offset + 2].pageToken).toBe("page-3");
    const children = splitBounds(cfg.bounds, 2);
    for (let child = 0; child < 4; child++) {
      const body = bodies[offset + 3 + child];
      const [south, west, north, east] = children[child];
      expect(body).not.toHaveProperty("pageToken");
      expect(body.locationRestriction.rectangle).toEqual({
        low: { latitude: south, longitude: west }, high: { latitude: north, longitude: east },
      });
    }
  }
});

test("maximum-depth saturation and request totals accumulate across keywords", async () => {
  const cfg = await config({ maxDepth: 0 });
  let calls = 0;
  const stats = await run(cfg, async () => {
    const page = calls++ % 3;
    return Response.json({
      places: Array.from({ length: 20 }, () => place("shared")),
      ...(page < 2 ? { nextPageToken: `page-${page + 2}` } : {}),
    });
  }, quiet);
  expect(stats).toEqual({ unique: 1, requests: 6, cells: 2, saturated: 2 });
  expect(calls).toBe(6);
});

test("shared-ID dedup keeps the first keyword's fields and writes one CSV", async () => {
  const cfg = await config();
  const stats = await run(cfg, async (url, options) => {
    const { textQuery } = JSON.parse(options.body);
    return Response.json({ places: textQuery === "coffee shops"
      ? [place("shared", "Original name"), place("first-only")]
      : [place("shared", "Changed name", 1, 1), place("second-only")] });
  }, quiet);
  expect(stats).toEqual({ unique: 3, requests: 2, cells: 2, saturated: 0 });
  const csv = await readFile(cfg.output, "utf8");
  expect(csv.startsWith("\uFEFF")).toBe(true);
  const lines = csv.split("\r\n").filter(Boolean);
  expect(lines).toHaveLength(4);
  expect(lines[1]).toContain('"shared","Original name","Test address","0.5","0.5"');
  expect(lines[2]).toContain('"first-only"');
  expect(lines[3]).toContain('"second-only"');
  expect(csv).not.toContain("Changed name");
});

test("polygon exclusions do not claim IDs before later valid keyword matches", async () => {
  const cfg = await config({ polygon: [[0, 0], [0, 2], [2, 0]] });
  const stats = await run(cfg, async (url, options) => {
    const { textQuery } = JSON.parse(options.body);
    return Response.json({ places: textQuery === "coffee shops" ? [
      place("moves-inside", "Outside first", 1.5, 1.5),
      { id: "missing-location", displayName: { text: "Missing coordinates" } },
      place("kept", "Kept original"),
    ] : [
      place("moves-inside", "On boundary", 1, 1),
      place("missing-location", "Now located"),
      place("kept", "Outside replacement", 1.5, 1.5),
      place("always-outside", "Excluded", 1.5, 1.5),
    ] });
  }, quiet);
  expect(stats).toEqual({ unique: 3, requests: 2, cells: 2, saturated: 0 });
  const csv = await readFile(cfg.output, "utf8");
  expect(csv.split("\r\n").filter(Boolean)).toHaveLength(4);
  expect(csv).toContain('"moves-inside","On boundary"');
  expect(csv).toContain('"missing-location","Now located"');
  expect(csv).toContain('"kept","Kept original"');
  for (const excluded of ["Outside first", "Missing coordinates", "Outside replacement", "always-outside"]) {
    expect(csv).not.toContain(excluded);
  }
});

test("later keyword failure retains earlier rows and reports global attempted requests", async () => {
  const cfg = await config();
  const bodies = [];
  await expect(run(cfg, async (url, options) => {
    bodies.push(JSON.parse(options.body));
    if (bodies.length === 1) return Response.json({ places: [place("saved-first")], nextPageToken: "next" });
    if (bodies.length === 2) return Response.json({ places: [place("saved-page-two")] });
    return Response.json({ error: { message: "Quota exceeded" } }, { status: 429 });
  }, quiet)).rejects.toThrow("3 API requests attempted");
  expect(bodies.map(body => body.textQuery)).toEqual(["coffee shops", "coffee shops", "bakeries"]);
  expect(bodies[2]).not.toHaveProperty("pageToken");
  const csv = await readFile(cfg.output, "utf8");
  expect(csv).toContain('"saved-first"');
  expect(csv).toContain('"saved-page-two"');
  expect(csv.split("\r\n").filter(Boolean)).toHaveLength(3);
});

test("run still accepts a legacy config with query but no queries array", async () => {
  const cfg = await config({ query: "legacy bakery" });
  delete cfg.queries;
  const bodies = [];
  const stats = await run(cfg, async (url, options) => {
    bodies.push(JSON.parse(options.body));
    return Response.json({ places: [place("legacy")] });
  }, quiet);
  expect(stats).toEqual({ unique: 1, requests: 1, cells: 1, saturated: 0 });
  expect(bodies[0].textQuery).toBe("legacy bakery");
});
