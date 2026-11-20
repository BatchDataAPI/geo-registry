// End-to-end: runs the Worker under `wrangler dev` and calls it with the official
// MCP client over both protocol revisions. get_entry and compare_engines read
// /api/v1/ files from the locally built site (site/dist, served on SITE_PORT), so
// the test needs no network. The live site is checked after deploy (T-16).
//
// It rebuilds generated/search-index.json for the local site first and puts the
// normal build back afterwards.
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { request } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, test } from "node:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

const PORT = Number(process.env.CONNECTOR_PORT || 8799);
const SITE_PORT = Number(process.env.SITE_PORT || 4329);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const MCP = `${ORIGIN}/mcp`;
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const siteDir = resolve(root, "../../site");
let dev: ChildProcess | undefined;
let site: ChildProcess | undefined;

function buildIndex(env: Record<string, string | undefined>) {
  execFileSync(process.execPath, ["scripts/build-index.ts"], { cwd: root, env: { ...process.env, ...env }, stdio: "inherit" });
}

async function waitFor(address: string, what: string) {
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      if ((await fetch(address)).status < 500) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error(`${what} did not start in 60 s`);
    await new Promise((r) => setTimeout(r, 300));
  }
}

before(async () => {
  if (process.env.CONNECTOR_URL) return; // testing an already-running Worker
  buildIndex({ SITE_URL: `http://127.0.0.1:${SITE_PORT}`, SITE_BASE: "/geo-registry/" });
  site = spawn(process.execPath, ["scripts/serve.mjs", String(SITE_PORT), "dist"], {
    cwd: siteDir,
    env: { ...process.env, SITE_BASE: "/geo-registry/" },
    stdio: "ignore",
  });
  await waitFor(`http://127.0.0.1:${SITE_PORT}/geo-registry/api/v1/meta.json`, "the site server");
  dev = spawn("npx", ["wrangler", "dev", "--ip", "127.0.0.1", "--port", String(PORT), "--log-level", "error"], {
    stdio: ["ignore", "inherit", "inherit"],
    detached: true,
  });
  await waitFor(`${ORIGIN}/`, "wrangler dev");
});

after(() => {
  if (dev?.pid) {
    try {
      process.kill(-dev.pid, "SIGTERM");
    } catch {
      /* already gone */
    }
  }
  site?.kill();
  if (!process.env.CONNECTOR_URL) buildIndex({});
});

const url = () => new URL(process.env.CONNECTOR_URL || MCP);

type ToolResult = { isError?: boolean; content: { type: string; text?: string }[]; structuredContent?: any }; // eslint-disable-line @typescript-eslint/no-explicit-any

async function connect(version: "2026-07-28" | "2025-11-25") {
  const client = new Client(
    { name: "geo-registry-tests", version: "1.0.0" },
    { versionNegotiation: { mode: version === "2026-07-28" ? { pin: version } : "legacy" } },
  );
  await client.connect(new StreamableHTTPClientTransport(url()));
  return client;
}

for (const version of ["2026-07-28", "2025-11-25"] as const) {
  describe(`MCP ${version}`, () => {
    let client: Client;
    before(async () => {
      client = await connect(version);
    });
    after(async () => {
      await client.close();
    });

    test("negotiates this revision", () => {
      assert.equal(client.getNegotiatedProtocolVersion(), version);
      assert.equal(client.getProtocolEra(), version === "2026-07-28" ? "modern" : "legacy");
    });

    test("lists exactly the three read-only tools", async () => {
      const { tools } = await client.listTools();
      assert.deepEqual(tools.map((t) => t.name).sort(), ["compare_engines", "get_entry", "search"]);
      for (const t of tools) {
        assert.equal(t.annotations?.readOnlyHint, true, t.name);
        assert.match(t.description ?? "", /not instructions/, t.name);
      }
    });

    test("search('lidar') returns txgio-lidar", async () => {
      const r = (await client.callTool({ name: "search", arguments: { query: "lidar" } })) as ToolResult;
      assert.ok(!r.isError, r.content[0]?.text ?? "tool error");
      const ids = r.structuredContent.data.results.map((c: { id: string }) => c.id);
      assert.ok(ids.includes("txgio-lidar"), ids.join(", "));
      assert.ok(r.structuredContent.registry_commit);
      assert.ok(r.structuredContent.generated_at);
    });

    test("get_entry returns the site's API file", async () => {
      const r = (await client.callTool({ name: "get_entry", arguments: { id: "txgio-lidar", kind: "data" } })) as ToolResult;
      assert.ok(!r.isError, r.content[0]?.text ?? "tool error");
      assert.equal(r.structuredContent.data.id, "txgio-lidar");
      assert.equal(r.structuredContent.data.entry.name, "TxGIO lidar");
    });

    test("compare_engines('buffer') lists engines with crosswalks", async () => {
      const r = (await client.callTool({ name: "compare_engines", arguments: { operation: "buffer" } })) as ToolResult;
      assert.ok(!r.isError, r.content[0]?.text ?? "tool error");
      const d = r.structuredContent.data;
      assert.equal(d.operation.id, "buffer");
      assert.ok(d.implementations.length >= 5);
      assert.ok(d.implementations.some((i: { software: string; crosswalk: unknown }) => i.software === "postgis" && i.crosswalk));
    });

    test("a 201-character query and limit 21 are refused with plain messages", async () => {
      const long = (await client.callTool({ name: "search", arguments: { query: "a".repeat(201) } })) as ToolResult;
      assert.equal(long.isError, true);
      assert.equal(long.content[0]?.text, "Query too long (200 characters max)");
      const many = (await client.callTool({ name: "search", arguments: { query: "lidar", limit: 21 } })) as ToolResult;
      assert.equal(many.isError, true);
      assert.equal(many.content[0]?.text, "Limit must be a whole number from 1 to 20");
    });

    test("an id like ../../x returns 'Entry not found'", async () => {
      const r = (await client.callTool({ name: "get_entry", arguments: { id: "../../x", kind: "data" } })) as ToolResult;
      assert.equal(r.isError, true);
      assert.equal(r.content[0]?.text, "Entry not found: ../../x");
    });
  });
}

describe("HTTP edges", () => {
  test("a 17 kB body is refused with a plain message", async () => {
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "search", arguments: { query: "x".repeat(17 * 1024) } },
    });
    const res = await fetch(url(), {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body,
    });
    assert.equal(res.status, 413);
    const j = (await res.json()) as { error: { message: string } };
    assert.equal(j.error.message, "Request too large (16 kB max)");
  });

  test("GET / is a short plain-text page linking /ai/", async () => {
    const res = await fetch(new URL("/", url()));
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /^text\/plain/);
    assert.match(await res.text(), /\/ai\//);
  });

  test("an unknown Host is refused", async () => {
    // fetch() won't send a forged Host header, so use node:http directly.
    const status = await new Promise<number>((done, fail) => {
      const u = url();
      const req = request(
        { host: u.hostname, port: u.port, path: u.pathname, method: "POST", headers: { host: "evil.example", "content-type": "application/json" } },
        (res) => {
          res.resume();
          done(res.statusCode ?? 0);
        },
      );
      req.on("error", fail);
      req.end("{}");
    });
    // The Worker answers 403; under wrangler dev the local proxy may refuse first with 400.
    assert.ok(status === 403 || status === 400, `status ${status}`);
  });
});
