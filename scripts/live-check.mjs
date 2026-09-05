import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    fixture: { type: "boolean", default: false },
    soak: { type: "string", default: "0" },
    output: { type: "string" },
    port: { type: "string", default: "3210" },
  },
});
const port = Number(values.port);
const repetitions = Number(values.soak);
assert(Number.isInteger(port) && port > 0 && port < 65536, "Invalid port");
assert(
  Number.isInteger(repetitions) && repetitions >= 0 && repetitions <= 100,
  "soak must be 0..100",
);
const endpoint = `http://127.0.0.1:${port}/mcp`;
const report = {
  startedAt: new Date().toISOString(),
  checks: [],
  limitations: [
    "Does not disconnect players, revoke ACEs, minimize the client, or restart dolu_fivem_mcp.",
    "Browser-host compatibility and manual fault injection require separate validation.",
  ],
};
let sequence = 0;
async function rpc(method, params = {}) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++sequence, method, params }),
    signal: AbortSignal.timeout(75000),
  });
  assert.equal(response.status, 200, `HTTP ${response.status}`);
  const message = await response.json();
  assert.equal(message.error, undefined, JSON.stringify(message.error));
  return message.result;
}
async function call(name, args = {}, expectedError = false) {
  const result = await rpc("tools/call", { name, arguments: args });
  assert.equal(
    Boolean(result.isError),
    expectedError,
    JSON.stringify(result.structuredContent ?? result.content).slice(0, 2000),
  );
  return result;
}
async function check(name, action) {
  const start = Date.now();
  try {
    const details = await action();
    report.checks.push({
      name,
      state: "passed",
      durationMs: Date.now() - start,
      details,
    });
    console.log(`PASS ${name}`);
    return details;
  } catch (error) {
    report.checks.push({
      name,
      state: "failed",
      durationMs: Date.now() - start,
      error: String(error),
    });
    throw error;
  }
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let fixtureStarted = false;
let fixtureShown = false;
let fixtureFrameId;
let playerId;
async function waitFixtureFrame(previous) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const listing = (await call("list_nui_frames", { playerId }))
      .structuredContent.result;
    const frames = listing.frames.filter(
      (frame) =>
        frame.resource === "dolu_fivem_mcp_test" && frame.url.endsWith("/index.html"),
    );
    if (frames.length === 1 && frames[0].frameId !== previous)
      return frames[0].frameId;
    await sleep(200);
  }
  throw new Error("Fixture NUI main frame did not become ready");
}
try {
  await check("MCP initialize", async () => {
    const result = await rpc("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "dolu-fivem-mcp-live-check", version: "1.0.0" },
    });
    assert.equal(result.serverInfo.name, "dolu_fivem_mcp");
    return { protocolVersion: result.protocolVersion };
  });
  const list = await check("tool discovery", async () => {
    const result = await rpc("tools/list");
    for (const name of [
      "diagnose",
      "run_scenario",
      "inspect_resource",
      "nui_interact",
      "nui_wait_for",
      "start_nui_observation",
      "game_screenshot",
    ]) {
      assert(
        result.tools.some((tool) => tool.name === name),
        `Missing ${name}; rebuild and restart from the FXServer console`,
      );
    }
    return result.tools.map((tool) => tool.name);
  });
  assert(list.length > 19);
  const players = (await call("list_players")).structuredContent.result.filter(
    (p) => p.authorized && p.ready,
  );
  assert.equal(
    players.length,
    1,
    "Live check requires exactly one authorized ready client",
  );
  playerId = players[0].playerId;
  await check("diagnostics", async () => {
    const diagnostics = (await call("diagnose", { playerId, runChecks: true }))
      .structuredContent.result;
    for (const id of [
      "build",
      "runtime",
      "resource_ace",
      "client_readiness",
      "nui_readiness",
      "server_javascript_native",
      "server_lua_native",
      "client_javascript_native",
      "client_lua_native",
      "cdp_bridge_capture",
    ]) {
      assert.equal(
        diagnostics.checks.find((entry) => entry.id === id)?.state,
        "pass",
        JSON.stringify(diagnostics),
      );
    }
    report.buildId = diagnostics.buildId;
    return diagnostics;
  });
  for (const target of ["server", "client"]) {
    for (const language of ["javascript", "lua"]) {
      const args = {
        language,
        timeoutMs: 2500,
        ...(target === "client" ? { playerId } : {}),
      };
      await check(`${target}/${language} return/log/yield`, async () => {
        const result = (
          await call(`execute_${target}`, {
            ...args,
            code:
              language === "javascript"
                ? 'console.log("mcp-live-check"); await ctx.sleep(100); return 42;'
                : 'print("mcp-live-check"); ctx.sleep(100); return 42, nil, ctx.resource',
          })
        ).structuredContent.result;
        assert.equal(result.state, "completed");
        assert.equal(result.outcome.values[0], 42);
        assert.equal(result.outcome.logs.length, 1);
        return { state: result.state, durationMs: result.outcome.durationMs };
      });
      await check(`${target}/${language} timeout`, async () => {
        const job = (
          await call(
            `execute_${target}`,
            {
              ...args,
              timeoutMs: 300,
              code:
                language === "javascript"
                  ? 'await ctx.sleep(700); return "late";'
                  : 'ctx.sleep(700); return "late"',
            },
            true,
          )
        ).structuredContent.result;
        assert.equal(job.state, "timed_out");
        assert(Date.parse(job.finishedAt) - Date.parse(job.startedAt) >= 300);
        return { state: job.state };
      });
      await check(`${target}/${language} explicit error`, async () => {
        const job = (
          await call(
            `execute_${target}`,
            {
              ...args,
              code:
                language === "javascript"
                  ? 'throw new Error("mcp-expected-error");'
                  : 'error("mcp-expected-error")',
            },
            true,
          )
        ).structuredContent.result;
        assert.equal(job.state, "failed");
        assert.match(job.outcome.error, /mcp-expected-error/);
        return { state: job.state };
      });
      await check(`${target}/${language} progressive logs/cancel`, async () => {
        const job = (
          await call(`execute_${target}`, {
            ...args,
            wait: false,
            code:
              language === "javascript"
                ? 'console.log("mcp-progressive"); await ctx.sleep(1500);'
                : 'print("mcp-progressive"); ctx.sleep(1500)',
          })
        ).structuredContent.result;
        try {
          const logs = (
            await call("wait_for_log", {
              executionId: job.id,
              contains: "mcp-progressive",
              after: 0,
              timeoutMs: 1000,
            })
          ).structuredContent.result;
          assert(logs.lines.some((line) => line.executionId === job.id));
          assert.equal(
            (await call("get_execution", { id: job.id })).structuredContent
              .result.state,
            "running",
          );
        } finally {
          await call("cancel_execution", { id: job.id }, true);
        }
        return { state: "cancelled" };
      });
    }
  }
  await check(
    "structured resource inspection",
    async () =>
      (await call("inspect_resource", { resource: "dolu_fivem_mcp" }))
        .structuredContent.result,
  );
  await check("player and runtime-scoped entities", async () => {
    const player = (await call("inspect_player", { playerId }))
      .structuredContent.result;
    assert.equal(player.runtime, "client");
    assert.equal(player.playerId, playerId);
    const results = [];
    for (const target of ["server", "client"]) {
      const scope =
        target === "server"
          ? { target, position: player.ped.position }
          : { target, playerId };
      const found = (
        await call("find_entities", { ...scope, type: "ped", limit: 3 })
      ).structuredContent.result;
      assert.equal(found.runtime, target);
      assert(found.entities.length > 0, "Expected at least the player's ped");
      const entity = (
        await call("inspect_entity", {
          target,
          ...(target === "client" ? { playerId } : {}),
          handle: found.entities[0].handle,
        })
      ).structuredContent.result;
      assert.equal(entity.runtime, target);
      assert.equal(entity.exists, true);
      results.push({
        runtime: target,
        scanned: found.scanned,
        handle: entity.handle,
        networkId: entity.networkId,
      });
    }
    return results;
  });
  await check("read-only scenario/assertions", async () => {
    const result = (
      await call("run_scenario", {
        name: "live arithmetic",
        resource: "dolu_fivem_mcp",
        playerId,
        steps: [
          {
            label: "arithmetic",
            tool: "execute_client",
            arguments: { language: "javascript", code: "return 42;" },
            assertions: [
              {
                path: ["outcome", "values", 0],
                operator: "equals",
                expected: 42,
              },
            ],
          },
        ],
      })
    ).structuredContent.result;
    assert.equal(result.state, "passed");
    assert.equal(
      (await call("get_scenario", { id: result.id })).structuredContent.result
        .id,
      result.id,
    );
    await call("delete_scenario", { id: result.id });
    return { id: result.id, state: result.state };
  });
  if (values.fixture) {
    const resources = (await call("list_resources")).structuredContent.result;
    const fixture = resources.find((r) => r.name === "dolu_fivem_mcp_test");
    assert(
      fixture,
      "Install tests/fixtures/dolu_fivem_mcp_test as a sibling resource and refresh first",
    );
    assert.equal(
      fixture.state,
      "stopped",
      "Fixture must initially be stopped; never take over an active resource",
    );
    await check("fixture start", async () => {
      fixtureStarted = true;
      await call("manage_resource", {
        resource: "dolu_fivem_mcp_test",
        action: "start",
      });
      await call("wait_for_resource", {
        resource: "dolu_fivem_mcp_test",
        state: "started",
        timeoutMs: 5000,
      });
      fixtureFrameId = await waitFixtureFrame();
      return { resource: "dolu_fivem_mcp_test", state: "started" };
    });
    await check("fixture NUI show and inspect", async () => {
      fixtureShown = true;
      await call("execute_nui", {
        playerId,
        resource: "dolu_fivem_mcp_test",
        frameId: fixtureFrameId,
        code: "fixture.reset(); fixture.show(); await fixture.focus(true); return true;",
      });
      return (
        await call("nui_snapshot", {
          playerId,
          resource: "dolu_fivem_mcp_test",
          frameId: fixtureFrameId,
        })
      ).structuredContent.result;
    });
    await check("fixture NUI interactions and observation", async () => {
      const args = {
        playerId,
        resource: "dolu_fivem_mcp_test",
        frameId: fixtureFrameId,
      };
      const session = (
        await call("start_nui_observation", {
          ...args,
          network: true,
          durationMs: 30000,
        })
      ).structuredContent.result;
      try {
        await call("nui_wait_for", {
          ...args,
          selector: "#name",
          condition: "visible",
        });
        for (const interaction of [
          { action: "fill", selector: "#name", text: "mcp-live-check" },
          { action: "select", selector: "#mode", values: ["b"] },
          { action: "click", selector: "#increment", mode: "dom" },
          { action: "click", selector: "#increment", mode: "cdp" },
          { action: "key", selector: "#increment", key: "Enter" },
          { action: "hover", selector: "#increment" },
          { action: "scroll", selector: "#scroll", deltaY: 100 },
        ])
          await call("nui_interact", { ...args, interaction });
        await call("nui_wait_for", {
          ...args,
          selector: "#count",
          condition: "text",
          text: "3",
        });
        await call(
          "nui_interact",
          { ...args, interaction: { action: "click", selector: "#disabled" } },
          true,
        );
        const fields = (
          await call("execute_nui", {
            ...args,
            code: "await fixture.ping(); return {name:document.querySelector('#name').value,mode:document.querySelector('#mode').value,scroll:document.querySelector('#scroll').scrollTop};",
          })
        ).structuredContent.result;
        assert.equal(fields.name, "mcp-live-check");
        assert.equal(fields.mode, "b");
        assert(fields.scroll > 0);
        const nested = (
          await call("list_nui_frames", { playerId })
        ).structuredContent.result.frames.find(
          (frame) =>
            frame.resource === "dolu_fivem_mcp_test" && frame.url === "about:srcdoc",
        );
        assert(nested, "Expected nested fixture frame");
        await call("nui_interact", {
          ...args,
          frameId: nested.frameId,
          interaction: { action: "click", selector: "#nested", mode: "cdp" },
        });
        await call("nui_wait_for", {
          ...args,
          frameId: nested.frameId,
          selector: "#nested",
          condition: "text",
          text: "Clicked",
        });
        await sleep(200);
        const observed = (
          await call("read_nui_observation", {
            id: session.id,
            playerId,
            limit: 100,
          })
        ).structuredContent.result;
        assert(
          observed.entries.some((entry) => entry.kind === "console"),
          "Expected observed fixture console",
        );
        assert(
          observed.entries.some((entry) => entry.kind.startsWith("network")),
          "Expected observed fixture network metadata",
        );
        return { fields, observed: observed.entries.length };
      } finally {
        await call("stop_nui_observation", { id: session.id, playerId });
      }
    });
    await check("fixture restart", async () => {
      const previousFrameId = fixtureFrameId;
      const snapshot = (
        await call("nui_snapshot", {
          resource: "dolu_fivem_mcp_test",
          playerId,
          frameId: previousFrameId,
        })
      ).structuredContent.result;
      const oldRef = snapshot.elements.find(
        (entry) => entry.id === "increment",
      )?.ref;
      assert(oldRef);
      const observation = (
        await call("start_nui_observation", {
          resource: "dolu_fivem_mcp_test",
          playerId,
          frameId: previousFrameId,
          durationMs: 30000,
        })
      ).structuredContent.result;
      try {
        await call("manage_resource", {
          resource: "dolu_fivem_mcp_test",
          action: "restart",
        });
        await call("wait_for_resource", {
          resource: "dolu_fivem_mcp_test",
          state: "started",
          timeoutMs: 5000,
        });
        fixtureFrameId = await waitFixtureFrame(fixtureFrameId);
        await call("execute_nui", {
          playerId,
          resource: "dolu_fivem_mcp_test",
          frameId: fixtureFrameId,
          code: "return fixture.ping();",
        });
        await call(
          "nui_snapshot",
          {
            resource: "dolu_fivem_mcp_test",
            playerId,
            frameId: previousFrameId,
          },
          true,
        );
        await call(
          "nui_interact",
          {
            resource: "dolu_fivem_mcp_test",
            playerId,
            frameId: fixtureFrameId,
            interaction: { action: "click", ref: oldRef },
          },
          true,
        );
        const ended = (
          await call("read_nui_observation", {
            id: observation.id,
            playerId,
          })
        ).structuredContent.result;
        assert.equal(ended.status, "disconnected");
        return {
          state: "started",
          oldFrameRejected: true,
          oldRefRejected: true,
          observation: ended.status,
        };
      } finally {
        await call("stop_nui_observation", { id: observation.id, playerId });
      }
    });
  }
  const shots = Math.max(1, repetitions);
  const samples = [];
  for (let i = 0; i < shots; i++) {
    await check(`game capture ${i + 1}/${shots}`, async () => {
      const result = await call("game_screenshot", {
        playerId,
        maxWidth: 640,
        includeNui: i % 2 === 1,
      });
      const image = result.content.find((item) => item.type === "image");
      assert(image && image.data.length > 0);
      const state = (
        await call("execute_nui", {
          playerId,
          resource: "dolu_fivem_mcp",
          code: "return {canvases:document.querySelectorAll('canvas').length,heap:performance.memory ? performance.memory.usedJSHeapSize : null};",
        })
      ).structuredContent.result;
      assert.equal(state.canvases, 0);
      samples.push(state.heap);
      return {
        ...result.structuredContent.result,
        bytes: Buffer.from(image.data, "base64").length,
        ...state,
      };
    });
  }
  report.heapSamples = samples;
  await check("scenario screenshot evidence lifecycle", async () => {
    const scenario = (
      await call("run_scenario", {
        name: "capture evidence",
        resource: "dolu_fivem_mcp",
        playerId,
        steps: [
          {
            label: "capture",
            tool: "game_screenshot",
            arguments: { maxWidth: 640 },
          },
        ],
      })
    ).structuredContent.result;
    try {
      assert.equal(scenario.state, "passed");
      const evidenceId = scenario.steps[0].evidenceId;
      assert(evidenceId);
      const evidence = await call("get_evidence", { id: evidenceId });
      assert(
        evidence.content.some(
          (item) => item.type === "image" && item.data.length > 0,
        ),
      );
      return { state: scenario.state, retrieved: true };
    } finally {
      await call("delete_scenario", { id: scenario.id });
    }
  });
  report.limitations.push(
    "Heap samples are observations, not proof that GPU/browser memory has no leak.",
  );
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  const cleanup = [];
  if (fixtureShown)
    cleanup.push(
      async () =>
        await call("execute_nui", {
          playerId,
          resource: "dolu_fivem_mcp_test",
          frameId: fixtureFrameId,
          code: "await fixture.focus(false); fixture.hide(); fixture.reset(); return true;",
        }),
    );
  if (fixtureStarted)
    cleanup.push(async () => {
      await call("manage_resource", {
        resource: "dolu_fivem_mcp_test",
        action: "stop",
      });
      await call("wait_for_resource", {
        resource: "dolu_fivem_mcp_test",
        state: "stopped",
        timeoutMs: 5000,
      });
    });
  for (const [index, action] of cleanup.entries()) {
    try {
      await action();
      report.checks.push({
        name: `fixture cleanup ${index + 1}`,
        state: "passed",
      });
    } catch (error) {
      report.checks.push({
        name: `fixture cleanup ${index + 1}`,
        state: "failed",
        error: String(error),
      });
      console.error(error);
      process.exitCode = 1;
    }
  }
  report.finishedAt = new Date().toISOString();
  if (values.output)
    await writeFile(values.output, JSON.stringify(report, null, 2) + "\n");
  console.log(
    JSON.stringify({
      passed: report.checks.filter((c) => c.state === "passed").length,
      failed: report.checks.filter((c) => c.state === "failed").length,
      report: values.output ?? null,
    }),
  );
}
