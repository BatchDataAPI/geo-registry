import assert from "node:assert/strict";
import { test } from "node:test";
import { apiBase, fetchApi, runCompareEngines, runGetEntry, runSearch, UserError, type Fetcher } from "../../src/tools.ts";
import { loadIndex } from "../load.ts";

const index = loadIndex();
const base = apiBase(index);

/** A fake site: records every URL asked for and serves a tiny envelope for known paths. */
function fakeSite(known: Record<string, unknown> = {}) {
  const asked: string[] = [];
  const fetcher: Fetcher = async (url) => {
    asked.push(url);
    const path = url.slice(base.length);
    if (path in known) return new Response(JSON.stringify(known[path]), { status: 200 });
    return new Response("not found", { status: 404 });
  };
  return { asked, fetcher };
}

const rejects = (p: Promise<unknown>, message: string | RegExp) =>
  assert.rejects(p, (e: unknown) => {
    assert.ok(e instanceof UserError, `not a UserError: ${String(e)}`);
    if (typeof message === "string") assert.equal(e.message, message);
    else assert.match(e.message, message);
    return true;
  });

test("search refuses a 201-character query and limit 21 with plain messages", () => {
  assert.throws(() => runSearch(index, { query: "a".repeat(201) }), { message: "Query too long (200 characters max)" });
  assert.throws(() => runSearch(index, { query: "lidar", limit: 21 }), { message: "Limit must be a whole number from 1 to 20" });
  assert.throws(() => runSearch(index, { query: "lidar", limit: 0 }), { message: "Limit must be a whole number from 1 to 20" });
  assert.throws(() => runSearch(index, { query: "   " }), { message: "Query is empty" });
  assert.equal(runSearch(index, { query: "a".repeat(200) }).count >= 0, true);
});

test("search results carry registry_commit and generated_at, with cards inside data", () => {
  const r = runSearch(index, { query: "lidar" });
  assert.equal(r.registry_commit, index.registry_commit);
  assert.equal(r.generated_at, index.generated_at);
  assert.ok(r.data.results.length > 0);
});

test("the fetch helper refuses any host or path outside the API base", async () => {
  const { asked, fetcher } = fakeSite();
  for (const url of [
    "https://evil.example/api/v1/data/x.json",
    `${index.site}data/txgio-lidar/`, // a page, not the API
    `${base}../../index.html`,
    `${base}data/../../secret.json`,
    `${base}data/x.json?q=1`,
    `${base}data/x.json#a`,
    base.replace("https://", "https://user:pw@") + "data/x.json",
    base.replace("https://", "http://") + "data/x.json",
    "not a url",
  ]) {
    await rejects(fetchApi(index, fetcher, url), "Refused: not an address the connector may read");
  }
  assert.deepEqual(asked, [], "nothing was fetched");
});

test("an id like ../../x returns 'Entry not found' and fetches nothing", async () => {
  const { asked, fetcher } = fakeSite();
  await rejects(runGetEntry(index, fetcher, { id: "../../x", kind: "data" }), "Entry not found: ../../x");
  await rejects(runGetEntry(index, fetcher, { id: "x", kind: "implementation", software: "../.." }), "Entry not found: x");
  await rejects(runCompareEngines(index, fetcher, { operation: "../buffer" }), "Operation not found: ../buffer");
  assert.deepEqual(asked, []);
});

test("get_entry fetches the API file and wraps it in data", async () => {
  const body = { format: 1, id: "txgio-lidar", kind: "data", entry: { name: "TxGIO lidar" } };
  const { asked, fetcher } = fakeSite({ "data/txgio-lidar.json": body });
  const r = await runGetEntry(index, fetcher, { id: "txgio-lidar", kind: "data" });
  assert.deepEqual(r.data, body);
  assert.equal(r.registry_commit, index.registry_commit);
  assert.deepEqual(asked, [`${base}data/txgio-lidar.json`]);
  await rejects(runGetEntry(index, fetcher, { id: "buffer-x", kind: "operation" }), "Entry not found: buffer-x");
});

test("get_entry finds an implementation's software when it isn't given", async () => {
  const { asked, fetcher } = fakeSite({ "implementations/postgis/postgis-st-buffer.json": { entry: {} } });
  await runGetEntry(index, fetcher, { id: "postgis-st-buffer", kind: "implementation" });
  assert.deepEqual(asked, [`${base}implementations/postgis/postgis-st-buffer.json`]);
});

test("compare_engines returns the operation and one row per mapped implementation", async () => {
  const known: Record<string, unknown> = {
    "operations/buffer.json": { url: `${index.site}operations/buffer/`, entry: { name: "Buffer", parameters: { distance: {} }, pitfalls: ["p"] } },
  };
  for (const [sw, id] of index.operations.buffer ?? []) {
    known[`implementations/${sw}/${id}.json`] = { url: `${index.site}implementations/${sw}/${id}/`, entry: { name: id, crosswalk: { distance: "d" }, differences: ["x"] } };
  }
  const { fetcher } = fakeSite(known);
  const r = await runCompareEngines(index, fetcher, { operation: "buffer" });
  assert.equal(r.data.operation.name, "Buffer");
  assert.deepEqual(r.data.operation.pitfalls, ["p"]);
  assert.equal(r.data.implementations.length, (index.operations.buffer ?? []).length);
  assert.ok(r.data.implementations.some((i) => i.software === "postgis"));
  await rejects(runCompareEngines(index, fetcher, { operation: "no-such-op" }), "Operation not found: no-such-op");
});

test("a site error gives a plain message", async () => {
  const fetcher: Fetcher = async () => new Response("down", { status: 503 });
  await rejects(runGetEntry(index, fetcher, { id: "txgio-lidar", kind: "data" }), "The registry site answered 503; try again shortly");
});
