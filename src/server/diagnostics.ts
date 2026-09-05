import { BUILD_ID } from "../shared/build";
import { CAPTURE_VERSION } from "../shared/capture";
import { z } from "zod";
import { errorMessage } from "../shared/protocol";
import type { GameService } from "./game";

export type DiagnosticState = "pass" | "fail" | "unavailable" | "not_tested";
export interface DiagnosticCheck {
  id: string;
  state: DiagnosticState;
  reason: string;
  remediation: string | null;
  details?: unknown;
}
export interface DiagnosticOptions {
  playerId?: number;
  runChecks?: boolean;
  capture?: boolean;
}
export interface DiagnosticNui {
  evaluate?: (
    resource: string,
    code: string,
    frameId?: string,
  ) => Promise<unknown>;
  gameScreenshot?: (
    resource: string,
    options: {
      includeNui: boolean;
      maxWidth: number;
      format: "jpeg" | "png";
      quality: number;
    },
  ) => Promise<unknown>;
}
type DiagnosticGame = Pick<
  GameService,
  | "resource"
  | "buildId"
  | "players"
  | "runtimeInfo"
  | "execute"
  | "assertLocalNui"
>;
const bridgeSchema = z.object({
  buildId: z.string().nullable(),
  version: z.number().nullable(),
  captureAvailable: z.boolean(),
});

/** Default inspection never executes snippets or captures an image. */
export async function diagnose(
  game: DiagnosticGame,
  nui: DiagnosticNui,
  options: DiagnosticOptions = {},
) {
  const checks: DiagnosticCheck[] = [];
  const add = (
    id: string,
    state: DiagnosticState,
    reason: string,
    remediation: string | null = null,
    details?: unknown,
  ) =>
    checks.push({
      id,
      state,
      reason,
      remediation,
      ...(details === undefined ? {} : { details }),
    });
  let runtime: Awaited<ReturnType<DiagnosticGame["runtimeInfo"]>> | null = null;
  let players: Awaited<ReturnType<DiagnosticGame["players"]>> = [];
  add(
    "build",
    BUILD_ID === "development" ? "unavailable" : "pass",
    BUILD_ID === "development"
      ? "No generated build identity in this runtime."
      : `Server build ${game.buildId}`,
    BUILD_ID === "development"
      ? "Run npm run build and restart dolu_fivem_mcp."
      : null,
  );
  try {
    runtime = await game.runtimeInfo();
    add(
      "runtime",
      runtime.resourceState === "started" ? "pass" : "fail",
      `Resource ${runtime.resourceState}; Node ${runtime.node}; artifact ${runtime.artifact}`,
      runtime.resourceState === "started"
        ? null
        : "Start the resource from the FXServer console.",
      runtime,
    );
    add(
      "server_console",
      runtime.consoleAvailable ? "pass" : "unavailable",
      runtime.consoleAvailable
        ? "Server console listener registered."
        : "This artifact has no console listener API.",
      runtime.consoleAvailable
        ? null
        : "Upgrade FXServer; scoped snippet logs still work.",
    );
    const denied = Object.entries(runtime.commandAces)
      .filter(([, allowed]) => !allowed)
      .map(([command]) => command);
    add(
      "resource_ace",
      denied.length ? "fail" : "pass",
      denied.length
        ? `Missing command ACEs: ${denied.join(", ")}`
        : "Resource management command ACEs granted.",
      denied.length
        ? `Grant only required command.<name> ACEs to resource.${game.resource}.`
        : null,
    );
  } catch (error) {
    add(
      "runtime",
      "unavailable",
      errorMessage(error),
      "Inspect the FXServer resource console.",
    );
    for (const id of ["server_console", "resource_ace"])
      add(
        id,
        "unavailable",
        "Runtime inspection could not complete.",
        "Resolve the runtime diagnostic first.",
      );
  }
  try {
    players = await game.players();
  } catch (error) {
    add(
      "players",
      "unavailable",
      errorMessage(error),
      "Check FiveM player natives and resource state.",
    );
  }
  const candidates = players.filter((player) => player.ready);
  const selected =
    options.playerId === undefined
      ? candidates.length === 1
        ? candidates[0]
        : undefined
      : players.find((player) => player.playerId === options.playerId);
  add(
    "client_readiness",
    selected?.ready ? "pass" : selected ? "fail" : "unavailable",
    selected
      ? selected.ready
        ? "Selected client is authorized and build-matched."
        : selected.readinessReasons.join(", ")
      : options.playerId
        ? "Selected player is disconnected."
        : "No unambiguous ready client.",
    selected?.ready
      ? null
      : "Specify playerId, grant its MCP ACE, and restart stale client resources.",
    selected,
  );
  add(
    "nui_readiness",
    selected?.nuiReady ? "pass" : "unavailable",
    selected?.nuiReady
      ? "NUI heartbeat reports matching build."
      : (selected?.nuiReadinessReason ?? "No selected client."),
    selected?.nuiReady
      ? null
      : "Refresh/restart the client NUI and check server/client/NUI build IDs.",
  );
  for (const target of ["server", "client"] as const) {
    for (const language of ["javascript", "lua"] as const) {
      const id = `${target}_${language}_native`;
      if (!options.runChecks) {
        add(
          id,
          "not_tested",
          "Native execution checks were not requested.",
          "Set runChecks=true for read-only probes.",
        );
        continue;
      }
      if (target === "client" && !selected?.ready) {
        add(
          id,
          "unavailable",
          "No ready selected client.",
          "Resolve client_readiness first.",
        );
        continue;
      }
      try {
        const result = await game.execute(
          target,
          {
            language,
            wait: true,
            timeoutMs: 1500,
            code:
              language === "javascript"
                ? "return await ctx.game(() => [GetCurrentResourceName(), GetGameTimer()]);"
                : "return GetCurrentResourceName(), GetGameTimer()",
          },
          target === "client" ? selected?.playerId : undefined,
        );
        const values = result.outcome?.values;
        const nativeValues = language === "javascript" ? values?.[0] : values;
        const valid =
          Array.isArray(nativeValues) &&
          nativeValues[0] === game.resource &&
          typeof nativeValues[1] === "number" &&
          Number.isFinite(nativeValues[1]);
        const passed =
          result.state === "completed" && result.outcome?.ok && valid;
        add(
          id,
          passed ? "pass" : "fail",
          passed
            ? "Read-only resource name and timer natives returned expected values."
            : (result.outcome?.error ??
                `Probe ${result.state}; unexpected native response.`),
          passed
            ? null
            : "Inspect scoped execution logs and verify the Lua/JS runtime is loaded.",
          { executionId: result.id, state: result.state },
        );
      } catch (error) {
        add(
          id,
          "unavailable",
          errorMessage(error),
          "Check execution limits, runtime readiness and ACE.",
        );
      }
    }
  }
  let bridgeHealthy = false;
  if (!selected?.ready || !nui.evaluate) {
    add(
      "cdp_bridge_capture",
      "unavailable",
      "No selected ready client or no NUI diagnostics adapter.",
      "Select a local client and enable the CDP diagnostics adapter.",
    );
  } else {
    try {
      await game.assertLocalNui(selected.playerId);
      const details = bridgeSchema.parse(
        await nui.evaluate(
          game.resource,
          `const ownValue = (object, key) => object && (typeof object === "object" || typeof object === "function")
            ? Object.getOwnPropertyDescriptor(object, key)?.value : undefined;
          const build = ownValue(globalThis, "doluMcpBuild");
          const bridge = ownValue(globalThis, "doluMcpCapture");
          const version = ownValue(bridge, "version");
          return {
            buildId: typeof build === "string" ? build : null,
            version: typeof version === "number" ? version : null,
            captureAvailable: typeof ownValue(bridge, "capture") === "function"
          };`,
        ),
      );
      bridgeHealthy =
        details.buildId === game.buildId &&
        details.version === CAPTURE_VERSION &&
        details.captureAvailable;
      add(
        "cdp",
        "pass",
        "Local CDP frame and JavaScript context are reachable.",
      );
      add(
        "cdp_bridge_capture",
        bridgeHealthy
          ? "pass"
          : details.buildId !== null && details.buildId !== game.buildId
            ? "fail"
            : "unavailable",
        bridgeHealthy
          ? "Matching public NUI bridge and capture API available; rendering has not been tested."
          : "NUI build/version mismatch or capture API missing.",
        bridgeHealthy ? null : "Rebuild, restart dolu_fivem_mcp and refresh NUI.",
        details,
      );
    } catch (error) {
      add(
        "cdp_bridge_capture",
        "unavailable",
        errorMessage(error),
        "Enable local NUI DevTools and verify CEF ownership and bridge readiness.",
      );
    }
  }
  if (!options.capture) {
    add(
      "capture",
      "not_tested",
      "No image was captured.",
      "Set capture=true explicitly to test capture.",
    );
  } else if (!selected?.nuiReady || !bridgeHealthy || !nui.gameScreenshot) {
    add(
      "capture",
      "unavailable",
      "No ready NUI or capture adapter.",
      "Resolve NUI readiness and capture availability.",
    );
  } else {
    try {
      await game.assertLocalNui(selected.playerId);
      await nui.gameScreenshot(game.resource, {
        includeNui: false,
        maxWidth: 320,
        format: "jpeg",
        quality: 0.5,
      });
      add(
        "capture",
        "pass",
        "Explicitly requested capture completed; image not retained in diagnostics.",
      );
    } catch (error) {
      add(
        "capture",
        "fail",
        errorMessage(error),
        "Inspect the game capture bridge and graphics context.",
      );
    }
  }
  return {
    buildId: game.buildId,
    runtime,
    players,
    selectedPlayerId: selected?.playerId ?? null,
    checks,
  };
}
