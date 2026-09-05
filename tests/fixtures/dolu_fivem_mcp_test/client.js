/* global RegisterNuiCallbackType, on, GetCurrentResourceName, SetNuiFocus, exports, console */
RegisterNuiCallbackType("fixture_ping");
on("__cfx_nui:fixture_ping", (_body, callback) => {
  callback({ ok: true, resource: GetCurrentResourceName() });
});
RegisterNuiCallbackType("fixture_focus");
on("__cfx_nui:fixture_focus", (body, callback) => {
  if (typeof body?.enabled !== "boolean") {
    callback({ ok: false, error: "Expected boolean enabled" });
    return;
  }
  SetNuiFocus(body.enabled, body.enabled);
  callback({ ok: true });
});
on("onClientResourceStop", (resource) => {
  if (resource === GetCurrentResourceName()) SetNuiFocus(false, false);
});
exports("inspectFixture", () => ({
  resource: GetCurrentResourceName(),
  ready: true,
}));
console.log("[dolu_fivem_mcp_test] client ready");
