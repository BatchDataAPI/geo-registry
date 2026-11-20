// Builds generated/search-index.json from the registry build output (dist/).
// Run by site-check; the file is bundled into the Worker at deploy time and
// never committed. Usage: node scripts/build-index.ts
//
// Env: REGISTRY_DIST (default ../../dist), SITE_URL and SITE_BASE (as for the
// site build), REGISTRY_COMMIT (default: git HEAD).
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { tokens, words } from "../src/text.ts";
import { KIND_CODE, type Doc, type SearchIndex } from "../src/search.ts";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const dist = resolve(process.env.REGISTRY_DIST || resolve(root, "../../dist"));
const out = resolve(root, "generated/search-index.json");

// Same defaults as site/astro.config.mjs: the github.io address until the domain is live.
const siteUrl = (process.env.SITE_URL || "https://wiatrek-kevin-s.github.io").replace(/\/+$/, "");
let siteBase = process.env.SITE_BASE || "/geo-registry/";
if (!siteBase.startsWith("/")) siteBase = `/${siteBase}`;
if (!siteBase.endsWith("/")) siteBase = `${siteBase}/`;
const site = `${siteUrl}${siteBase}`;

function commit(): string {
  if (process.env.REGISTRY_COMMIT) return process.env.REGISTRY_COMMIT;
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA;
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", stdio: "pipe", cwd: root }).trim();
  } catch {
    return "unknown";
  }
}

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const index = JSON.parse(readFileSync(resolve(dist, "index.json"), "utf8"));
const db = new DatabaseSync(resolve(dist, "registry.sqlite"), { readOnly: true });
const full = new Map<string, Json>();
for (const r of db.prepare("SELECT kind, id, entry FROM entries").all() as Json[]) {
  full.set(`${r.kind}/${r.id}`, JSON.parse(r.entry));
}
for (const r of db.prepare("SELECT id, entry FROM operations").all() as Json[]) {
  full.set(`operation/${r.id}`, JSON.parse(r.entry));
}
const impls = db
  .prepare("SELECT id, software, implements, name, status, card, entry FROM implementations ORDER BY software, id")
  .all() as Json[];
db.close();

const docs: Doc[] = [];
const postings = new Map<string, Map<number, number>>();

/** Field weights: how much a word in that field counts toward a match. */
const W = { name: 10, call: 8, id: 6, aka: 6, place: 4, category: 4, summary: 3, publisher: 3, software: 3, operation: 3 };

function add(doc: number, text: unknown, weight: number) {
  const list = Array.isArray(text) ? text : [text];
  for (const item of list) {
    if (typeof item !== "string" || !item) continue;
    for (const t of new Set(tokens(item))) {
      let m = postings.get(t);
      if (!m) postings.set(t, (m = new Map()));
      // A word counts once per field; fields add up, capped so one long entry can't dominate.
      m.set(doc, Math.min(24, (m.get(doc) ?? 0) + weight));
    }
  }
}

const toolNames = new Map<string, string>();
for (const c of index.entries) if (c.kind === "tool") toolNames.set(c.id, c.name);
const opNames = new Map<string, string>();
for (const c of index.operations) opNames.set(c.id, c.name);

for (const c of index.entries) {
  const e = full.get(`${c.kind}/${c.id}`) ?? {};
  const isData = c.kind === "data";
  const n = docs.push([
    KIND_CODE[c.kind as "data" | "tool"],
    c.id,
    c.name,
    c.summary ?? "",
    (isData ? c.region : c.category) ?? "",
    c.license ?? "",
    c.review ?? "",
    c.status,
    `${isData ? "data" : "tools"}/${c.id}/`,
  ]) - 1;
  add(n, c.name, W.name);
  add(n, c.id, W.id);
  add(n, c.summary, W.summary);
  if (isData) {
    add(n, c.region, W.place);
    add(n, c.themes, W.category);
    add(n, e.publisher, W.publisher);
  } else {
    add(n, [c.category, c.subcategory], W.category);
  }
}

for (const c of index.operations) {
  const e = full.get(`operation/${c.id}`) ?? {};
  const n = docs.push([
    KIND_CODE.operation,
    c.id,
    c.name,
    c.summary ?? "",
    c.group ?? "",
    "",
    c.review ?? "",
    c.status,
    `operations/${c.id}/`,
  ]) - 1;
  add(n, c.name, W.name);
  add(n, c.id, W.id);
  add(n, c.aka, W.aka);
  add(n, c.summary, W.summary);
  add(n, (c.group ?? "").split("/"), W.category);
  void e;
}

const byOperation: Record<string, [string, string][]> = {};
for (const r of impls) {
  const card = JSON.parse(r.card);
  const tool = toolNames.get(r.software) ?? r.software;
  const op = r.implements ? opNames.get(r.implements) : undefined;
  // Summary and path are rebuilt by the Worker (card()), to keep the index under 2 MB.
  const n = docs.push([
    KIND_CODE.implementation,
    r.id,
    r.name,
    r.implements ?? "",
    tool,
    "",
    card.review ?? "",
    r.status,
    "",
    r.software,
  ]) - 1;
  add(n, r.name, W.name);
  add(n, card.call?.name, W.call);
  add(n, r.id, W.id);
  add(n, [r.software, tool], W.software);
  if (op && r.implements) {
    add(n, op, W.operation);
    (byOperation[r.implements] ??= []).push([r.software, r.id]);
  }
}

// County lookup (as CR-1 on the site): "travis county" -> ["Texas"].
const gaz = JSON.parse(readFileSync(resolve(root, "../../site/public/places/us-counties.json"), "utf8"));
const counties: Record<string, string[]> = {};
for (const [name, states] of Object.entries(gaz.counties as Record<string, string[]>)) {
  counties[words(name).join(" ")] = states;
}

const data: SearchIndex = {
  format: 1,
  generated_at: index.generated_at,
  registry_commit: commit(),
  site,
  docs,
  postings: Object.fromEntries(
    [...postings].sort(([a], [b]) => (a < b ? -1 : 1)).map(([t, m]) => [t, [...m].flat()]),
  ),
  operations: byOperation,
  states: (gaz.states as string[]).map((s) => words(s).join(" ")),
  counties,
};

mkdirSync(dirname(out), { recursive: true });
const text = JSON.stringify(data);
writeFileSync(out, text);
console.log(
  `search-index.json: ${docs.length} docs, ${postings.size} words, ${(text.length / 1024 / 1024).toFixed(2)} MB, site ${site}`,
);
