// Speed check (T-14): runs the 200 fixed queries in test/speed-queries.json through
// the same search code the Worker uses and fails unless p95 is under 2 ms.
// The real gate is Cloudflare's CPU metrics after deploy (T-16).
import { readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { search, type SearchIndex } from "../src/search.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const indexPath = resolve(root, "generated/search-index.json");
const index: SearchIndex = JSON.parse(readFileSync(indexPath, "utf8"));
const queries: string[] = JSON.parse(readFileSync(resolve(root, "test/speed-queries.json"), "utf8"));

// Warm up once, as a Worker isolate does on its first request.
for (const q of queries) search(index, q);

const times: number[] = [];
for (const q of queries) {
  const t = performance.now();
  search(index, q);
  times.push(performance.now() - t);
}
times.sort((a, b) => a - b);
const pct = (p: number) => times[Math.min(times.length - 1, Math.ceil((p / 100) * times.length) - 1)] as number;
const size = statSync(indexPath).size;
console.log(
  `${queries.length} queries: p50 ${pct(50).toFixed(3)} ms, p95 ${pct(95).toFixed(3)} ms, max ${pct(100).toFixed(3)} ms; ` +
    `search-index.json ${(size / 1024 / 1024).toFixed(2)} MB`,
);
let failed = false;
if (pct(95) >= 2) {
  console.error("FAIL: search p95 must be under 2 ms");
  failed = true;
}
if (size >= 2 * 1024 * 1024) {
  console.error("FAIL: search-index.json must be under 2 MB");
  failed = true;
}
process.exit(failed ? 1 : 0);
