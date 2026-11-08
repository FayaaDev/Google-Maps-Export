import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { insidePolygon, readConfig, run } from "./export.js";

const polygon = [
  [24.826287813562946, 46.614195846844574],
  [24.79372190372786, 46.63058950768139],
  [24.778838461219557, 46.5946264506624],
  [24.775175769748827, 46.572653795299956],
  [24.796682794521278, 46.56492903364911],
];
const bounds = [24.775175769748827, 46.56492903364911, 24.826287813562946, 46.63058950768139];
const inside = { latitude: 24.795, longitude: 46.595 };
const outside = { latitude: 24.825, longitude: 46.63 };
const env = { GOOGLE_MAPS_API_KEY: "test-key", GRID_SIZE: "1" };
const quiet = () => {};
const directories = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

async function config(overrides = {}) {
  const directory = await mkdtemp(join(tmpdir(), "maps-boundary-test-"));
  directories.push(directory);
  return {
    ...readConfig({ ...env, SEARCH_POLYGON: JSON.stringify(polygon) }),
    output: join(directory, "results.csv"),
    ...overrides,
  };
}

const place = (id, location = inside) => ({
  id, displayName: { text: `Coffee ${id}` }, location,
});

test("provided latitude/longitude polygon includes its interior but excludes its bounding-box corners", () => {
  for (const ring of [polygon, [...polygon].reverse()]) {
    expect(insidePolygon(inside, ring)).toBe(true);
    expect(insidePolygon(outside, ring)).toBe(false);
    expect(insidePolygon({ latitude: 24.9, longitude: 46.6 }, ring)).toBe(false);
    expect(insidePolygon({ latitude: inside.longitude, longitude: inside.latitude }, ring)).toBe(false);
  }
});

test("polygon vertices and edge midpoints are included in either winding order", () => {
  for (const ring of [polygon, [...polygon].reverse()]) {
    for (let i = 0; i < ring.length; i++) {
      const [latitude, longitude] = ring[i];
      const next = ring[(i + 1) % ring.length];
      expect(insidePolygon({ latitude, longitude }, ring)).toBe(true);
      expect(insidePolygon({
        latitude: (latitude + next[0]) / 2,
        longitude: (longitude + next[1]) / 2,
      }, ring)).toBe(true);
    }
  }
});

test("concave polygons exclude their notch, in either winding order", () => {
  const concave = [[0, 0], [0, 4], [1, 4], [1, 1], [4, 1], [4, 0]];
  for (const ring of [concave, [...concave].reverse()]) {
    expect(insidePolygon({ latitude: 0.5, longitude: 3 }, ring)).toBe(true);
    expect(insidePolygon({ latitude: 3, longitude: 0.5 }, ring)).toBe(true);
    expect(insidePolygon({ latitude: 2, longitude: 2 }, ring)).toBe(false);
    expect(insidePolygon({ latitude: 1, longitude: 2 }, ring)).toBe(true);
    expect(insidePolygon({ latitude: 1, longitude: 1 }, ring)).toBe(true);
  }
});

test("missing, nonnumeric and nonfinite location coordinates are excluded", () => {
  for (const location of [
    undefined, null, {}, { latitude: inside.latitude }, { longitude: inside.longitude },
    { latitude: "24.795", longitude: inside.longitude },
    { latitude: inside.latitude, longitude: "46.595" },
    { latitude: null, longitude: inside.longitude },
    { latitude: inside.latitude, longitude: null },
    { latitude: NaN, longitude: inside.longitude },
    { latitude: inside.latitude, longitude: NaN },
    { latitude: Infinity, longitude: inside.longitude },
    { latitude: inside.latitude, longitude: -Infinity },
  ]) {
    expect(insidePolygon(location, polygon)).toBe(false);
  }
});

test("SEARCH_POLYGON derives geographic bounds and overrides SEARCH_BOUNDS", () => {
  for (const SEARCH_BOUNDS of [undefined, "0,0,1,1", "invalid bounds"]) {
    const cfg = readConfig({ ...env, SEARCH_BOUNDS, SEARCH_POLYGON: JSON.stringify(polygon) });
    expect(cfg.polygon).toEqual(polygon);
    expect(cfg.bounds).toEqual(bounds);
  }
  const reversed = readConfig({ ...env, SEARCH_POLYGON: JSON.stringify([...polygon].reverse()) });
  expect(reversed.bounds).toEqual(bounds);
});

test("SEARCH_POLYGON accepts a nonzero-area triangle", () => {
  const triangle = [[0, 0], [0, 1], [1, 0]];
  expect(readConfig({ ...env, SEARCH_POLYGON: JSON.stringify(triangle) }).polygon).toEqual(triangle);
});

test("SEARCH_POLYGON rejects malformed JSON, invalid points and degenerate polygons", () => {
  const invalid = [
    "", "not JSON", "[[0,0],", "null", "{}", '"polygon"',
    JSON.stringify([]), JSON.stringify([[0, 0], [1, 1]]),
    JSON.stringify([[0, 0], [1, 1], [0, 0], [1, 1]]),
    JSON.stringify([[0, 0], [1, 1], [2, 2]]),
    JSON.stringify([[0, 0], [0, 1], [0, 2]]),
    JSON.stringify([[0, 0], [0, 1], [1, 0], null]),
    JSON.stringify([[0, 0], [0, 1], { latitude: 1, longitude: 0 }]),
    JSON.stringify([[0, 0], [0, 1], [1]]),
    JSON.stringify([[0, 0], [0, 1], [1, 0, 2]]),
    JSON.stringify([[0, 0], [0, 1], ["1", 0]]),
    JSON.stringify([[0, 0], [0, 1], [true, 0]]),
    JSON.stringify([[0, 0], [0, 1], [null, 0]]),
    JSON.stringify([[0, 0], [0, 1], [91, 0]]),
    JSON.stringify([[0, 0], [0, 1], [-91, 0]]),
    JSON.stringify([[0, 0], [0, 1], [1, 181]]),
    JSON.stringify([[0, 0], [0, 1], [1, -181]]),
    "[[0,0],[0,1],[1e400,0]]",
  ];
  for (const SEARCH_POLYGON of invalid) {
    expect(() => readConfig({ ...env, SEARCH_BOUNDS: "0,0,2,2", SEARCH_POLYGON }))
      .toThrow("SEARCH_POLYGON");
  }
});

test("absent SEARCH_POLYGON preserves rectangle configuration and bounds validation", () => {
  const cfg = readConfig({ ...env, SEARCH_BOUNDS: "24,46,25,47" });
  expect(cfg.bounds).toEqual([24, 46, 25, 47]);
  expect(cfg.polygon == null).toBe(true);
  expect(() => readConfig(env)).toThrow("SEARCH_BOUNDS");
  expect(() => readConfig({ ...env, SEARCH_BOUNDS: "invalid" })).toThrow("SEARCH_BOUNDS");
});

test("filters before deduplication and CSV while paginating past entirely excluded pages", async () => {
  const cfg = await config();
  const bodies = [];
  const replies = [
    { places: [place("recovered", outside), place("missing", null), place("outside", outside)], nextPageToken: "second" },
    { places: [place("recovered"), place("vertex", { latitude: polygon[0][0], longitude: polygon[0][1] })], nextPageToken: "third" },
    { places: [place("recovered"), place("last")] },
  ];
  const stats = await run(cfg, async (url, options) => {
    bodies.push(JSON.parse(options.body));
    if (!replies.length) throw new Error("Unexpected additional request");
    return Response.json(replies.shift());
  }, quiet);
  expect(stats).toEqual({ unique: 3, requests: 3, cells: 1, saturated: 0 });
  expect(bodies[0].locationRestriction.rectangle).toEqual({
    low: { latitude: bounds[0], longitude: bounds[1] },
    high: { latitude: bounds[2], longitude: bounds[3] },
  });
  expect(bodies[1]).toEqual({ ...bodies[0], pageToken: "second" });
  expect(bodies[2]).toEqual({ ...bodies[0], pageToken: "third" });
  const csv = await readFile(cfg.output, "utf8");
  expect(csv.split("\r\n").filter(Boolean)).toHaveLength(4);
  expect(csv).toContain('"recovered","Coffee recovered"');
  expect(csv).toContain('"vertex","Coffee vertex"');
  expect(csv).toContain('"last","Coffee last"');
  expect(csv).not.toContain('"outside"');
  expect(csv).not.toContain('"missing"');
});

test("60 entirely excluded raw results still subdivide the parent at maxDepth 1", async () => {
  const cfg = await config({ maxDepth: 1, gridSize: 1 });
  let calls = 0;
  const stats = await run(cfg, async () => {
    calls++;
    if (calls > 7) throw new Error("Unexpected additional request");
    if (calls <= 3) return Response.json({
      places: Array.from({ length: 20 }, (_, i) => place(`outside-${(calls - 1) * 20 + i}`, outside)),
      ...(calls < 3 ? { nextPageToken: `page-${calls + 1}` } : {}),
    });
    return Response.json({ places: [] });
  }, quiet);
  expect(stats).toEqual({ unique: 0, requests: 7, cells: 5, saturated: 0 });
  expect(calls).toBe(7);
  expect((await readFile(cfg.output, "utf8")).split("\r\n").filter(Boolean)).toHaveLength(1);
});

test("rectangle-only exports still retain places outside a polygon or without locations", async () => {
  const rectangle = readConfig({ ...env, SEARCH_BOUNDS: bounds.join(",") });
  const cfg = await config({
    bounds: rectangle.bounds,
    polygon: undefined,
  });
  const stats = await run(cfg, async () => Response.json({
    places: [place("outside", outside), place("missing", null)],
  }), quiet);
  expect(stats).toEqual({ unique: 2, requests: 1, cells: 1, saturated: 0 });
  const csv = await readFile(cfg.output, "utf8");
  expect(csv).toContain('"outside"');
  expect(csv).toContain('"missing"');
});
