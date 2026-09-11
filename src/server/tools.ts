import { McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";
import { setTimeout as delay } from "node:timers/promises";
import {
  VERSION,
  MAX_CODE,
  errorMessage,
  executionSchema,
} from "../shared/protocol";
import type { GameService } from "./game";
import {
  gameScreenshotOptionsSchema,
  type NuiDebugger,
  nuiInteractionSchema,
  nuiWaitSchema,
  nuiObservationSchema,
  nuiObservationReadSchema,
} from "./nui";
import { diagnose } from "./diagnostics";
import { ScenarioRunner, scenarioSchema } from "./scenarios";
import {
  FiveMInspector,
  inspectResourceSchema,
  inspectPlayerSchema,
  findEntitiesSchema,
  inspectEntitySchema,
} from "./inspectors";

const player = z.number().int().positive().optional();
const resource = z.string().min(1).max(128);
const timeout = z.number().int().min(100).max(60_000).default(10_000);
const readOnly = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};
const mutating = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
};

function result(value: unknown, failed = false): CallToolResult {
  const payload = { result: value };
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    structuredContent: payload,
    isError: failed,
  };
}
function failedJob(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "state" in value &&
    ["failed", "timed_out", "cancelled", "disconnected"].includes(
      String(value.state),
    )
  );
}
const CONTRACT = `Trusted local development only. Runs in dolu_fivem_mcp's own resource, not other resources' private locals.
Use native functions, exports or events to interact with other resources.
JavaScript: async body with return, console.log, ctx.log, await ctx.sleep(ms), ctx.alive(), ctx.onCleanup(fn).
After Node I/O, call await ctx.game(() => nativeCall()) to return to the game thread.
Lua: chunk with return, print, ctx.log, ctx.sleep(ms), ctx.alive(), ctx.onCleanup(fn); Wait is supported.
Cleanups run when the snippet exits. Raw timers/threads/entities are not automatically undone.
Timeout/cancel is cooperative and does NOT guarantee code interruption or rollback.
Use wait=false for long operations, then get_execution/cancel_execution. Never automatically retry side effects.`;

export function createTools(
  game: GameService,
  nui: Pick<
    NuiDebugger,
    | "frames"
    | "evaluate"
    | "snapshot"
    | "click"
    | "screenshot"
    | "gameScreenshot"
    | "interact"
    | "waitFor"
    | "startObservation"
    | "readObservation"
    | "stopObservation"
    | "listObservations"
  >,
  scenarios = new ScenarioRunner(),
): McpServer {
  const invokers = new Map<
    string,
    (
      args: Record<string, unknown>,
      signal: AbortSignal,
    ) => Promise<CallToolResult>
  >();
  const validators = new Map<
    string,
    (args: Record<string, unknown>) => unknown
  >();
  const inspector = new FiveMInspector(game);
  const server = new McpServer(
    { name: "dolu_fivem_mcp", version: VERSION },
    {
      instructions: `Local FiveM development resource. Call status once to establish readiness and select the player; reuse it until a restart, disconnect or readiness error. status already includes players: do not also call list_players unless refreshing them.
    Discover resources only when needed: use inspect_resource for a known resource or list_resources with name/state filters. Screenshots and snippets do not require a full resource listing. Call the intended tool directly once its target is known; use diagnose for failures, not routine preflight.
Client/server JavaScript and Lua execution are supported; NUI uses JavaScript through local CEF DevTools.
No filesystem editing tools: use your editor. ${CONTRACT}`,
    },
  );
  function tool<S extends z.ZodRawShape>(
    name: string,
    description: string,
    shape: S,
    readonly: boolean,
    handler: (
      args: z.output<z.ZodObject<S>>,
      signal: AbortSignal,
    ) => unknown | Promise<unknown>,
  ): void {
    const schema = z.object(shape);
    validators.set(name, (args) => schema.parse(args));
    const invoke = async (
      raw: Record<string, unknown>,
      signal: AbortSignal,
    ): Promise<CallToolResult> => {
      const start = Date.now();
      try {
        signal.throwIfAborted();
        const value = await handler(schema.parse(raw), signal);
        if (!readonly) game.audit(`tool ${name} ${Date.now() - start}ms`);
        return result(value, failedJob(value));
      } catch (error) {
        const message = errorMessage(error);
        game.audit(`tool ${name} failed: ${message}`, true);
        return result({ error: message }, true);
      }
    };
    invokers.set(name, invoke);
    server.registerTool(
      name,
      {
        description,
        inputSchema: schema,
        annotations: readonly ? readOnly : mutating,
      },
      (args, context) => invoke(args, context.mcpReq.signal),
    );
  }
  function imageTool<S extends z.ZodRawShape>(
    name: string,
    description: string,
    schema: z.ZodObject<S>,
    handler: (args: z.output<z.ZodObject<S>>) => Promise<CallToolResult>,
  ) {
    validators.set(name, (args) => schema.parse(args));
    const invoke = async (
      raw: Record<string, unknown>,
      signal: AbortSignal,
    ) => {
      signal.throwIfAborted();
      return handler(schema.parse(raw));
    };
    invokers.set(name, invoke);
    server.registerTool(
      name,
      { description, inputSchema: schema, annotations: readOnly },
      (args, context) => invoke(args, context.mcpReq.signal),
    );
  }

  tool(
    "status",
    "MCP readiness, authorized players, console capture and local NUI debugging configuration.",
    {},
    true,
    async () => ({
      version: VERSION,
      buildId: game.buildId,
      resource: game.resource,
      players: await game.players(),
      serverConsole: game.consoleAvailable,
      clientLogs: "Only captured snippet logs, not the global F8 console.",
      nui: {
        port: game.config.cdpPort,
        configuredPlayer: game.config.cdpPlayer || null,
        mode: "local CEF; call list_nui_frames to connect",
      },
      executions: game.jobs.list().filter((job) => job.state === "running")
        .length,
      transport:
        "Stateless Streamable HTTP; explicit cancel_execution for jobs.",
    }),
  );
  tool(
    "list_players",
    "Connected players and MCP authorization/readiness. Client tools require an authorized ready target.",
    {},
    true,
    () => game.players(),
  );
  tool(
    "diagnose",
    "Report runtime/build/ACE/client/CEF capabilities with pass/fail/unavailable/not_tested and remediation. runChecks=true runs bounded read-only JS/Lua native probes; capture=true explicitly tests a small game capture.",
    {
      playerId: player,
      runChecks: z.boolean().default(false),
      capture: z.boolean().default(false),
    },
    true,
    (args) => diagnose(game, nui, args),
  );
  tool(
    "list_resources",
    "List installed resources and state. Prefer name (case-insensitive substring) and/or state filters to reduce output. Omit filters only for a full inventory.",
    {
      name: z.string().min(1).max(128).optional(),
      state: z
        .enum([
          "started",
          "starting",
          "stopped",
          "stopping",
          "uninitialized",
          "missing",
          "unknown",
        ])
        .optional(),
    },
    true,
    async ({ name, state }) => {
      const resources = await game.resources();
      const query = name?.toLowerCase();
      return resources.filter(
        (entry) =>
          (query === undefined || entry.name.toLowerCase().includes(query)) &&
          (state === undefined || entry.state === state),
      );
    },
  );
  tool(
    "inspect_resource",
    "Read bounded whitelisted resource metadata, declared exports/dependencies and reverse dependencies. Dynamic exports are not enumerable.",
    inspectResourceSchema.shape,
    true,
    ({ resource }) => inspector.inspectResource(resource),
  );
  tool(
    "inspect_player",
    "Read the authorized ready client's ped, position, vehicle handle and routing bucket. Handles are client-local and ephemeral; no identifiers or state bag contents.",
    inspectPlayerSchema.shape,
    true,
    ({ playerId }) => inspector.inspectPlayer(playerId),
  );
  tool(
    "find_entities",
    "Search visible ped/vehicle/object pools within at most 500m; limit 100, scan cap 10000. Server requires position and OneSync; client defaults to own ped position. Handles are runtime-local.",
    findEntitiesSchema.shape,
    true,
    (args) => inspector.findEntities(findEntitiesSchema.parse(args)),
  );
  tool(
    "inspect_entity",
    "Read an entity by exactly one runtime-local handle or networkId. Select server or an authorized client; no state bag values, mutation or cross-runtime handle guessing.",
    inspectEntitySchema.shape,
    true,
    (args) => inspector.inspectEntity(inspectEntitySchema.parse(args)),
  );
  validators.set("find_entities", (args) => findEntitiesSchema.parse(args));
  validators.set("inspect_entity", (args) => inspectEntitySchema.parse(args));
  tool(
    "manage_resource",
    "Start, ensure, stop, restart a resource or refresh resource discovery. Self-management is refused. Inspect state/logs afterwards.",
    {
      action: z.enum(["start", "ensure", "stop", "restart", "refresh"]),
      resource: resource.optional(),
    },
    false,
    ({ action, resource }) => game.manage(action, resource),
  );
  tool(
    "execute_command",
    "Dispatch a single FXServer console command using the resource's ACE permissions. Returns a log cursor, not proof of command success.",
    {
      command: z.string().min(1).max(4096),
    },
    false,
    ({ command }) => game.command(command),
  );

  tool(
    "execute_server",
    "Execute server JavaScript (async body) or Lua (chunk) in this resource, not another resource's private locals. Follow the execution contract in server instructions. After Node I/O use ctx.game for natives. Timeout/cancel is cooperative, not rollback; never auto-retry side effects.",
    executionSchema.shape,
    false,
    (args, signal) =>
      game.execute("server", executionSchema.parse(args), undefined, signal),
  );
  tool(
    "execute_client",
    "Execute client JavaScript (async body) or Lua (chunk) in this resource. Auto-selects only one authorized ready player. Follow the execution contract in server instructions; use exports/events for other resources. Timeout/cancel is cooperative, not rollback; never auto-retry side effects.",
    {
      ...executionSchema.shape,
      playerId: player,
    },
    false,
    (args, signal) =>
      game.execute(
        "client",
        executionSchema.parse(args),
        args.playerId,
        signal,
      ),
  );
  tool(
    "list_executions",
    "Recent execution metadata and results (bounded in-memory history).",
    {},
    true,
    () =>
      game.jobs
        .list()
        .map(({ outcome, ...job }) => ({ ...job, ok: outcome?.ok })),
  );
  tool(
    "get_execution",
    "Get a running or completed execution and its captured result. History is lost on resource restart.",
    {
      id: z.string().uuid(),
    },
    true,
    ({ id }) => game.jobs.get(id),
  );
  tool(
    "cancel_execution",
    "Request cooperative cancellation. Does not roll back side effects or guarantee termination.",
    {
      id: z.string().uuid(),
    },
    false,
    ({ id }) => game.jobs.cancel(id),
  );

  const logShape = {
    after: z.number().int().nonnegative().optional(),
    limit: z.number().int().min(1).max(200).default(50),
    source: z.enum(["server", "client", "audit"]).optional(),
    contains: z.string().max(256).optional(),
    playerId: player,
    executionId: z.string().uuid().optional(),
    channel: z.string().min(1).max(128).optional(),
    level: z.enum(["debug", "info", "warn", "error"]).optional(),
  };
  tool(
    "read_logs",
    "Read bounded logs with an incremental cursor. Server console when available; client logs are captured snippets only. Capture begins when dolu_fivem_mcp starts.",
    logShape,
    true,
    (args) => game.logs.read(args),
  );
  tool(
    "wait_for_log",
    "Wait for a literal text match, not regex. Pass the cursor from before your action to avoid missing an early log. Otherwise watches new logs only.",
    {
      ...logShape,
      contains: z.string().min(1).max(256),
      timeoutMs: timeout,
    },
    true,
    async (args, signal) => {
      let cursor = args.after ?? game.logs.read().nextCursor;
      const deadline = Date.now() + args.timeoutMs;
      while (Date.now() < deadline) {
        const page = game.logs.read({ ...args, after: cursor });
        if (page.lines.length) return page;
        cursor = page.nextCursor;
        await delay(100, undefined, { signal });
      }
      throw new Error("No matching log before deadline");
    },
  );
  tool(
    "wait_for_resource",
    "Wait until a resource reaches a state. Started does not guarantee that framework-specific initialization has finished.",
    {
      resource,
      state: z.enum(["started", "stopped", "missing"]).default("started"),
      timeoutMs: timeout,
    },
    true,
    async (args, signal) => {
      const deadline = Date.now() + args.timeoutMs;
      while (Date.now() < deadline) {
        const found = (await game.resources()).find(
          (item) => item.name === args.resource,
        );
        if ((found?.state ?? "missing") === args.state)
          return { resource: args.resource, state: args.state };
        await delay(100, undefined, { signal });
      }
      throw new Error(
        "Resource did not reach the requested state before deadline",
      );
    },
  );

  const nuiShape = {
    resource,
    playerId: player,
    frameId: z.string().max(256).optional(),
  };
  tool(
    "list_nui_frames",
    "Discover debuggable NUI frames through CEF on the FXServer machine. Requires an authorized client connected through loopback or a server-owned interface address. No access to remote players' browsers.",
    {
      playerId: player,
    },
    true,
    async ({ playerId }) => {
      const selected = await game.assertLocalNui(playerId);
      return { playerId: selected, frames: await nui.frames() };
    },
  );
  tool(
    "execute_nui",
    "Execute an async JavaScript function body in a resource's actual NUI main world via CDP. Supports return/await. Cannot access module-private variables. Does not roll back DOM changes.",
    {
      ...nuiShape,
      code: z.string().min(1).max(MAX_CODE),
    },
    false,
    async ({ resource, playerId, frameId, code }) => {
      await game.assertLocalNui(playerId);
      return nui.evaluate(resource, code, frameId);
    },
  );
  tool(
    "nui_snapshot",
    "Read a bounded DOM summary and interactive elements of a resource's NUI. Input values are omitted; rendered page text can still be sensitive.",
    nuiShape,
    true,
    async ({ resource, playerId, frameId }) => {
      await game.assertLocalNui(playerId);
      return nui.snapshot(resource, frameId);
    },
  );
  tool(
    "nui_click",
    "Programmatically click exactly one DOM element matching a CSS selector. Synthetic click, not a real OS mouse action.",
    {
      ...nuiShape,
      selector: z.string().min(1).max(1024),
    },
    false,
    async ({ resource, playerId, frameId, selector }) => {
      await game.assertLocalNui(playerId);
      return nui.click(resource, selector, frameId);
    },
  );
  tool(
    "nui_interact",
    "Interact with one visible enabled NUI element by selector or snapshot ref. Supports DOM/CDP click, fill, select, key, hover and scroll; refuses ambiguous, hidden, disabled or stale targets. CDP input may change focus.",
    { ...nuiShape, interaction: nuiInteractionSchema },
    false,
    async ({ resource, playerId, frameId, interaction }) => {
      await game.assertLocalNui(playerId);
      return nui.interact(resource, interaction, frameId);
    },
  );
  tool(
    "nui_wait_for",
    "Wait for visible/hidden/attached/detached/enabled/text state in the selected frame, bounded to 60 seconds and cancellable.",
    { ...nuiShape, ...nuiWaitSchema.shape },
    true,
    async (args, signal) => {
      await game.assertLocalNui(args.playerId);
      return nui.waitFor(
        args.resource,
        nuiWaitSchema.parse(args),
        args.frameId,
        signal,
      );
    },
  );
  validators.set("nui_wait_for", (args) =>
    z.object(nuiShape).and(nuiWaitSchema).parse(args),
  );
  tool(
    "start_nui_observation",
    "Start a bounded console/exception/network-metadata observation bound to the selected local player/frame. Max 60 seconds, 500 entries; no headers, bodies, cookies or URL queries. Network opt-in. Explicitly stop when finished.",
    { ...nuiShape, ...nuiObservationSchema.shape },
    false,
    async (args) => {
      const playerId = await game.assertLocalNui(args.playerId);
      return nui.startObservation(
        args.resource,
        { ...args, playerId },
        args.frameId,
        async () => {
          await game.assertLocalNui(playerId);
        },
      );
    },
  );
  tool(
    "list_nui_observations",
    "List retained observations for the authorized selected local player.",
    { playerId: player },
    true,
    async ({ playerId }) => {
      const selected = await game.assertLocalNui(playerId);
      return (await nui.listObservations()).filter(
        (entry) => entry.playerId === selected,
      );
    },
  );
  tool(
    "read_nui_observation",
    "Read bounded events by cursor; rechecks captured player authorization and reports dropped/skipped entries.",
    {
      id: z.string().uuid(),
      playerId: player,
      ...nuiObservationReadSchema.shape,
    },
    true,
    async ({ id, playerId, ...options }) => {
      const selected = await game.assertLocalNui(playerId);
      const observation = await nui.readObservation(id, options);
      if (observation.playerId !== selected)
        throw new Error("Observation belongs to another player");
      return observation;
    },
  );
  tool(
    "stop_nui_observation",
    "Stop an owned observation and release its CDP connection. Retained events remain briefly readable.",
    { id: z.string().uuid(), playerId: player },
    false,
    async ({ id, playerId }) => {
      const selected = await game.assertLocalNui(playerId);
      const observation = (await nui.listObservations()).find(
        (entry) => entry.id === id,
      );
      if (!observation || observation.playerId !== selected)
        throw new Error("Unknown, expired or inaccessible observation");
      return nui.stopObservation(id);
    },
  );

  imageTool(
    "game_screenshot",
    "Capture the local player's GTA game framebuffer (including GTA HUD) via the invisible bridge's WebGL hook. includeNui=true composites the selected main CEF target over the game; the two captures are not simultaneous and other Chromium targets/OS overlays are not included. Requires local CEF DevTools even without NUI. Returns an MCP image and capture metadata; never silently omits a requested NUI overlay.",
    gameScreenshotOptionsSchema.extend({ playerId: player }),
    async (args) => {
      try {
        const playerId = await game.assertLocalNui(args.playerId);
        const { data, ...metadata } = await nui.gameScreenshot(
          game.resource,
          gameScreenshotOptionsSchema.parse(args),
        );
        const details = result({ playerId, ...metadata });
        game.audit(
          `tool game_screenshot player=${playerId} nui=${args.includeNui}`,
        );
        return {
          ...details,
          content: [
            { type: "image" as const, data, mimeType: metadata.mimeType },
            ...details.content,
          ],
        };
      } catch (error) {
        const message = errorMessage(error);
        game.audit(`tool game_screenshot failed: ${message}`, true);
        return result({ error: message }, true);
      }
    },
  );
  imageTool(
    "nui_screenshot",
    "Capture the whole selected Chromium NUI target as PNG, not an isolated frame or the GTA game scene. Other resource frames may appear.",
    z.object(nuiShape),
    async ({ resource, playerId, frameId }) => {
      try {
        await game.assertLocalNui(playerId);
        const data = await nui.screenshot(resource, frameId);
        game.audit(`tool nui_screenshot resource=${resource}`);
        return { content: [{ type: "image", data, mimeType: "image/png" }] };
      } catch (error) {
        game.audit(`tool nui_screenshot failed: ${errorMessage(error)}`, true);
        return result({ error: errorMessage(error) }, true);
      }
    },
  );

  tool(
    "run_scenario",
    "Run up to 12 explicit scoped tool steps with assertions, fail-fast, and up to 4 declared cleanup steps (in order, even on failure). No retries or universal rollback. Evidence and reports expire after 15 minutes; screenshots are retrieved separately.",
    scenarioSchema.shape,
    false,
    async (args, signal) => {
      const input = scenarioSchema.parse(args);
      const needsPlayer = [...input.steps, ...input.cleanup].some(
        (step) =>
          [
            "execute_client",
            "execute_nui",
            "nui_snapshot",
            "nui_interact",
            "nui_wait_for",
            "game_screenshot",
            "inspect_player",
          ].includes(step.tool) ||
          (["find_entities", "inspect_entity"].includes(step.tool) &&
            step.arguments.target === "client"),
      );
      if (needsPlayer && input.playerId === undefined) {
        const ready = (await game.players()).filter(
          (entry) => entry.authorized && entry.ready,
        );
        if (ready.length !== 1)
          throw new Error(
            "Scenario requires an explicit playerId or exactly one ready authorized client",
          );
        input.playerId = ready[0]!.playerId;
      }
      return scenarios.run(
        input,
        async (name, parameters, stepSignal) => {
          const invoke = invokers.get(name);
          if (!invoke) throw new Error(`Scenario tool ${name} is unavailable`);
          return invoke(parameters, stepSignal);
        },
        signal,
        (name, parameters) => {
          const validate = validators.get(name);
          if (!validate)
            throw new Error(`Scenario tool ${name} is unavailable`);
          validate(parameters);
        },
      );
    },
  );
  tool(
    "list_scenarios",
    "List bounded in-memory scenario reports; history is lost on restart.",
    {},
    true,
    () => scenarios.list(),
  );
  tool(
    "get_scenario",
    "Read a scenario report with assertion results, cleanup status and evidence ids.",
    { id: z.string().uuid() },
    true,
    ({ id }) => scenarios.get(id),
  );
  tool(
    "delete_scenario",
    "Delete a completed scenario and its retained image evidence.",
    { id: z.string().uuid() },
    false,
    ({ id }) => scenarios.remove(id),
  );
  imageTool(
    "get_evidence",
    "Retrieve a retained scenario image by id; expires with its report after 15 minutes.",
    z.object({ id: z.string().uuid() }),
    async ({ id }) => {
      try {
        return scenarios.getEvidence(id);
      } catch (error) {
        return result({ error: errorMessage(error) }, true);
      }
    },
  );

  server.registerResource(
    "execution-guide",
    "fivem://dolu_fivem_mcp/execution-guide",
    {
      description: "Execution contexts, helpers and limitations",
      mimeType: "text/plain",
    },
    (uri) => ({
      contents: [{ uri: uri.href, text: CONTRACT, mimeType: "text/plain" }],
    }),
  );
  server.registerPrompt(
    "test_resource",
    {
      description: "A disciplined local FiveM development loop",
      argsSchema: z.object({
        resource: z.string(),
        expectations: z.string().optional(),
      }),
    },
    ({ resource, expectations }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `Test FiveM resource ${resource}. Expectations: ${expectations ?? "startup without errors"}.
Use status if readiness is not already known, inspect_resource for the target, record the log cursor, then restart only the target resource.
Wait for started, inspect server logs, select an authorized client and exercise its actual behavior.
For a NUI, inspect the real resource frame, interact and observe results.
Distinguish dispatched commands from completed operations. Do not infer success from missing errors.
Report actual results and anything you could not observe. Clean up any entities/timers you created.`,
          },
        },
      ],
    }),
  );
  return server;
}
