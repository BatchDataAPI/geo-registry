import assert from "node:assert/strict";
import { statSync } from "node:fs";
import { test } from "node:test";
import { countyStates, search } from "../../src/search.ts";
import { tokens } from "../../src/text.ts";
import { INDEX_PATH, loadIndex } from "../load.ts";

const index = loadIndex();
const rank = (q: string, id: string, opts = {}) => search(index, q, { limit: 20, ...opts }).findIndex((c) => c.id === id);

test("index stays under 2 MB uncompressed", () => {
  assert.ok(statSync(INDEX_PATH).size < 2 * 1024 * 1024, `${statSync(INDEX_PATH).size} bytes`);
});

test("tokens fold plurals and drop stop words", () => {
  assert.deepEqual(tokens("Buffers for the Counties"), ["buffer", "county"]);
  assert.deepEqual(tokens("Café"), ["cafe"]);
});

test("the intent's two lookups find their targets first", () => {
  assert.equal(rank("lidar for Travis County", "txgio-lidar"), 0);
  assert.equal(rank("buffer in PostGIS", "postgis-st-buffer"), 0);
});

test("lidar finds txgio-lidar within the default 10", () => {
  const r = rank("lidar", "txgio-lidar");
  assert.ok(r >= 0 && r < 10, `rank ${r}`);
});

test("county lookup adds the state only when it's clear", () => {
  assert.deepEqual(countyStates(index, "lidar Travis County"), ["Texas"]);
  assert.deepEqual(countyStates(index, "lidar Travis County Texas"), []);
  assert.deepEqual(countyStates(index, "Washington County parcels"), []); // in 30 states
  assert.deepEqual(countyStates(index, "lidar"), []);
});

test("filters: kind, review, region", () => {
  for (const c of search(index, "buffer", { kind: "operation" })) assert.equal(c.kind, "operation");
  for (const c of search(index, "lidar", { review: "reviewed" })) assert.equal(c.review, "reviewed");
  const tx = search(index, "lidar", { region: "texas" });
  assert.ok(tx.length > 0);
  for (const c of tx) assert.ok(c.kind === "data" && /texas/i.test(c.region ?? ""));
});

test("retired entries rank below active ones", () => {
  const res = search(index, "TIGER/Line", { limit: 20 });
  assert.equal(res[0]?.id, "census-tiger-line");
  const statuses = res.map((c) => c.status);
  const firstRetired = statuses.indexOf("retired");
  assert.ok(firstRetired > 0, "a retired TIGER/Line entry is in the results");
  // Results with the same number of matched words never put a retired entry above an active one.
  assert.ok(res.findIndex((c) => c.id === "tiger-line-road-features") > res.findIndex((c) => c.id === "census-tiger-line"));
});

test("cards carry the spec's fields and page urls on the site", () => {
  const [c] = search(index, "txgio lidar", { limit: 1 });
  assert.ok(c);
  assert.equal(c.id, "txgio-lidar");
  assert.equal(c.kind, "data");
  assert.equal(c.region, "Texas");
  assert.ok(c.license);
  assert.ok(c.review);
  assert.equal(c.status, "active");
  assert.equal(c.url, `${index.site}data/txgio-lidar/`);
  const [impl] = search(index, "postgis st_buffer", { kind: "implementation", limit: 1 });
  assert.equal(impl?.url, `${index.site}implementations/postgis/postgis-st-buffer/`);
  assert.match(impl?.summary ?? "", /Buffer/);
});

test("limit is respected", () => {
  assert.equal(search(index, "raster", { limit: 20 }).length, 20);
  assert.equal(search(index, "raster", { limit: 1 }).length, 1);
});
