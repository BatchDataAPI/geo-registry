import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { SearchIndex } from "../src/search.ts";

const here = dirname(fileURLToPath(import.meta.url));
export const INDEX_PATH = resolve(here, "../generated/search-index.json");

/** The generated index; run `npm run build:index` first. */
export function loadIndex(): SearchIndex {
  return JSON.parse(readFileSync(INDEX_PATH, "utf8"));
}
