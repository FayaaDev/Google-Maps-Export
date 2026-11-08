import { open } from "node:fs/promises";
import { readFileSync } from "node:fs";

const endpoint = "https://places.googleapis.com/v1/places:searchText";
const fields = "places.id,places.displayName,places.formattedAddress,places.location,places.rating,places.userRatingCount,places.internationalPhoneNumber,places.websiteUri,places.primaryType,places.businessStatus,places.googleMapsUri,nextPageToken";

export function readConfig(env = process.env) {
  const apiKey = env.GOOGLE_MAPS_API_KEY?.trim();
  if (!apiKey) throw new Error("Set GOOGLE_MAPS_API_KEY in .env.");
  let polygon;
  const polygonSource = env.SEARCH_POLYGON_FILE !== undefined ? "SEARCH_POLYGON_FILE" : "SEARCH_POLYGON";
  if (env.SEARCH_POLYGON_FILE !== undefined || env.SEARCH_POLYGON !== undefined) {
    if (env.SEARCH_POLYGON_FILE !== undefined) {
      let text;
      try {
        text = readFileSync(env.SEARCH_POLYGON_FILE.trim(), "utf8");
      } catch (error) {
        throw new Error(`Cannot read SEARCH_POLYGON_FILE: ${error.code || error.message}`);
      }
      polygon = [];
      for (const [index, line] of text.split("\n").entries()) {
        if (!line.trim()) continue;
        const coordinates = line.split(",").map(value => value.trim());
        if (coordinates.length !== 2 || coordinates.some(value => !value || !Number.isFinite(Number(value)))) {
          throw new Error(`SEARCH_POLYGON_FILE line ${index + 1}: expected latitude,longitude.`);
        }
        polygon.push(coordinates.map(Number));
      }
    } else {
      try {
        polygon = JSON.parse(env.SEARCH_POLYGON);
      } catch {
        throw new Error("SEARCH_POLYGON must be a JSON array of [latitude,longitude] points.");
      }
    }
    if (!Array.isArray(polygon) || polygon.length < 3 ||
        !polygon.every(point => Array.isArray(point) && point.length === 2 &&
          point.every(Number.isFinite) && Math.abs(point[0]) <= 90 && Math.abs(point[1]) <= 180) ||
        new Set(polygon.map(point => point.join(","))).size < 3) {
      throw new Error(`${polygonSource} must contain at least three distinct valid [latitude,longitude] points.`);
    }
    const [originLat, originLon] = polygon[0];
    const area = polygon.reduce((sum, [lat, lon], index) => {
      const [nextLat, nextLon] = polygon[(index + 1) % polygon.length];
      return sum + (lat - originLat) * (nextLon - originLon) - (nextLat - originLat) * (lon - originLon);
    }, 0);
    if (Math.abs(area) < 1e-14) throw new Error(`${polygonSource} must enclose a nonzero area.`);
  }
  const coordinates = (env.SEARCH_BOUNDS ?? "").split(",");
  const bounds = polygon ? [
    Math.min(...polygon.map(point => point[0])), Math.min(...polygon.map(point => point[1])),
    Math.max(...polygon.map(point => point[0])), Math.max(...polygon.map(point => point[1])),
  ] : coordinates.map(Number);
  if ((!polygon && coordinates.some(value => !value.trim())) || bounds.length !== 4 || !bounds.every(Number.isFinite) ||
      bounds[0] < -90 || bounds[2] > 90 || bounds[1] < -180 || bounds[3] > 180 ||
      bounds[0] >= bounds[2] || bounds[1] >= bounds[3]) {
    throw new Error("SEARCH_BOUNDS must be south,west,north,east with increasing coordinates.");
  }
  const gridSize = Number(env.GRID_SIZE ?? 3);
  const maxDepth = Number(env.MAX_DEPTH ?? 2);
  if (!Number.isInteger(gridSize) || gridSize < 1 ||
      !Number.isInteger(maxDepth) || maxDepth < 0) {
    throw new Error("GRID_SIZE must be a positive integer; MAX_DEPTH a nonnegative integer.");
  }
  const queries = env.SEARCH_KEYWORDS !== undefined
    ? [...new Set(env.SEARCH_KEYWORDS.split(",").map(value => value.trim()))]
    : [(env.SEARCH_QUERY ?? "coffee shops").trim()];
  if (queries.some(query => !query)) {
    throw new Error(`${env.SEARCH_KEYWORDS !== undefined ? "SEARCH_KEYWORDS" : "SEARCH_QUERY"} cannot contain empty keywords.`);
  }
  const filename = queries.join("-").normalize("NFC").toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}]+/gu, "-").slice(0, 80).replace(/^-+|-+$/g, "") || "places";
  return {
    apiKey, bounds, polygon, gridSize, maxDepth, queries, query: queries[0],
    output: env.OUTPUT_CSV || `${filename}-${Date.now()}.csv`,
  };
}

export function insidePolygon(location, polygon) {
  const latitude = location?.latitude;
  const longitude = location?.longitude;
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) ||
      Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return false;
  let inside = false;
  for (let index = 0; index < polygon.length; index++) {
    const [lat, lon] = polygon[index];
    const [nextLat, nextLon] = polygon[(index + 1) % polygon.length];
    const deltaLat = nextLat - lat;
    const deltaLon = nextLon - lon;
    // Include boundary points with a tiny tolerance for floating-point rounding.
    const epsilon = 1e-10;
    const cross = (longitude - lon) * deltaLat - (latitude - lat) * deltaLon;
    if (Math.abs(cross) <= epsilon * Math.hypot(deltaLat, deltaLon) &&
        latitude >= Math.min(lat, nextLat) - epsilon && latitude <= Math.max(lat, nextLat) + epsilon &&
        longitude >= Math.min(lon, nextLon) - epsilon && longitude <= Math.max(lon, nextLon) + epsilon) return true;
    if ((lat > latitude) !== (nextLat > latitude) &&
        longitude < lon + (latitude - lat) * deltaLon / deltaLat) inside = !inside;
  }
  return inside;
}

export function splitBounds([south, west, north, east], size) {
  const cells = [];
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      cells.push([
        south + (north - south) * row / size,
        west + (east - west) * col / size,
        south + (north - south) * (row + 1) / size,
        west + (east - west) * (col + 1) / size,
      ]);
    }
  }
  return cells;
}

export function csvRow(values) {
  return values.map(value => {
    let text = String(value ?? "");
    // Spreadsheet applications can execute formula-looking business names.
    if (typeof value === "string" && /^[\s\uFEFF]*[=+@-]/u.test(text)) text = `'${text}`;
    return `"${text.replaceAll('"', '""')}"`;
  }).join(",") + "\r\n";
}

export async function run(config, fetchImpl = fetch, log = console.log) {
  // Exclusive creation preserves earlier exports, including partial runs.
  const file = await open(config.output, "wx");
  const seenIds = new Set();
  let requests = 0;
  let cells = 0;
  let saturated = 0;
  let excluded = 0;
  try {
    await file.writeFile("\uFEFF" + csvRow([
      "place_id", "name", "address", "latitude", "longitude", "rating", "rating_count",
      "phone", "website", "category", "business_status", "google_maps_url",
    ]));
    const queries = config.queries ?? [config.query];
    for (const [keywordIndex, query] of queries.entries()) {
      log(`Keyword ${keywordIndex + 1}/${queries.length}: ${query}`);
      const queue = splitBounds(config.bounds, config.gridSize).map(bounds => ({ bounds, depth: 0 }));
      for (let index = 0; index < queue.length; index++) {
        const { bounds, depth } = queue[index];
        const [south, west, north, east] = bounds;
        const tokens = new Set();
        let pageToken;
        let count = 0;
        let page = 0;
        do {
          requests++;
          log(`API request #${requests}: cell ${index + 1}/${queue.length}, page ${page + 1}.`);
          const response = await fetchImpl(endpoint, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Goog-Api-Key": config.apiKey,
              "X-Goog-FieldMask": fields,
            },
            body: JSON.stringify({
              textQuery: query,
              pageSize: 20,
              languageCode: "en",
              locationRestriction: {
                rectangle: {
                  low: { latitude: south, longitude: west },
                  high: { latitude: north, longitude: east },
                },
              },
              ...(pageToken ? { pageToken } : {}),
            }),
            signal: AbortSignal.timeout(30_000),
          });
          let data;
          try {
            data = await response.json();
          } catch {
            throw new Error(`Google returned invalid JSON (HTTP ${response.status}).`);
          }
          if (!response.ok || data?.error) {
            throw new Error(`Google API error (${response.status}): ${data?.error?.message || response.statusText}`);
          }
          if (!data || typeof data !== "object" || Array.isArray(data) ||
              (data.places !== undefined && !Array.isArray(data.places)) ||
              (data.nextPageToken !== undefined && typeof data.nextPageToken !== "string")) {
            throw new Error("Google returned an unexpected response shape.");
          }
          const places = data.places ?? [];
          let rows = "";
          for (const place of places) {
            if (!place || typeof place.id !== "string" || !place.id) {
              throw new Error("Google returned a place without a valid ID.");
            }
            if (config.polygon && !insidePolygon(place.location, config.polygon)) {
              excluded++;
              continue;
            }
            if (seenIds.has(place.id)) continue;
            seenIds.add(place.id);
            rows += csvRow([
              place.id, place.displayName?.text, place.formattedAddress,
              place.location?.latitude, place.location?.longitude,
              place.rating, place.userRatingCount, place.internationalPhoneNumber,
              place.websiteUri, place.primaryType, place.businessStatus, place.googleMapsUri,
            ]);
          }
          if (rows) {
            await file.writeFile(rows);
            await file.sync();
          }
          count += places.length;
          page++;
          log(`Cell ${index + 1}/${queue.length}, page ${page}: ${places.length} results; ${seenIds.size} unique total.`);
          pageToken = places.length ? data.nextPageToken : undefined;
          if (pageToken && tokens.has(pageToken)) {
            throw new Error("Google repeated a page token; stopping rather than looping indefinitely.");
          }
          if (pageToken) tokens.add(pageToken);
        } while (pageToken);
        cells++;
        // shortcut: split only capped cells; lower result counts do not prove exhaustive coverage.
        if (count >= 60) {
          if (depth < config.maxDepth) {
            queue.push(...splitBounds(bounds, 2).map(child => ({ bounds: child, depth: depth + 1 })));
          } else {
            saturated++;
            log("Warning: cell still has 60+ results at MAX_DEPTH; more places may be missing.");
          }
        }
      }
    }
    log(`Finished: ${requests} API requests attempted, ${seenIds.size} unique places, ${cells} cells. CSV: ${config.output}`);
    if (config.polygon) log(`Polygon filter excluded ${excluded} returned entries outside the boundary or without valid coordinates (may include duplicates).`);
    if (saturated) log(`${saturated} capped cells remain; increasing MAX_DEPTH may retrieve more results at additional cost.`);
    return { unique: seenIds.size, requests, cells, saturated };
  } catch (error) {
    throw new Error(`${error.message}\n${requests} API requests attempted. Partial CSV retained at ${config.output}; ${seenIds.size} unique places processed.`, { cause: error });
  } finally {
    await file.close();
  }
}

if (import.meta.main) {
  try {
    await run(readConfig());
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
