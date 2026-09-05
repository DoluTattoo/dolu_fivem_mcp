import { readConfig } from "./config";
import { GameService } from "./game";
import { createHttpEndpoint } from "./http";
import { NuiDebugger } from "./nui";
import { createTools } from "./tools";
import { errorMessage } from "../shared/protocol";
import { ScenarioRunner } from "./scenarios";

const resource = GetCurrentResourceName();
const config = readConfig(GetConvar);
const game = new GameService(resource, config);
const nui = new NuiDebugger({
  port: config.cdpPort,
  timeoutMs: 10_000,
  maxResultBytes: 2_097_152,
});
const scenarios = new ScenarioRunner();
const endpoint = createHttpEndpoint({
  port: config.port,
  createMcp: () => createTools(game, nui, scenarios),
  log: (message) => game.audit(message, true),
});
let stopped = false;
on("onResourceStop", (name: string) => {
  if (name !== resource || stopped) return;
  stopped = true;
  scenarios.close();
  game.close();
  nui.close();
  void endpoint
    .close()
    .catch((error: unknown) =>
      console.error(`[dolu_fivem_mcp] Shutdown failed: ${errorMessage(error)}`),
    );
});
void endpoint.listen().then(
  () => {
    console.info(
      `[dolu_fivem_mcp] MCP ready: http://127.0.0.1:${config.port}/mcp. Local development only.`,
    );
  },
  (error: unknown) => {
    scenarios.close();
    game.close();
    nui.close();
    console.error(`[dolu_fivem_mcp] HTTP startup failed: ${errorMessage(error)}`);
  },
);
