// geo-registry MCP connector: a Cloudflare Worker serving three read-only tools
// at /mcp over Streamable HTTP, for MCP 2026-07-28 (stateless) and 2025-11-25
// clients alike. It logs nothing: queries can contain addresses.
import { createMcpHandler, hostHeaderValidationResponse, originValidationResponse } from "@modelcontextprotocol/server";
import { createServer, index } from "./server.ts";
import { MAX_BODY } from "./tools.ts";

/** Hostnames this Worker answers on; localhost is for `wrangler dev` and tests. */
const HOSTS = ["mcp.geo-registry.io", "localhost", "127.0.0.1"];
/** Browser origins allowed to call it. Server-to-server calls (AI apps) send no Origin. */
const ORIGINS = ["geo-registry.io", "wiatrek-kevin-s.github.io", "localhost", "127.0.0.1"];

const mcp = createMcpHandler(() => createServer(), { maxRequestBodySize: MAX_BODY });

const HOME = `geo-registry MCP connector

Address for AI apps: https://mcp.geo-registry.io/mcp (no sign-in)
Tools: search, get_entry, compare_engines (read-only)
How to add it to Claude or ChatGPT: ${index.site}ai/
Registry: ${index.site}
`;

function jsonRpcError(status: number, message: string): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32600, message } }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function handle(request: Request): Promise<Response> {
  const bad = hostHeaderValidationResponse(request, HOSTS);
  if (bad) return bad;
  const url = new URL(request.url);
  if (url.pathname === "/" && (request.method === "GET" || request.method === "HEAD")) {
    return new Response(request.method === "HEAD" ? null : HOME, {
      headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=300" },
    });
  }
  if (url.pathname !== "/mcp") return new Response("Not found. The connector lives at /mcp.\n", { status: 404 });
  const badOrigin = originValidationResponse(request, ORIGINS);
  if (badOrigin) return badOrigin;

  if (request.method === "POST") {
    const declared = Number(request.headers.get("content-length") ?? "0");
    if (declared > MAX_BODY) return jsonRpcError(413, "Request too large (16 kB max)");
    const body = await request.arrayBuffer();
    if (body.byteLength > MAX_BODY) return jsonRpcError(413, "Request too large (16 kB max)");
    request = new Request(request.url, { method: "POST", headers: request.headers, body });
  }
  try {
    return await mcp.fetch(request);
  } catch {
    return jsonRpcError(500, "Something went wrong; please try again");
  }
}

export default { fetch: handle } satisfies ExportedHandler;
