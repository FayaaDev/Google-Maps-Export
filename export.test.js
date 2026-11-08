import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { csvRow, readConfig, run, splitBounds } from "./export.js";

const directories = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

async function config(overrides = {}) {
  const directory = await mkdtemp(join(tmpdir(), "maps-export-test-"));
  directories.push(directory);
  return {
    ...readConfig({ GOOGLE_MAPS_API_KEY: "test-key", SEARCH_BOUNDS: "24.77,46.58,24.84,46.65", GRID_SIZE: "1" }),
    output: join(directory, "results.csv"),
    ...overrides,
  };
}

const place = id => ({
  id, displayName: { text: `Coffee ${id}` }, formattedAddress: "Al Malqa, Riyadh",
  location: { latitude: 24.8, longitude: 46.6 },
});
const quiet = () => {};

test("validates environment before making requests", () => {
  expect(() => readConfig({})).toThrow("GOOGLE_MAPS_API_KEY");
  for (const bounds of ["", "24,46,23,47", "24,46,25,181", "24,wat,25,47", "24.77,,24.84,46.65"]) {
    expect(() => readConfig({ GOOGLE_MAPS_API_KEY: "key", SEARCH_BOUNDS: bounds })).toThrow("SEARCH_BOUNDS");
  }
  expect(() => readConfig({ GOOGLE_MAPS_API_KEY: "key", SEARCH_BOUNDS: "24,46,25,47", GRID_SIZE: "0" })).toThrow("GRID_SIZE");
});

test("tiles a rectangle without gaps", () => {
  expect(splitBounds([0, 0, 2, 2], 2)).toEqual([
    [0, 0, 1, 1], [0, 1, 1, 2], [1, 0, 2, 1], [1, 1, 2, 2],
  ]);
});

test("names exports after the chosen keyword unless OUTPUT_CSV overrides it", () => {
  const env = { GOOGLE_MAPS_API_KEY: "key", SEARCH_BOUNDS: "24,46,25,47" };
  expect(readConfig({ ...env, SEARCH_QUERY: "Bakeries in Riyadh" }).output)
    .toMatch(/^bakeries-in-riyadh-\d+\.csv$/);
  expect(readConfig({ ...env, SEARCH_QUERY: "مخابز" }).output)
    .toMatch(/^مخابز-\d+\.csv$/);
  expect(readConfig({ ...env, SEARCH_QUERY: "../../Bakeries / Cakes" }).output)
    .toMatch(/^bakeries-cakes-\d+\.csv$/);
  expect(readConfig({ ...env, SEARCH_QUERY: "!!!" }).output)
    .toMatch(/^places-\d+\.csv$/);
  expect(readConfig({ ...env, SEARCH_QUERY: "Bakeries", OUTPUT_CSV: "custom.csv" }).output)
    .toBe("custom.csv");
});

test("escapes CSV quotes, commas, newlines, Arabic and spreadsheet formulas", () => {
  expect(csvRow(['Cafe "A", B\nC', "مقهى", null, "=SUM(1,2)", "  +1"]))
    .toBe('"Cafe ""A"", B\nC","مقهى","","\'=SUM(1,2)","\'  +1"\r\n');
  expect(csvRow([-33.86, -70.67])).toBe('"-33.86","-70.67"\r\n');
});

test("paginates with unchanged bounds and deduplicates IDs", async () => {
  const cfg = await config();
  const bodies = [];
  const logs = [];
  const replies = [
    { places: [place("one")], nextPageToken: "page-two" },
    { places: [place("one"), place("two")] },
  ];
  const stats = await run(cfg, async (url, options) => {
    expect(url).toBe("https://places.googleapis.com/v1/places:searchText");
    expect(options.headers["X-Goog-Api-Key"]).toBe("test-key");
    bodies.push(JSON.parse(options.body));
    return Response.json(replies.shift());
  }, message => logs.push(message));
  expect(stats).toEqual({ unique: 2, requests: 2, cells: 1, saturated: 0 });
  expect(logs.filter(message => message.startsWith("API request #"))).toEqual([
    "API request #1: cell 1/1, page 1.",
    "API request #2: cell 1/1, page 2.",
  ]);
  expect(logs.at(-1)).toContain("Finished: 2 API requests attempted");
  expect(bodies[0]).toMatchObject({ textQuery: "coffee shops", pageSize: 20,
    locationRestriction: { rectangle: {
      low: { latitude: 24.77, longitude: 46.58 }, high: { latitude: 24.84, longitude: 46.65 },
    } },
  });
  expect(bodies[1]).toEqual({ ...bodies[0], pageToken: "page-two" });
  const csv = await readFile(cfg.output, "utf8");
  expect(csv.startsWith("\uFEFF")).toBe(true);
  expect(csv.split("\r\n").filter(Boolean)).toHaveLength(3);
  expect(csv).not.toContain("test-key");
});

test("empty cells do not stop searches of neighboring cells", async () => {
  const cfg = await config({ gridSize: 2 });
  let calls = 0;
  const stats = await run(cfg, async () => {
    calls++;
    return Response.json(calls === 4 ? { places: [place("last")] } : {});
  }, quiet);
  expect(stats).toEqual({ unique: 1, requests: 4, cells: 4, saturated: 0 });
});

test("requests and exports additional business fields, preserving zero ratings/counts", async () => {
  const cfg = await config();
  const details = {
    ...place("details"), rating: 4.7, userRatingCount: 123,
    internationalPhoneNumber: "+966 11 123 4567", websiteUri: "https://example.com",
    primaryType: "coffee_shop", businessStatus: "OPERATIONAL",
    googleMapsUri: "https://maps.google.com/?cid=123",
  };
  await run(cfg, async (url, options) => {
    for (const field of ["rating", "userRatingCount", "internationalPhoneNumber", "websiteUri", "primaryType", "businessStatus", "googleMapsUri"]) {
      expect(options.headers["X-Goog-FieldMask"].split(",")).toContain(`places.${field}`);
    }
    return Response.json({ places: [details, { ...place("zero"), rating: 0, userRatingCount: 0 }, place("missing")] });
  }, quiet);
  const csv = await readFile(cfg.output, "utf8");
  const lines = csv.replace(/^\uFEFF/, "").trimEnd().split("\r\n");
  expect(lines[0]).toBe(csvRow([
    "place_id", "name", "address", "latitude", "longitude", "rating", "rating_count",
    "phone", "website", "category", "business_status", "google_maps_url",
  ]).trimEnd());
  expect(lines[1]).toBe(csvRow([
    "details", "Coffee details", "Al Malqa, Riyadh", 24.8, 46.6, 4.7, 123,
    "+966 11 123 4567", "https://example.com", "coffee_shop", "OPERATIONAL", "https://maps.google.com/?cid=123",
  ]).trimEnd());
  expect(lines[2]).toContain('"0","0"');
  expect(lines[3]).toBe(csvRow(["missing", "Coffee missing", "Al Malqa, Riyadh", 24.8, 46.6, "", "", "", "", "", "", ""]).trimEnd());
});

test("an empty page terminates pagination even if it carries a token", async () => {
  const cfg = await config();
  const stats = await run(cfg, async () => Response.json({ places: [], nextPageToken: "unused" }), quiet);
  expect(stats.requests).toBe(1);
});

test("subdivides capped cells and deduplicates child matches", async () => {
  const cfg = await config({ maxDepth: 1 });
  let calls = 0;
  const stats = await run(cfg, async () => {
    calls++;
    if (calls <= 3) return Response.json({
      places: Array.from({ length: 20 }, (_, i) => place(String((calls - 1) * 20 + i))),
      ...(calls < 3 ? { nextPageToken: `page-${calls + 1}` } : {}),
    });
    return Response.json({ places: [place("0"), place("child")] });
  }, quiet);
  expect(stats).toEqual({ unique: 61, requests: 7, cells: 5, saturated: 0 });
});

test("warns and terminates if dense cells reach maximum depth", async () => {
  const cfg = await config({ maxDepth: 0 });
  let calls = 0;
  const logs = [];
  const stats = await run(cfg, async () => {
    calls++;
    return Response.json({
      places: Array.from({ length: 20 }, (_, i) => place(`${calls}-${i}`)),
      ...(calls < 3 ? { nextPageToken: String(calls) } : {}),
    });
  }, message => logs.push(message));
  expect(stats.saturated).toBe(1);
  expect(stats.requests).toBe(3);
  expect(logs.join("\n")).toContain("MAX_DEPTH");
});

test("preserves completed pages on API failure without retrying", async () => {
  const cfg = await config();
  let calls = 0;
  await expect(run(cfg, async () => {
    calls++;
    return calls === 1
      ? Response.json({ places: [place("saved")], nextPageToken: "next" })
      : Response.json({ error: { message: "Quota exceeded" } }, { status: 429 });
  }, quiet)).rejects.toThrow("2 API requests attempted");
  expect(calls).toBe(2);
  expect(await readFile(cfg.output, "utf8")).toContain('"saved"');
});

test("reports an attempted request on network failure", async () => {
  const cfg = await config();
  const logs = [];
  await expect(run(cfg, async () => { throw new Error("Connection failed"); }, message => logs.push(message)))
    .rejects.toThrow("1 API requests attempted");
  expect(logs).toEqual(["Keyword 1/1: coffee shops", "API request #1: cell 1/1, page 1."]);
});

test("rejects malformed Google responses", async () => {
  for (const data of [null, [], { places: {} }, { places: [{}] }, { nextPageToken: 4 }]) {
    const cfg = await config();
    await expect(run(cfg, async () => Response.json(data), quiet)).rejects.toThrow();
  }
});

test("rejects non-JSON responses", async () => {
  const cfg = await config();
  await expect(run(cfg, async () => new Response("Bad gateway", { status: 502 }), quiet))
    .rejects.toThrow("invalid JSON");
});

test("does not loop on repeated page tokens", async () => {
  const cfg = await config();
  let calls = 0;
  await expect(run(cfg, async () => {
    calls++;
    return Response.json({ places: [place("same")], nextPageToken: "same-token" });
  }, quiet)).rejects.toThrow("repeated a page token");
  expect(calls).toBe(2);
});

test("never overwrites an existing export", async () => {
  const cfg = await config();
  await writeFile(cfg.output, "existing data");
  let calls = 0;
  await expect(run(cfg, async () => { calls++; return Response.json({}); }, quiet)).rejects.toThrow();
  expect(calls).toBe(0);
  expect(await readFile(cfg.output, "utf8")).toBe("existing data");
});
