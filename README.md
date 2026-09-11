<div align="center">

# dolu_fivem_mcp

**Build, inspect and test FiveM resources without leaving your coding assistant.**

A standalone MCP server connecting your assistant to the game, the server and NUI.

[![Checks](https://github.com/DoluTattoo/dolu_fivem_mcp/actions/workflows/check.yml/badge.svg)](https://github.com/DoluTattoo/dolu_fivem_mcp/actions/workflows/check.yml)
[![Release](https://img.shields.io/github/v/release/DoluTattoo/dolu_fivem_mcp?color=2563eb)](https://github.com/DoluTattoo/dolu_fivem_mcp/releases/latest)
[![License: MIT](https://img.shields.io/badge/license-MIT-22c55e)](LICENSE)

[Quick start](#quick-start) &nbsp;&middot;&nbsp; [Features](#features) &nbsp;&middot;&nbsp; [Tool reference](#tool-reference) &nbsp;&middot;&nbsp; [Download](https://github.com/DoluTattoo/dolu_fivem_mcp/releases/latest)

</div>

---

Go beyond writing code. Let your assistant run a snippet, inspect the result, interact with a live interface and capture what actually appears in-game. **35 tools** cover the full development loop, from resource management to repeatable tests with screenshot evidence.

## Features

| Capability | What you can do |
| --- | --- |
| **JavaScript + Lua** | Execute on the server or an authorized client. Read return values, stream logs and cancel cooperative work. |
| **Game screenshots** | Capture PNG or JPEG images, with or without NUI, directly in your assistant. No external screenshot service. |
| **NUI automation** | Inspect live DOM, execute JavaScript, click, type, select, scroll and wait for UI changes across resource frames. |
| **UI debugging** | Observe console messages, exceptions and optional network metadata, attributed to the selected NUI frame. |
| **Resource control** | Discover, start, stop and restart resources. Run server commands and wait for state changes. |
| **World inspection** | Read resource metadata, inspect players and find nearby peds, vehicles and objects. |
| **Repeatable testing** | Run scenarios with assertions, declared cleanup and screenshots retained as evidence. |
| **Diagnostics** | Check permissions, runtime readiness, matching builds and CEF connectivity before testing. |

**Standalone by design.** No framework, txAdmin, `screenshot-basic`, Yarn or webpack resource required. Prebuilt releases are ready to install. Uses the official MCP SDK and Streamable HTTP.

> **Local development only.** This is not a sandbox: an assistant can execute arbitrary code. There is no HTTP authentication. The server listens only on `127.0.0.1` and checks Host/Origin headers, but any local process that can reach it can use the tools. Never expose it through a proxy or tunnel, or install it on a public server.

## Requirements

- A recent local FiveM server.
- An AI assistant that supports **MCP Streamable HTTP**.

For client tools, NUI and screenshots, connect your FiveM client to the local server. NUI and screenshots also need the client on the same PC, connected through `127.0.0.1`, with CEF DevTools accessible.

## Quick start

### 1. Install

Place this resource in your server's resources directory, keeping the folder name `dolu_fivem_mcp`.

**Using a prebuilt runtime archive?** Download the `.tgz` asset from [Releases](https://github.com/DoluTattoo/dolu_fivem_mcp/releases), extract its `package` folder as `dolu_fivem_mcp` and skip the build commands below. GitHub's automatic "Source code" archives are not prebuilt.

**Building from source?** Install Node.js 22 or newer and npm, then run these commands from the resource folder:

```powershell
npm ci
npm run build
```

The build creates the runtime bundles and the `.yarn.installed` marker. Dependencies are bundled, so FXServer does not need to install them at startup.

### 2. Grant permissions and start the resource

Add these lines to your server configuration:

```cfg
add_ace resource.dolu_fivem_mcp command allow
add_ace group.admin dolu_fivem_mcp.use allow

ensure dolu_fivem_mcp
```

These are two separate permissions:

- `resource.dolu_fivem_mcp command` lets the resource run server commands.
- `dolu_fivem_mcp.use` allows a player to be targeted by client tools.

The player must actually belong to `group.admin`, or receive `dolu_fivem_mcp.use` through another existing principal. Being a txAdmin or framework administrator does **not** automatically grant it. See [config.example.cfg](config.example.cfg) for an example of a direct player grant.

### 3. Connect your assistant

| Setting | Value |
| --- | --- |
| MCP endpoint | `http://127.0.0.1:3210/mcp` |
| Transport | Streamable HTTP |
| Authentication | None |
| HTTP health check | `http://127.0.0.1:3210/health` |

For hosts that use a `mcpServers` configuration:

```json
{
  "mcpServers": {
    "dolu_fivem_mcp": {
      "type": "http",
      "url": "http://127.0.0.1:3210/mcp"
    }
  }
}
```

The exact configuration format depends on your assistant. Use its HTTP transport, not stdio or the older HTTP+SSE transport. An assistant running in a VM, WSL or on another machine does not automatically share this loopback address.

### 4. Check the connection

Ask your assistant:

> Check the FiveM MCP status, list the players, and run read-only diagnostics on the ready client.

The relevant tools are `status`, `list_players` and `diagnose`. Pass `runChecks: true` to `diagnose` to test JavaScript and Lua native calls; `capture: true` also tests a small screenshot.

Always discover the current player ID instead of assuming it is `1`. Most client tools can select the player automatically when exactly one authorized client is ready.

## Common tasks

These examples are **tool arguments**, not full HTTP requests. Your assistant normally constructs the calls for you.

### Run code

Use `execute_server` for a read-only JavaScript check:

```json
{
  "language": "javascript",
  "code": "return { resource: ctx.resource, state: GetResourceState(ctx.resource) };"
}
```

Use `execute_client` to read the player's position in Lua:

```json
{
  "language": "lua",
  "code": "return GetEntityCoords(PlayerPedId())",
  "timeoutMs": 5000
}
```

Add `playerId` when selecting a specific client. For a long-running snippet, set `wait: false`, keep the returned ID, then use `get_execution` or `cancel_execution`. Logs are available while the snippet is running.

**Server/client snippets run inside `dolu_fivem_mcp`, not inside another resource's private variables.** Use natives, exports and events to interact with other resources. Use your editor to change source files.

### Work with a NUI page

NUI is FiveM's browser-based interface layer. These tools use its local CEF DevTools connection.

1. Call `list_nui_frames` to find the resource and frame.
2. Call `nui_snapshot` to inspect its elements.
3. Use `nui_interact` to click, fill, select, press a key, hover or scroll.
4. Use `nui_wait_for` to wait for the expected element state or text.

For example, to fill an input:

```json
{
  "resource": "my_inventory",
  "frameId": "FRAME_ID_FROM_LIST_NUI_FRAMES",
  "interaction": {
    "action": "fill",
    "selector": "#search",
    "text": "water"
  }
}
```

Provide `frameId` when a resource has multiple frames. Snapshot references can replace selectors, but may become stale after a page change or restart; take a new snapshot rather than blindly retrying an action.

Hidden, disabled, obscured or ambiguous targets are rejected. The target UI may need to acquire its own focus for CDP input. The invisible `dolu_fivem_mcp` bridge never takes keyboard or mouse focus.

To investigate UI problems, use `start_nui_observation`, read events with `read_nui_observation`, then call `stop_nui_observation`. Console and exception capture are enabled by default; network metadata requires `network: true`. Observations last at most 60 seconds and retain at most 500 events.

### Take a screenshot

Call `game_screenshot`:

```json
{
  "includeNui": true,
  "maxWidth": 1280,
  "format": "jpeg",
  "quality": 0.85
}
```

| Tool / option | Captures |
| --- | --- |
| `game_screenshot`, `includeNui: false` (default) | Game scene and GTA HUD, without NUI |
| `game_screenshot`, `includeNui: true` | Game scene with the selected main CEF target composited over it |
| `nui_screenshot` | The selected Chromium target only, not the GTA scene or an isolated frame |

Both game screenshot modes require local CEF DevTools. Images are returned directly to the assistant; the resource does not automatically save or upload them.

Game and NUI captures are taken sequentially, so fast animations may not line up perfectly. Other Chromium targets and OS overlays are not guaranteed to appear. If an image exceeds the size limit, reduce `maxWidth` or use JPEG.

## Tool reference

The server exposes 35 tools. Your assistant can discover their full argument schemas with `tools/list`.

<details>
<summary>Show all tools by purpose</summary>

| Purpose | Tools |
| --- | --- |
| Readiness | `status`, `diagnose`, `list_players` |
| Resources | `list_resources`, `inspect_resource`, `manage_resource`, `wait_for_resource`, `execute_command` |
| Code execution | `execute_server`, `execute_client`, `list_executions`, `get_execution`, `cancel_execution` |
| Logs | `read_logs`, `wait_for_log` |
| Players and entities | `inspect_player`, `find_entities`, `inspect_entity` |
| NUI inspection and input | `list_nui_frames`, `execute_nui`, `nui_snapshot`, `nui_click`, `nui_interact`, `nui_wait_for` |
| NUI observations | `start_nui_observation`, `read_nui_observation`, `stop_nui_observation`, `list_nui_observations` |
| Screenshots | `game_screenshot`, `nui_screenshot` |
| Scenarios and evidence | `run_scenario`, `list_scenarios`, `get_scenario`, `get_evidence`, `delete_scenario` |

The MCP resource `fivem://dolu_fivem_mcp/execution-guide` provides execution guidance. The `test_resource` prompt suggests a development workflow.

</details>

<details>
<summary>Advanced usage notes</summary>

**Execution:** JavaScript snippets are async function bodies with `return` and `await`; `require` is server-only. Lua supports multiple return values. Use `ctx.sleep(ms)` (`await` in JavaScript), `ctx.alive()` and `ctx.onCleanup(...)` for cooperative work. Cleanup callbacks must be short and synchronous. After Node I/O, run server natives through `await ctx.game(() => nativeCall())`.

**Results and logs:** Structured results are under `structuredContent.result`; completed executions include `outcome.values`, logs and timing. Special values such as Lua `nil` have explicit serialized representations. Use `executionId` to filter logs and pass `nextCursor` back as `after` to read new entries. Client logs cover snippets, not the entire F8 console.

**Efficient agent calls:** Reuse `status` until a restart, disconnect or readiness error; it already includes players. Screenshots and snippets do not need a full resource listing or routine diagnostics. For resource discovery, use `inspect_resource` when the name is known, or filter `list_resources` with `name` (case-insensitive substring) and/or `state` (for example, `{"name":"dolu","state":"started"}`). Without filters, the full inventory is still returned. The shared execution contract is in server instructions and the execution guide.

**Compact executions:** Pass `compact: true` to `execute_server`, `execute_client`, `get_execution` or `list_executions` when captured logs are not needed. Values, errors, state and cancellation notes are preserved; logs are omitted and `logCount` is returned. Logs are not deleted: use `get_execution` without `compact` to retrieve the full record. The default remains the original full response. Compact mode can hide log-only warnings, so request full logs when investigating behavior.

**Waiting without polling:** After starting work with `wait: false`, call `get_execution` with `waitMs: 10000` and `compact: true`. The call returns immediately on completion, failure, cancellation or disconnect, or returns the current state when the wait expires. A `running` response is not a failure and must not cause the script to be executed again. `waitMs` defaults to `0` (immediate read), supports up to `60000`, and does not extend the execution timeout. Aborting this read only stops waiting; use `cancel_execution` to cancel the actual work.

**Entity inspection:** Choose `target: "server"` or `"client"`. Handles are temporary and local to that runtime; they are not network IDs. Server entity searches require OneSync and an explicit `position`, without `playerId`. Searches are limited to 500 metres and 100 returned entities. Resource inspection lists declared exports, not all dynamic exports.

**Scenarios:** `run_scenario` runs ordered tool steps with `equals`, `contains` or `exists` assertions and optional cleanup steps. Set a resource and, when needed, a player. The first failure skips subsequent main steps; declared cleanup is still attempted. Limits: one scenario at a time, 12 main steps, 4 cleanup steps, 60 seconds for the main work and a separate 10-second cleanup budget. Reports and image evidence expire after 15 minutes or a resource restart.

**Direct HTTP:** Send JSON-RPC POST requests to `/mcp` with `Content-Type: application/json` and `Accept: application/json, text/event-stream`. The transport is stateless; no session token or Authorization header is needed.

**Targeted NUI snapshots:** `nui_snapshot` accepts `selector` (exactly one subtree), `maxElements` (1-150, default 150), and `includeText` (default true). Use `includeText: false` when accessible labels suffice; element names and interactive refs remain available. Missing or ambiguous selectors fail explicitly. `truncated` indicates an incomplete scan. Defaults retain the document-wide snapshot and private input values remain excluded.

**Compact readiness:** Use `status` with `compact: true` to omit repeated build hashes and static guidance for healthy players. The server build ID and complete details for unhealthy clients remain present. Omit `compact` for the original full response.

**Tool errors:** Handler failures return a short `error`, a stable category `code`, an `errorId`, and a `details` tool call to retrieve the bounded stack from audit logs. Audit history is bounded and lost on restart; retrieve it promptly when needed. SDK input-validation errors retain the SDK format. Errors from executed snippets retain their original stack in `outcome.error`. An error never implies that a mutation can safely be retried.

**NUI connection reuse:** Successful short CDP operations may retain up to four idle sockets for two seconds. Connections are leased exclusively with a fresh operation deadline; failed or aborted connections are closed, and shutdown closes all retained sockets. Frame discovery still runs before each action, so no resource/frame ownership cache is trusted across calls. Actions are never automatically retried. Long-lived observations retain their separate lifecycle.

</details>

## Configuration and troubleshooting

All settings are optional. Defaults are shown below; see [config.example.cfg](config.example.cfg).

| Convar | Default | Purpose |
| --- | --- | --- |
| `dolu_fivem_mcp_port` | `3210` | Local MCP HTTP port |
| `dolu_fivem_mcp_ace` | `dolu_fivem_mcp.use` | Required player permission |
| `dolu_fivem_mcp_cdp_port` | `13172` | Local CEF DevTools port |
| `dolu_fivem_mcp_cdp_player` | `0` | Automatic selection; otherwise the server ID of the local CEF player |
| `dolu_fivem_mcp_max_active` | `8` | Maximum active JS/Lua executions |

After changing configuration or rebuilding, run `restart dolu_fivem_mcp` **from the FXServer console**, outside an active MCP call. Watch mode only rebuilds files; it does not restart the resource.

| Problem | What to check |
| --- | --- |
| Cannot connect to MCP | Resource started, correct port, assistant using the same loopback interface |
| Player is not authorized | The player's actual ACE principals, not just their framework or txAdmin role |
| Client is not ready / build mismatch | `status` and `diagnose`; restart the resource so server, client and NUI load matching builds |
| NUI or screenshots are unavailable | Client must run on the FXServer machine and connect through loopback or one of that machine's own interface addresses; CEF DevTools must be accessible. `nuiReady` alone does not prove CDP works |
| Multiple players or frames match | Specify `playerId` / `frameId`; configure `dolu_fivem_mcp_cdp_player` for ambiguous local CEF ownership |
| Screenshot is black | Game rendering may be paused, minimized or genuinely black |

## Important limits

- **Timeout and cancellation are cooperative.** They do not guarantee that arbitrary code stops or that its effects are undone. Do not automatically retry actions with side effects.
- Execution code, output, logs and histories are bounded. Snippets have a maximum 60-second timeout and 100 captured log lines.
- The management tools refuse to stop or restart `dolu_fivem_mcp` itself. Arbitrary code is still powerful enough to disrupt the server: this is not a security sandbox.
- NUI snapshots, logs and screenshots may contain sensitive information. Network observations omit bodies, headers and cookies, and strip credentials, queries and fragments from URLs; this is not universal secret filtering.
- NUI control is local-only. Some transformed, zoomed or separate-target iframe layouts are unsupported. Behaviour can vary with FiveM artifacts, client state and GPU.

## Development

Built with TypeScript, the official MCP SDK v2, Zod and esbuild, with small Lua executors. The manifest uses FiveM's Node.js 22 runtime. Current FiveM artifacts use Lua 5.4 by default; [`lua54 'yes'` is deprecated](https://docs.fivem.net/docs/scripting-reference/resource-manifest/#lua54). Experimental OAL is intentionally disabled to preserve native-call compatibility.

| Command | Purpose |
| --- | --- |
| `npm run check` | Typecheck, lint, tests and build |
| `npm run build` | Rebuild the runtime bundles |
| `npm run watch` | Rebuild when source files change |
| `npm run test:live` | Test against a running server and one authorized, ready local client |
| `npm run test:soak` | Run live checks with 20 game captures, alternating with/without NUI |
| `npm run package:resource` | Validate and create a runtime archive |

Live tests include deliberate snippet errors and timeouts. To save a report, use `npm run test:live -- --output C:\temp\dolu-fivem-mcp-report.json` (the parent directory must exist).

<details>
<summary>Resource lifecycle tests, SDK compatibility and distribution</summary>

**Disposable resource:** Copy [tests/fixtures/dolu_fivem_mcp_test](tests/fixtures/dolu_fivem_mcp_test) beside `dolu_fivem_mcp`, run `refresh` in the FXServer console, and leave the fixture stopped. Then run:

```powershell
npm run test:live -- --fixture
```

Resource start/restart/stop actions target only the fixture. The test temporarily gives it input focus, releases it during cleanup, and stops it. It refuses to take over an already running fixture. You can remove the copied folder after the test; the script does not remove it for you.

**Official SDK client check:**

```powershell
npm exec --yes --package=@modelcontextprotocol/client@2.0.0 -- node scripts\client-check.cjs
```

This uses npm's cache without adding a runtime dependency. It tests the live connection, tools, structured results, errors, images, MCP resources and prompts. It does not configure applications such as VS Code or Claude Desktop.

**Runtime archive:** Extract the archive's `package` directory as `dolu_fivem_mcp`. It contains the bundles, Lua executor, technical page, manifest, `.yarn.installed` and documentation. It is already compiled; build and test commands belong in a source checkout, not in this archive.

**Cfx builders:** Yarn checks whether `.yarn.installed` is at least as recent as `package.json`. Every successful build refreshes this generated marker, and the runtime archive includes it. Keep the marker when deploying; rerun the build after changing `package.json` or if copying files makes it newer than the marker. The Cfx webpack builder requires `webpack_config` metadata, which this resource does not declare.

**CI and releases:** [Check](.github/workflows/check.yml) runs tests and builds on Windows and Linux with Node.js 22. [Release](.github/workflows/release.yml) validates version tags and publishes the prebuilt runtime archive. To release, update the versions in `package.json`, `package-lock.json`, `fxmanifest.lua` and `src/shared/protocol.ts`, run `npm run check`, then push a matching `vX.Y.Z` tag.

To retry publication, run the Release workflow manually from `main` with the existing version tag. Existing archives and release notes are preserved; a missing archive is uploaded without recreating the release.

**Validation scope:** Automated tests cover simulated FiveM/CDP behaviour, and the live scripts exercise the running game. Player disconnections, ACE changes, minimization, resolution changes and GPU failures require separate, deliberate testing. Passing these checks is not a guarantee for every client, host or hardware configuration.

</details>

## License

[MIT](LICENSE), copyright Dolu. Bundled dependencies retain their own licenses, included in [THIRD_PARTY_NOTICES.txt](THIRD_PARTY_NOTICES.txt).
