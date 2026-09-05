const assert = require("node:assert/strict");
const { delimiter, dirname } = require("node:path");

// npm exec exposes its temporary dependency directory through PATH.
const paths = process.env.PATH.split(delimiter).map((entry) => dirname(entry));
const sdk = require(require.resolve("@modelcontextprotocol/client", { paths }));

async function main() {
  const client = new sdk.Client(
    { name: "dolu-fivem-mcp-sdk-check", version: "1.0.0" },
    { capabilities: {} },
  );
  const transport = new sdk.StreamableHTTPClientTransport(
    new URL("http://127.0.0.1:3210/mcp"),
  );
  try {
    await client.connect(transport);
    await client.ping();
    const tools = await client.listTools();
    assert.equal(tools.tools.length, 35);
    const status = await client.callTool({ name: "status", arguments: {} });
    assert(!status.isError);
    const ready = status.structuredContent.result.players.filter(
      (player) => player.authorized && player.ready,
    );
    assert.equal(
      ready.length,
      1,
      "Expected exactly one ready authorized client",
    );
    const playerId = ready[0].playerId;
    const executed = await client.callTool({
      name: "execute_client",
      arguments: { playerId, language: "javascript", code: "return 6 * 7;" },
    });
    assert(!executed.isError);
    assert.equal(executed.structuredContent.result.outcome.values[0], 42);
    const failure = await client.callTool({
      name: "execute_server",
      arguments: {
        language: "javascript",
        code: 'throw new Error("mcp-sdk-expected-error");',
      },
    });
    assert.equal(failure.isError, true);
    const image = await client.callTool({
      name: "game_screenshot",
      arguments: { playerId, maxWidth: 320 },
    });
    assert(!image.isError);
    assert(image.content.some((item) => item.type === "image" && item.data));
    const resources = await client.listResources();
    assert(
      resources.resources.some(
        (entry) => entry.uri === "fivem://dolu_fivem_mcp/execution-guide",
      ),
    );
    const guide = await client.readResource({
      uri: "fivem://dolu_fivem_mcp/execution-guide",
    });
    assert(
      guide.contents.some(
        (entry) =>
          typeof entry.text === "string" && entry.text.includes("cooperative"),
      ),
    );
    const prompts = await client.listPrompts();
    assert(prompts.prompts.some((entry) => entry.name === "test_resource"));
    console.log(
      JSON.stringify(
        {
          sdk: "@modelcontextprotocol/client",
          transport: "Streamable HTTP",
          tools: tools.tools.length,
          playerId,
          buildId: status.structuredContent.result.buildId,
          checks: [
            "connect",
            "ping",
            "tools",
            "structured result",
            "tool error",
            "image",
            "resources",
            "prompts",
          ],
          passed: true,
        },
        null,
        2,
      ),
    );
  } finally {
    await client.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
