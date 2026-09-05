/* global exports, GetCurrentResourceName, console */
const startedAt = Date.now();
exports("inspectFixture", () => ({
  resource: GetCurrentResourceName(),
  startedAt,
  ready: true,
}));
console.log("[dolu_fivem_mcp_test] server ready");
