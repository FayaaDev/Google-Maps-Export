import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { readConfig } from "./export.js";

const polygon = [
  [24.826287813562946, 46.614195846844574],
  [24.79372190372786, 46.63058950768139],
  [24.778838461219557, 46.5946264506624],
  [24.775175769748827, 46.572653795299956],
  [24.796682794521278, 46.56492903364911],
];
const bounds = [
  Math.min(...polygon.map(point => point[0])),
  Math.min(...polygon.map(point => point[1])),
  Math.max(...polygon.map(point => point[0])),
  Math.max(...polygon.map(point => point[1])),
];
const env = { GOOGLE_MAPS_API_KEY: "test-key", GRID_SIZE: "1" };
let directory;
let file;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "maps-boundary-file-test-"));
  file = join(directory, "polygon.txt");
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

test("SEARCH_POLYGON_FILE synchronously loads latitude/longitude points and derives bounds", async () => {
  await writeFile(file, polygon.map(point => point.join(",")).join("\n"), "utf8");
  const cfg = readConfig({ ...env, SEARCH_POLYGON_FILE: file });
  expect(cfg.polygon).toEqual(polygon);
  expect(cfg.bounds).toEqual(bounds);
});

test("SEARCH_POLYGON_FILE resolves paths relative to the current working directory", async () => {
  await writeFile(file, polygon.map(point => point.join(",")).join("\n"), "utf8");
  const cfg = readConfig({ ...env, SEARCH_POLYGON_FILE: relative(process.cwd(), file) });
  expect(cfg.polygon).toEqual(polygon);
  expect(cfg.bounds).toEqual(bounds);
});

test("SEARCH_POLYGON_FILE accepts UTF-8 BOM, CRLF, whitespace and blank or trailing lines", async () => {
  await writeFile(file, "\uFEFF\r\n \t\r\n" + polygon.map(
    ([latitude, longitude]) => ` \t${latitude} \t, \t${longitude} \t`,
  ).join("\r\n\r\n \t\r\n") + "\r\n\r\n \t\r\n", "utf8");
  const cfg = readConfig({ ...env, SEARCH_POLYGON_FILE: file });
  expect(cfg.polygon).toEqual(polygon);
  expect(cfg.bounds).toEqual(bounds);
});

test("SEARCH_POLYGON_FILE accepts a nonzero-area triangle", async () => {
  await writeFile(file, "0,0\n0,1\n1,0\n", "utf8");
  const cfg = readConfig({ ...env, SEARCH_POLYGON_FILE: file });
  expect(cfg.polygon).toEqual([[0, 0], [0, 1], [1, 0]]);
  expect(cfg.bounds).toEqual([0, 0, 1, 1]);
});

test("SEARCH_POLYGON_FILE takes precedence over invalid inline polygons and bounds", async () => {
  await writeFile(file, polygon.map(point => point.join(",")).join("\n"), "utf8");
  for (const SEARCH_POLYGON of ["invalid JSON", "[]", ""]) {
    const cfg = readConfig({
      ...env, SEARCH_POLYGON_FILE: file, SEARCH_POLYGON, SEARCH_BOUNDS: "invalid bounds",
    });
    expect(cfg.polygon).toEqual(polygon);
    expect(cfg.bounds).toEqual(bounds);
  }
});

test("SEARCH_POLYGON_FILE rejects malformed coordinate lines synchronously", async () => {
  for (const line of [
    "1", "1,0,2", "1,,0", ",0", "1,", " ,0", "1, \t", ",",
    "not-a-number,0", "1,nope", "NaN,0", "1,NaN", "Infinity,0",
    "1,-Infinity", "1e400,0", "1,1e400", "1x,0", "1,0x",
  ]) {
    await writeFile(file, `0,0\n0,1\n1,0\n${line}\n`, "utf8");
    expect(() => readConfig({ ...env, SEARCH_POLYGON_FILE: file }))
      .toThrow("SEARCH_POLYGON_FILE");
  }
});

test("SEARCH_POLYGON_FILE rejects coordinates outside geographic ranges", async () => {
  for (const line of ["91,0", "-91,0", "1,181", "1,-181"]) {
    await writeFile(file, `0,0\n0,1\n1,0\n${line}\n`, "utf8");
    expect(() => readConfig({ ...env, SEARCH_POLYGON_FILE: file }))
      .toThrow("SEARCH_POLYGON_FILE");
  }
});

test("SEARCH_POLYGON_FILE rejects empty files, too few distinct points and zero-area polygons", async () => {
  for (const content of [
    "", "\uFEFF \t\r\n\n", "0,0", "0,0\n1,1",
    "0,0\n0,0\n0,0", "0,0\n1,1\n0,0\n1,1",
    "0,0\n1,1\n2,2", "0,0\n0,1\n0,2",
  ]) {
    await writeFile(file, content, "utf8");
    expect(() => readConfig({
      ...env, SEARCH_POLYGON_FILE: file,
      SEARCH_POLYGON: JSON.stringify(polygon), SEARCH_BOUNDS: "0,0,2,2",
    })).toThrow("SEARCH_POLYGON_FILE");
  }
});

test("SEARCH_POLYGON_FILE rejects nonexistent files and directories without falling back", () => {
  for (const SEARCH_POLYGON_FILE of [file, directory]) {
    expect(() => readConfig({
      ...env, SEARCH_POLYGON_FILE,
      SEARCH_POLYGON: JSON.stringify(polygon), SEARCH_BOUNDS: "0,0,2,2",
    })).toThrow("SEARCH_POLYGON_FILE");
  }
});

test("absent SEARCH_POLYGON_FILE preserves inline polygons and rectangle fallback", () => {
  const inline = readConfig({
    ...env, SEARCH_POLYGON: JSON.stringify(polygon), SEARCH_BOUNDS: "invalid bounds",
  });
  expect(inline.polygon).toEqual(polygon);
  expect(inline.bounds).toEqual(bounds);
  const rectangle = readConfig({ ...env, SEARCH_BOUNDS: "24,46,25,47" });
  expect(rectangle.bounds).toEqual([24, 46, 25, 47]);
  expect(rectangle.polygon == null).toBe(true);
  expect(() => readConfig(env)).toThrow("SEARCH_BOUNDS");
});
