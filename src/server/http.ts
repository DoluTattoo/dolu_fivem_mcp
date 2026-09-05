import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { McpServer } from "@modelcontextprotocol/server";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";

interface HttpOptions {
  port: number;
  createMcp: () => McpServer;
  log: (message: string) => void;
}
class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
function answer(res: ServerResponse, status: number, error: string): void {
  if (!res.headersSent)
    res.writeHead(status, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    });
  res.end(JSON.stringify({ error }));
}
export function createHttpEndpoint(options: HttpOptions) {
  const active = new Set<McpServer>();
  let requests = 0;
  let windowStart = Date.now();
  let closing = false;
  const server = createServer((req, res) => {
    void handle(req, res).catch((error: unknown) => {
      const status = error instanceof HttpError ? error.status : 500;
      options.log(
        `HTTP ${status}: ${error instanceof Error ? error.message : String(error)}`,
      );
      if (!res.writableEnded)
        answer(
          res,
          status,
          status === 500
            ? "Internal MCP error"
            : String(error instanceof Error ? error.message : error),
        );
    });
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5000;
  server.maxConnections = 64;

  async function handle(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    if (closing) throw new HttpError(503, "Resource is stopping");
    const address = server.address();
    const port =
      address && typeof address !== "string" ? address.port : options.port;
    const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
    if (!hosts.has(req.headers.host ?? ""))
      throw new HttpError(403, "Invalid Host");
    const origin = req.headers.origin;
    if (origin && ![...hosts].some((host) => origin === `http://${host}`))
      throw new HttpError(403, "Invalid Origin");
    if (Date.now() - windowStart > 60_000) {
      windowStart = Date.now();
      requests = 0;
    }
    if (++requests > 600 || active.size >= 32)
      throw new HttpError(429, "MCP request limit reached");
    if (req.url === "/health" && req.method === "GET") {
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      });
      res.end(JSON.stringify({ ok: true, name: "dolu_fivem_mcp" }));
      return;
    }
    if (req.url !== "/mcp") throw new HttpError(404, "Not found");
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      throw new HttpError(405, "Stateless MCP endpoint: use POST");
    }
    if (
      req.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() !==
      "application/json"
    )
      throw new HttpError(415, "Expected application/json");
    if (
      req.headers["content-encoding"] &&
      req.headers["content-encoding"] !== "identity"
    )
      throw new HttpError(415, "Compressed bodies are not supported");
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of req) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > 524_288)
        throw new HttpError(413, "Request body exceeds 512 KiB");
      chunks.push(buffer);
    }
    let body: unknown;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      throw new HttpError(400, "Invalid JSON");
    }
    if (typeof body !== "object" || body === null || Array.isArray(body))
      throw new HttpError(400, "Expected a single JSON-RPC object");
    const mcp = options.createMcp();
    const transport = new NodeStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    active.add(mcp);
    const dispose = () => {
      if (!active.delete(mcp)) return;
      void mcp
        .close()
        .catch((error: unknown) => options.log(`MCP close: ${String(error)}`));
    };
    res.once("close", dispose);
    try {
      await mcp.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (error) {
      dispose();
      throw error;
    }
  }
  return {
    server,
    async listen(): Promise<void> {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(options.port, "127.0.0.1", () => {
          server.removeListener("error", reject);
          server.on("error", (error) =>
            options.log(`HTTP server: ${error.message}`),
          );
          resolve();
        });
      });
    },
    async close(): Promise<void> {
      closing = true;
      const closed = new Promise<void>((resolve, reject) => {
        if (!server.listening) {
          resolve();
          return;
        }
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      });
      await Promise.all([...active].map((mcp) => mcp.close()));
      active.clear();
      await closed;
    },
  };
}
