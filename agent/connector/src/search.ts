// Search over the precomputed index (generated/search-index.json). The Worker
// parses the index once at module scope; a search is dictionary lookups and a
// small sort, so it stays well inside the 10 ms CPU budget of Workers Free.
import { tokens, words } from "./text.ts";

export type Kind = "data" | "tool" | "operation" | "implementation";
export const KINDS: Kind[] = ["data", "tool", "operation", "implementation"];
export const KIND_CODE: Record<Kind, number> = { data: 0, tool: 1, operation: 2, implementation: 3 };

/**
 * One searchable record: [kind code, id, name, summary, region|category|group|engine, licence,
 * review, status, site path, software?]. For implementations, summary holds the operation id
 * (or "") and path is "", both rebuilt by card().
 */
export type Doc = [number, string, string, string, string, string, string, string, string, string?];

export interface SearchIndex {
  format: 1;
  generated_at: string;
  registry_commit: string;
  /** Site root the index was built for, with a trailing slash. */
  site: string;
  docs: Doc[];
  /** word -> flat [doc, weight, doc, weight, ...] */
  postings: Record<string, number[]>;
  /** operation id -> [[software, implementation id], ...] for mapped implementations */
  operations: Record<string, [string, string][]>;
  /** lowercase state names, words joined by single spaces */
  states: string[];
  /** "travis county" -> ["Texas"] */
  counties: Record<string, string[]>;
}

export interface Card {
  id: string;
  kind: Kind;
  name: string;
  summary: string;
  region?: string;
  category?: string;
  group?: string;
  engine?: string;
  software?: string;
  license?: string;
  review: string;
  status: string;
  url: string;
}

export interface SearchOptions {
  kind?: Kind;
  region?: string;
  review?: string;
  limit?: number;
}

/** Implementations outnumber everything else 4 to 1; without a kind filter they rank a little lower. */
const IMPL_FACTOR = 0.6;
/** County names are ambiguous ("Washington County" is in 30 states); only expand when it's clear. */
const MAX_STATES = 3;
const COUNTY_WORDS = new Set(["county", "parish", "borough", "municipio", "city", "area"]);

const opNames = new WeakMap<SearchIndex, Map<string, string>>();

function operationName(index: SearchIndex, id: string): string | undefined {
  let m = opNames.get(index);
  if (!m) {
    m = new Map();
    for (const d of index.docs) if (d[0] === KIND_CODE.operation) m.set(d[1], d[2]);
    opNames.set(index, m);
  }
  return m.get(id);
}

export function card(index: SearchIndex, d: Doc): Card {
  const kind = KINDS[d[0]] as Kind;
  let summary = d[3];
  let path = d[8];
  if (kind === "implementation") {
    const op = d[3] ? operationName(index, d[3]) : undefined;
    summary = op ? `${d[4]}'s ${d[2]}: ${op}.` : `${d[4]}'s ${d[2]}.`;
    path = `implementations/${d[9]}/${d[1]}/`;
  }
  const c: Card = { id: d[1], kind, name: d[2], summary, review: d[6], status: d[7], url: index.site + path };
  if (kind === "data") c.region = d[4];
  else if (kind === "tool") c.category = d[4];
  else if (kind === "operation") c.group = d[4];
  else {
    c.engine = d[4];
    c.software = d[9];
  }
  if (d[5]) c.license = d[5];
  return c;
}

/** States a county named in the query lies in, when the query names no state itself. */
export function countyStates(index: SearchIndex, query: string): string[] {
  const w = words(query);
  if (!w.some((x) => COUNTY_WORDS.has(x))) return [];
  const text = ` ${w.join(" ")} `;
  if (index.states.some((s) => text.includes(` ${s} `))) return [];
  let best = "";
  // Try every run of 2 to 5 words; county names are short.
  for (let i = 0; i < w.length; i++) {
    for (let n = 2; n <= 5 && i + n <= w.length; n++) {
      const name = w.slice(i, i + n).join(" ");
      if (name.length > best.length && index.counties[name]) best = name;
    }
  }
  const states = best ? (index.counties[best] ?? []) : [];
  return states.length > 0 && states.length <= MAX_STATES ? states : [];
}

export function search(index: SearchIndex, query: string, opts: SearchOptions = {}): Card[] {
  const limit = opts.limit ?? 10;
  const qTokens = [...new Set(tokens(query))];
  // A county with no state also searches the state, because statewide sources name the state.
  const extra = countyStates(index, query).flatMap((s) => tokens(s));
  const groups: string[][] = qTokens.map((t) => [t]);
  if (extra.length) {
    const countyTokens = new Set(tokens("county parish borough"));
    groups.push([...new Set(extra)].filter((t) => !qTokens.includes(t)));
    // the word "county" itself shouldn't decide anything
    for (const g of groups) if (g.length === 1 && countyTokens.has(g[0] as string)) g.length = 0;
  }

  const hits = new Map<number, { matched: number; score: number }>();
  for (const group of groups) {
    if (group.length === 0) continue;
    const seen = new Set<number>();
    for (const t of group) {
      const list = index.postings[t];
      if (!list) continue;
      for (let i = 0; i < list.length; i += 2) {
        const doc = list[i] as number;
        const w = list[i + 1] as number;
        let h = hits.get(doc);
        if (!h) hits.set(doc, (h = { matched: 0, score: 0 }));
        if (!seen.has(doc)) {
          h.matched++;
          seen.add(doc);
        }
        h.score += w;
      }
    }
  }

  const kindCode = opts.kind ? KIND_CODE[opts.kind] : -1;
  const region = opts.region?.trim().toLowerCase();
  const ranked: { doc: number; matched: number; score: number; retired: boolean }[] = [];
  for (const [doc, h] of hits) {
    const d = index.docs[doc] as Doc;
    if (kindCode >= 0 && d[0] !== kindCode) continue;
    if (opts.review && d[6] !== opts.review) continue;
    if (region && !(d[0] === KIND_CODE.data && d[4].toLowerCase().includes(region))) continue;
    let score = h.score;
    if (d[0] === KIND_CODE.implementation && kindCode < 0) score *= IMPL_FACTOR;
    if (d[6] === "reviewed") score += 1;
    ranked.push({ doc, matched: h.matched, score, retired: d[7] === "retired" });
  }
  // Most query words matched first, then retired last, then score, then name for a stable order.
  ranked.sort(
    (a, b) =>
      b.matched - a.matched ||
      Number(a.retired) - Number(b.retired) ||
      b.score - a.score ||
      ((index.docs[a.doc] as Doc)[2] < (index.docs[b.doc] as Doc)[2] ? -1 : 1),
  );
  return ranked.slice(0, limit).map((r) => card(index, index.docs[r.doc] as Doc));
}

/** Find one record by kind and id (and software, for implementations). */
export function findDoc(index: SearchIndex, kind: Kind, id: string, software?: string): Doc | undefined {
  const code = KIND_CODE[kind];
  return index.docs.find((d) => d[0] === code && d[1] === id && (kind !== "implementation" || !software || d[9] === software));
}
