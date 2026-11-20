// The three read-only tools (format F-4). Pure functions over the index and a
// fetch function, so the unit tests run them in Node without a Worker.
import { findDoc, KINDS, search, type Kind, type SearchIndex } from "./search.ts";

export const MAX_QUERY = 200;
export const MAX_LIMIT = 20;
export const MAX_BODY = 16 * 1024;
export const MAX_RESPONSE = 64 * 1024;
export const REVIEW_STATES = ["seeded", "reviewed", "draft", "harvested"] as const;

/** A plain message for the person or agent; never a stack trace. */
export class UserError extends Error {}

const FOLDER: Record<Kind, string> = { data: "data", tool: "tools", operation: "operations", implementation: "implementations" };
/** Registry ids and software ids, as schema/entry.schema.json defines them. */
const ID = /^[a-z0-9][a-z0-9-]*$/;
const MAX_ID = 96;

export type Fetcher = (url: string) => Promise<Response>;

/** The only addresses the connector may fetch: the site's /api/v1/ files. */
export function apiBase(index: SearchIndex): string {
  return `${index.site}api/v1/`;
}

/**
 * Fetch one /api/v1/ JSON file. Refuses any URL that, once resolved, isn't under
 * the API base (another host, "..", a query string), so a crafted id can't reach elsewhere.
 */
export async function fetchApi(index: SearchIndex, fetcher: Fetcher, url: string): Promise<unknown | undefined> {
  const base = apiBase(index);
  let resolved: URL;
  try {
    resolved = new URL(url);
  } catch {
    throw new UserError("Refused: not an address the connector may read");
  }
  if (
    !resolved.href.startsWith(base) ||
    resolved.search ||
    resolved.hash ||
    resolved.username ||
    resolved.password ||
    !resolved.pathname.endsWith(".json")
  ) {
    throw new UserError("Refused: not an address the connector may read");
  }
  const res = await fetcher(resolved.href);
  if (res.status === 404) return undefined;
  if (!res.ok) throw new UserError(`The registry site answered ${res.status}; try again shortly`);
  return res.json();
}

function stamp(index: SearchIndex) {
  return { registry_commit: index.registry_commit, generated_at: index.generated_at };
}

/** Keep a result under the response cap; callers trim lists before giving up. */
function capped<T>(result: T): T {
  if (JSON.stringify(result).length > MAX_RESPONSE) {
    throw new UserError("Result too large to return (64 kB max); open the entry's page instead");
  }
  return result;
}

export interface SearchInput {
  query: string;
  kind?: Kind;
  region?: string;
  review?: string;
  limit?: number;
}

export function runSearch(index: SearchIndex, input: SearchInput) {
  const query = (input.query ?? "").trim();
  if (!query) throw new UserError("Query is empty");
  if (input.query.length > MAX_QUERY) throw new UserError(`Query too long (${MAX_QUERY} characters max)`);
  const limit = input.limit ?? 10;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new UserError(`Limit must be a whole number from 1 to ${MAX_LIMIT}`);
  }
  if (input.kind && !KINDS.includes(input.kind)) throw new UserError(`Unknown kind: ${input.kind}`);
  if (input.review && !(REVIEW_STATES as readonly string[]).includes(input.review)) {
    throw new UserError(`Unknown review state: ${input.review}`);
  }
  if (input.region && input.region.length > MAX_QUERY) throw new UserError(`Region too long (${MAX_QUERY} characters max)`);
  const results = search(index, query, { kind: input.kind, region: input.region, review: input.review, limit });
  return capped({ ...stamp(index), count: results.length, data: { results } });
}

export interface EntryInput {
  id: string;
  kind: Kind;
  software?: string;
}

export async function runGetEntry(index: SearchIndex, fetcher: Fetcher, input: EntryInput) {
  const { id, kind } = input;
  if (!KINDS.includes(kind)) throw new UserError(`Unknown kind: ${kind}`);
  const notFound = new UserError(`Entry not found: ${id}`);
  if (typeof id !== "string" || id.length > MAX_ID || !ID.test(id)) throw notFound;
  let path = `${FOLDER[kind]}/${id}.json`;
  if (kind === "implementation") {
    let software = input.software;
    if (software === undefined) software = findDoc(index, "implementation", id)?.[9];
    if (!software || !ID.test(software) || software.length > MAX_ID) throw notFound;
    path = `implementations/${software}/${id}.json`;
  }
  const body = await fetchApi(index, fetcher, apiBase(index) + path);
  if (body === undefined) throw notFound;
  return capped({ ...stamp(index), data: body });
}

export async function runCompareEngines(index: SearchIndex, fetcher: Fetcher, input: { operation: string }) {
  const id = input.operation;
  const notFound = new UserError(`Operation not found: ${id}`);
  if (typeof id !== "string" || id.length > MAX_ID || !ID.test(id)) throw notFound;
  if (!findDoc(index, "operation", id)) throw notFound;
  const op = (await fetchApi(index, fetcher, `${apiBase(index)}operations/${id}.json`)) as
    | { url: string; entry: Record<string, unknown> }
    | undefined;
  if (!op) throw notFound;
  const mapped = index.operations[id] ?? [];
  const impls = await Promise.all(
    mapped.map(async ([software, implId]) => {
      const doc = findDoc(index, "implementation", implId, software);
      const body = (await fetchApi(index, fetcher, `${apiBase(index)}implementations/${software}/${implId}.json`)) as
        | { url: string; entry: Record<string, unknown> }
        | undefined;
      if (!body) return undefined;
      const e = body.entry;
      return {
        engine: doc?.[4] ?? software,
        software,
        tool: e.name,
        id: implId,
        call: e.call,
        crosswalk: e.crosswalk ?? null,
        differences: e.differences ?? [],
        review: (e.review as { state?: string } | undefined)?.state,
        url: body.url,
      };
    }),
  );
  const e = op.entry;
  const result = {
    ...stamp(index),
    data: {
      operation: {
        id,
        name: e.name,
        summary: e.summary,
        url: op.url,
        parameters: e.parameters ?? {},
        pitfalls: e.pitfalls ?? [],
      },
      implementations: impls.filter((x) => x !== undefined),
    },
  };
  return capped(result);
}
