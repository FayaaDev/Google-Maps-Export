# Google Maps Export

A Bun script using Google Places API (New). Reads environment variables
(Bun automatically loads `.env`), paginates each rectangle, and saves a UTF-8 CSV
with place ID, name, address, latitude, longitude, rating, rating count, phone,
website, category, business status, and Google Maps URL. Missing fields are blank;
rating count is Google's user rating count, not the number of written reviews.
IDs are deduplicated across keywords, pages, and cells. No API key is written to
the output.

## Requirements

- Bun installed and available in your terminal.
- A Google Cloud project with billing enabled.
- A Google Maps API key authorized for Places API (New).

## Run

From this directory:

```bash
cp .env.example .env
```

Edit `.env` with your key and area. Enable Places API (New) and billing in your
Google Cloud project. 

```bash
bun run export.js
```

## Multiple keywords

Set a comma-separated list in `.env`:

```env
SEARCH_KEYWORDS=coffee shops,bakeries,restaurants
```

## Area and stopping behavior

Edit `boundary.txt` to change the border: paste one `latitude, longitude` pair
per line, in clockwise or counterclockwise border order. Blank lines are ignored.
For example:

```text
24.826287813562946, 46.614195846844574
24.79372190372786, 46.63058950768139
24.778838461219557, 46.5946264506624
```

The supplied file contains all five existing Al Malqa points. At least three
distinct valid points enclosing a nonzero area are required. The last point
connects back to the first automatically; use a simple, non-self-crossing
polygon. This models straight lines between clicks, not an independently
verified official boundary. Invalid files stop the run before any API calls.

`.env` selects the file with `SEARCH_POLYGON_FILE=boundary.txt`. Relative paths
are resolved from the directory where you run Bun. The file is read once at
startup: save edits and start a new run to use a changed boundary.

`SEARCH_POLYGON_FILE` takes precedence over the older inline `SEARCH_POLYGON`
JSON setting; both remain supported. An invalid file fails rather than silently
falling back to the inline polygon or rectangle.

The script searches `GRID_SIZE × GRID_SIZE` cells (default 9). In each cell it
follows `nextPageToken` until absent or an empty page is returned. A cell with 60+
results is divided into four and searched again, up to `MAX_DEPTH` (default 2
additional levels). Empty cells do not stop searches of neighboring cells.
The 60-result subdivision threshold uses Google's unfiltered results, including
outside matches. Polygon filtering happens after retrieval, so those matches
still consume API requests. Cells in the surrounding rectangle can extend
outside the polygon; only the final CSV is strictly filtered.

The run ends after the finite queue is exhausted, not when every possible place
has been discovered. Repeating identical searches until no new IDs appear does
not guarantee completeness. Google ranks matches; fewer than 60 results does
not prove a cell is complete. Even an exact polygon does not guarantee all shops
are found, and inclusion depends on the accuracy of Google's place coordinates.

## Charges and data usage

Each page is a separate request. Per keyword, defaults allow up to 189 cells / approximately
567 requests if every cell reaches three pages and remains saturated. An area
with no dense cells normally uses 9–27 requests. Smaller cells, more levels, or
additional fields increase cost. Request fields determine Google's billing SKU.
Multiple keywords multiply these potential request counts. Deduplication reduces
CSV rows, not Google's request charges.
Ratings, rating counts, phone numbers, and websites trigger the Text Search
Enterprise SKU, which can cost more than the basic name/address search. Individual
review text is not requested. Updating the script does not enrich earlier CSVs;
rerun it to create a new export with the added columns.

This tool does not grant rights to retain or export Google content. Review
[Google's Places policies](https://developers.google.com/maps/documentation/places/web-service/policies)
and your applicable agreement before running or retaining CSVs. Use a source
licensed for bulk exports if your intended use is not permitted.

## Tests (no Google calls)

```bash
bun test ./export.test.js ./boundary.test.js ./boundary-file.test.js ./keywords.test.js
```
