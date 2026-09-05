import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { request } from "node:http";
import { createHttpEndpoint } from "../src/server/http";

describe("local Streamable HTTP MCP", () => {
  let endpoint: ReturnType<typeof createHttpEndpoint>;
  let url: string;
  const logs: string[] = [];
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  beforeEach(async () => {
    endpoint = createHttpEndpoint({
      port: 0,
      log: (line) => logs.push(line),
      createMcp: () => {
        const mcp = new McpServer({ name: "test", version: "1.0.0" });
        mcp.registerTool(
          "echo",
          { inputSchema: z.object({ message: z.string() }) },
          ({ message }) => ({
            content: [{ type: "text", text: message }],
          }),
        );
        return mcp;
      },
    });
    await endpoint.listen();
    const address = endpoint.server.address();
    if (!address || typeof address === "string")
      throw new Error("Missing test address");
    url = `http://127.0.0.1:${address.port}`;
  });
  afterEach(async () => {
    await endpoint.close();
  });
  const rpc = (method: string, params: unknown = {}) =>
    JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });

  it("allows local access without authentication and refuses hostile Host/Origin", async () => {
    expect((await fetch(`${url}/health`)).status).toBe(200);
    expect((await fetch(`${url}/health`, { headers })).status).toBe(200);
    const hostileHost = await new Promise<number | undefined>(
      (resolve, reject) => {
        const req = request(
          `${url}/health`,
          { headers: { ...headers, Host: "attacker.example" } },
          (res) => {
            res.resume();
            res.on("end", () => resolve(res.statusCode));
          },
        );
        req.on("error", reject);
        req.end();
      },
    );
    expect(hostileHost).toBe(403);
    expect(
      (
        await fetch(`${url}/health`, {
          headers: { ...headers, Origin: "https://attacker.example" },
        })
      ).status,
    ).toBe(403);
  });
  it("negotiates MCP and lists/calls tools on separate stateless requests", async () => {
    const initialized = await fetch(`${url}/mcp`, {
      method: "POST",
      headers,
      body: rpc("initialize", {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "test", version: "1" },
      }),
    });
    expect(initialized.status).toBe(200);
    expect(await initialized.json()).toMatchObject({
      result: { serverInfo: { name: "test" } },
    });
    const list = await fetch(`${url}/mcp`, {
      method: "POST",
      headers,
      body: rpc("tools/list"),
    });
    expect(await list.json()).toMatchObject({
      result: { tools: [{ name: "echo" }] },
    });
    const call = await fetch(`${url}/mcp`, {
      method: "POST",
      headers,
      body: rpc("tools/call", {
        name: "echo",
        arguments: { message: "working" },
      }),
    });
    expect(await call.json()).toMatchObject({
      result: { content: [{ type: "text", text: "working" }] },
    });
  });
  it("rejects malformed input, batches and oversized bodies", async () => {
    for (const body of ["{", "[]", "null"]) {
      expect(
        (await fetch(`${url}/mcp`, { method: "POST", headers, body })).status,
      ).toBe(400);
    }
    expect(
      (
        await fetch(`${url}/mcp`, {
          method: "POST",
          headers,
          body: "x".repeat(530000),
        })
      ).status,
    ).toBe(413);
    expect((await fetch(`${url}/mcp`, { headers })).status).toBe(405);
  });
});
