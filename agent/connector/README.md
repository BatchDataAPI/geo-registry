# geo-registry MCP connector

A Cloudflare Worker that lets AI apps (Claude, ChatGPT and others) search the
geo-registry. Address once deployed: `https://mcp.geo-registry.io/mcp`, no sign-in.

It has three read-only tools:

| Tool | What it does |
|---|---|
| `search` | Finds data sources, tools, operations and engine implementations by words |
| `get_entry` | Returns one entry's full record from the site's `/api/v1/` files |
| `compare_engines` | Shows how each engine runs one operation: parameters, crosswalk, differences |

It serves MCP 2026-07-28 (stateless) and 2025-11-25 clients from the same address,
using the official SDK's `createMcpHandler` (`@modelcontextprotocol/server`).

## How it works

- `scripts/build-index.ts` turns the registry build (`dist/`) into
  `generated/search-index.json` (cards, implementation names and word postings,
  under 2 MB). CI builds it in `site-check`; it is bundled into the Worker at
  deploy time and never committed.
- The Worker reads that index once when it starts, so a search is lookups only.
- `get_entry` and `compare_engines` fetch only the site's `/api/v1/` files.
- Limits: query 1–200 characters, `limit` 1–20, request body 16 kB, response 64 kB.
  Errors are plain sentences, never stack traces.
- It logs nothing: queries can contain addresses.

## Commands (Node 26, from this folder)

```sh
npm ci --ignore-scripts
npm run build:index   # needs ../../dist from the registry build
npm run check         # Worker types + TypeScript
npm test              # unit tests
npm run speed         # 200 fixed queries: p95 must be under 2 ms
npm run test:worker   # wrangler dev + the MCP client, both protocol revisions
                      # (needs the site built in ../../site/dist)
```

`SITE_URL` and `SITE_BASE` choose which site the index (and so every `url` and
fetch) points at, exactly as for the site build.
