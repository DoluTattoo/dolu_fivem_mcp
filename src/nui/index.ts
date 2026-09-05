import { CAPTURE_VERSION, type GameCaptureBridge } from "../shared/capture";
import { BUILD_ID } from "../shared/build";
import { captureGame } from "./capture";

declare global {
  var doluMcpCapture: GameCaptureBridge & { buildId: string };
  var doluMcpBuild: string;
  interface Window {
    doluMcpCapture: GameCaptureBridge & { buildId: string };
  }
}

globalThis.doluMcpCapture = {
  version: CAPTURE_VERSION,
  buildId: BUILD_ID,
  capture: captureGame,
};
globalThis.doluMcpBuild = BUILD_ID;

declare function GetParentResourceName(): string;

async function ready(): Promise<void> {
  const response = await fetch(`https://${GetParentResourceName()}/mcp_ready`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ buildId: BUILD_ID }),
  });
  if (!response.ok)
    throw new Error(`NUI handshake failed: HTTP ${response.status}`);
}
// Retrying readiness is safe: it has no game side effects.
void ready().catch((error: unknown) => {
  console.error("[dolu_fivem_mcp]", error);
  setTimeout(() => {
    void ready().catch((retryError: unknown) =>
      console.error("[dolu_fivem_mcp]", retryError),
    );
  }, 2000);
});
