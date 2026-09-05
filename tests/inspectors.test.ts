import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FiveMInspector,
  findEntitiesSchema,
  inspectEntitySchema,
  type InspectorGame,
} from "../src/server/inspectors";
import type { GameService } from "../src/server/game";
import { JavascriptExecutor } from "../src/shared/executor";
import { encodeOutcome, outcomeSchema } from "../src/shared/protocol";
import type { Job } from "../src/server/jobs";

describe("bounded read-only FiveM inspectors", () => {
  let inspector: FiveMInspector;
  let game: InspectorGame;
  let players: Awaited<ReturnType<InspectorGame["players"]>>;
  let executor: JavascriptExecutor;
  const zero = { x: 0, y: 0, z: 0 };
  const entities = new Map<
    number,
    { type: number; coords: number[]; model: number }
  >();
  const execute = vi.fn<GameService["execute"]>();
  beforeEach(() => {
    players = [{ playerId: 7, authorized: true, ready: true }];
    entities.clear();
    entities.set(10, { type: 1, coords: [0, 0, 0], model: 123 });
    entities.set(20, { type: 2, coords: [3, 4, 0], model: 456 });
    entities.set(21, { type: 2, coords: [-3, -4, 0], model: 456 });
    entities.set(30, { type: 3, coords: [200, 0, 0], model: 789 });
    vi.stubGlobal("DoesEntityExist", (id: number) => entities.has(id));
    vi.stubGlobal("GetEntityType", (id: number) => entities.get(id)?.type ?? 0);
    vi.stubGlobal("GetEntityModel", (id: number) => entities.get(id)?.model);
    vi.stubGlobal("GetEntityCoords", (id: number) => entities.get(id)?.coords);
    vi.stubGlobal("GetEntityHeading", () => 90);
    vi.stubGlobal("GetEntityHealth", () => 100);
    vi.stubGlobal("NetworkGetEntityIsNetworked", () => true);
    vi.stubGlobal("NetworkGetNetworkIdFromEntity", (id: number) => id + 1000);
    vi.stubGlobal("NetworkGetEntityFromNetworkId", (id: number) => id - 1000);
    vi.stubGlobal("NetworkGetEntityOwner", () => 7);
    vi.stubGlobal("PlayerPedId", () => 10);
    vi.stubGlobal("GetVehiclePedIsIn", () => 20);
    vi.stubGlobal("GetPlayerName", () => "Tester");
    vi.stubGlobal("GetPlayerRoutingBucket", () => 4);
    vi.stubGlobal("GetHashKey", (model: string) => (model === "car" ? 456 : 0));
    vi.stubGlobal("GetAllPeds", () => [10]);
    vi.stubGlobal("GetAllVehicles", () => [21, 20]);
    vi.stubGlobal("GetAllObjects", () => [30]);
    vi.stubGlobal("GetGamePool", (kind: string) =>
      kind === "CPed" ? [10] : kind === "CVehicle" ? [21, 20] : [30],
    );
    executor = new JavascriptExecutor({
      resource: "dolu_fivem_mcp",
      exports: {},
      print: () => {},
    });
    execute.mockReset();
    execute.mockImplementation(async (target, input, playerId) => {
      const outcome = await executor.execute({
        id: "inspector-test",
        ...input,
      });
      const job: Job = {
        id: "inspector-test",
        target,
        language: input.language,
        playerId,
        state: outcome.ok ? "completed" : "failed",
        startedAt: new Date().toISOString(),
        logs: [],
        outcome: outcomeSchema.parse(JSON.parse(encodeOutcome(outcome))),
      };
      return job;
    });
    game = { players: async () => players, execute };
    inspector = new FiveMInspector(game);
  });
  afterEach(() => {
    executor.close();
    vi.unstubAllGlobals();
  });

  it("reads typed server entities on the game thread without client execution", async () => {
    let gameTick = false;
    const immediate = globalThis.setImmediate;
    vi.stubGlobal("setImmediate", (callback: () => void) =>
      immediate(() => {
        gameTick = true;
        callback();
        gameTick = false;
      }),
    );
    vi.stubGlobal("GetEntityCoords", () => {
      expect(gameTick).toBe(true);
      return [3, 4, 0];
    });
    expect(
      await inspector.inspectEntity({ target: "server", handle: 20 }),
    ).toMatchObject({
      runtime: "server",
      playerId: null,
      exists: true,
      handle: 20,
      type: "vehicle",
      model: 456,
      networkId: 1020,
      owner: 7,
      ownerKind: "server-player-id",
      position: { x: 3, y: 4, z: 0 },
      health: 100,
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("routes serialized client reads through checked execute and resolves network IDs locally", async () => {
    const value = await inspector.inspectEntity({
      target: "client",
      playerId: 7,
      networkId: 1020,
    });
    expect(value).toMatchObject({
      runtime: "client",
      playerId: 7,
      handle: 20,
      ownerKind: "client-player-index",
    });
    expect(value.handleScope).toContain("player 7");
    expect(execute).toHaveBeenCalledWith(
      "client",
      expect.objectContaining({
        language: "javascript",
        wait: true,
        timeoutMs: 10_000,
        code: expect.stringContaining('"networkId":1020'),
      }),
      7,
    );
  });

  it.each([true, 1])(
    "accepts FiveM entity existence result %s in both runtimes",
    async (value) => {
      vi.stubGlobal("DoesEntityExist", (handle: number) =>
        entities.has(handle) ? value : 0,
      );
      expect(
        (await inspector.inspectEntity({ target: "server", handle: 20 }))
          .exists,
      ).toBe(true);
      expect(
        (await inspector.inspectEntity({ target: "client", handle: 20 }))
          .exists,
      ).toBe(true);
      expect(
        (await inspector.findEntities({ target: "server", position: zero }))
          .matched,
      ).toBe(3);
    },
  );

  it.each([false, 0])(
    "rejects absent entities for FiveM existence result %s",
    async (value) => {
      vi.stubGlobal("DoesEntityExist", () => value);
      await expect(
        inspector.inspectEntity({ target: "server", handle: 20 }),
      ).rejects.toThrow("Invalid entity:");
      await expect(
        inspector.inspectEntity({ target: "client", handle: 20 }),
      ).rejects.toThrow("Invalid entity:");
    },
  );

  it.each([true, false, 1, 0])(
    "normalizes FiveM networked result %s",
    async (value) => {
      vi.stubGlobal("NetworkGetEntityIsNetworked", () => value);
      const result = await inspector.inspectEntity({
        target: "client",
        handle: 20,
      });
      expect(result.networkId).toBe(
        value === true || value === 1 ? 1020 : null,
      );
      expect(result.unavailable).toEqual([]);
    },
  );

  it.each([2, -1, "true", "1", null, undefined])(
    "does not coerce invalid boolean native value %s",
    async (value) => {
      vi.stubGlobal("DoesEntityExist", () => value);
      await expect(
        inspector.inspectEntity({ target: "server", handle: 20 }),
      ).rejects.toThrow("DoesEntityExist expected boolean or 0/1");
      vi.stubGlobal("DoesEntityExist", () => 1);
      vi.stubGlobal("NetworkGetEntityIsNetworked", () => value);
      const result = await inspector.inspectEntity({
        target: "client",
        handle: 20,
      });
      expect(result.networkId).toBeNull();
      expect(result.unavailableReasons.NetworkGetEntityIsNetworked).toContain(
        "expected boolean or 0/1",
      );
    },
  );

  it("preserves native failure reasons in errors and optional-field diagnostics", async () => {
    vi.stubGlobal("GetEntityCoords", () => {
      throw new Error("entity routing scope was lost");
    });
    await expect(
      inspector.inspectEntity({ target: "server", handle: 20 }),
    ).rejects.toThrow("GetEntityCoords failed: entity routing scope was lost");
    await expect(
      inspector.inspectEntity({ target: "client", handle: 20 }),
    ).rejects.toThrow("GetEntityCoords failed: entity routing scope was lost");
    vi.stubGlobal("GetEntityCoords", () => [0, 0, 0]);
    vi.stubGlobal("GetEntityHeading", () => {
      throw new Error("heading unsupported for this entity");
    });
    vi.stubGlobal("NetworkGetEntityIsNetworked", () => {
      throw new Error("network manager unavailable");
    });
    const result = await inspector.inspectEntity({
      target: "client",
      handle: 20,
    });
    expect(result.unavailableReasons.GetEntityHeading).toContain(
      "heading unsupported for this entity",
    );
    expect(result.unavailableReasons.NetworkGetEntityIsNetworked).toContain(
      "network manager unavailable",
    );
    vi.stubGlobal("GetPlayerRoutingBucket", () => {
      throw new Error("routing buckets disabled");
    });
    expect(
      (await inspector.inspectPlayer(7)).unavailableReasons
        .GetPlayerRoutingBucket,
    ).toContain("routing buckets disabled");
  });

  it("validates numeric native results before coercing handles and model hashes", async () => {
    vi.stubGlobal("GetEntityModel", () => "456");
    await expect(
      inspector.inspectEntity({ target: "server", handle: 20 }),
    ).rejects.toThrow("GetEntityModel expected a finite number");
    vi.stubGlobal("GetEntityModel", () => 456.5);
    await expect(
      inspector.findEntities({ target: "server", position: zero, model: 456 }),
    ).rejects.toThrow("GetEntityModel expected a safe integer");
    vi.stubGlobal("GetEntityModel", () => 456);
    vi.stubGlobal("NetworkGetNetworkIdFromEntity", () => 1020.5);
    expect(
      (await inspector.inspectEntity({ target: "server", handle: 20 }))
        .unavailableReasons.NetworkGetNetworkIdFromEntity,
    ).toContain("expected a safe integer");
    vi.stubGlobal("GetEntityCoords", () => Array(3));
    await expect(
      inspector.inspectEntity({ target: "server", handle: 20 }),
    ).rejects.toThrow("GetEntityCoords expected a finite");
  });

  it("selects a sole ready authorized client but rejects ambiguity", async () => {
    expect(
      (await inspector.inspectEntity({ target: "client", handle: 10 }))
        .playerId,
    ).toBe(7);
    players.push({ ...players[0]!, playerId: 8 });
    await expect(
      inspector.inspectEntity({ target: "client", handle: 10 }),
    ).rejects.toThrow("Specify playerId");
  });

  it.each([
    [
      "disconnected",
      () => {
        players = [];
      },
      "disconnected",
    ],
    [
      "unauthorized",
      () => {
        players[0]!.authorized = false;
      },
      "Unauthorized",
    ],
    [
      "unready",
      () => {
        players[0]!.ready = false;
      },
      "not ready",
    ],
  ])("refuses %s players before execution", async (_name, change, message) => {
    change();
    await expect(inspector.inspectPlayer(7)).rejects.toThrow(message);
    expect(execute).not.toHaveBeenCalled();
  });

  it("propagates execute admission and terminal errors", async () => {
    execute.mockRejectedValueOnce(new Error("Target lost its MCP ACE"));
    await expect(
      inspector.inspectEntity({ target: "client", playerId: 7, handle: 10 }),
    ).rejects.toThrow("MCP ACE");
    execute.mockResolvedValueOnce({
      id: "failed",
      target: "client",
      playerId: 7,
      language: "javascript",
      state: "disconnected",
      startedAt: "",
      logs: [],
    });
    await expect(inspector.inspectPlayer(7)).rejects.toThrow("disconnected");
  });

  it("rejects forged runtime responses and malformed serialized values", async () => {
    execute.mockResolvedValueOnce({
      id: "wrong",
      target: "client",
      playerId: 8,
      language: "javascript",
      state: "completed",
      startedAt: "",
      logs: [],
      outcome: { ok: true, values: [], logs: [], durationMs: 0 },
    });
    await expect(inspector.inspectPlayer(7)).rejects.toThrow("does not match");
    execute.mockResolvedValueOnce({
      id: "wrong",
      target: "client",
      playerId: 7,
      language: "javascript",
      state: "completed",
      startedAt: "",
      logs: [],
      outcome: {
        ok: true,
        values: [['{"runtime":"server","playerId":7}']],
        logs: [],
        durationMs: 0,
      },
    });
    await expect(inspector.inspectPlayer(7)).rejects.toThrow(
      "incorrect runtime scope",
    );
  });

  it("reports client player ped/vehicle with separate optional server routing bucket", async () => {
    expect(await inspector.inspectPlayer(7)).toMatchObject({
      runtime: "client",
      playerId: 7,
      ped: { handle: 10, position: zero, health: 100 },
      vehicleHandle: 20,
      routingBucket: 4,
    });
    vi.stubGlobal("GetPlayerRoutingBucket", undefined);
    expect(await inspector.inspectPlayer(7)).toMatchObject({
      routingBucket: null,
      unavailable: ["GetPlayerRoutingBucket"],
    });
    vi.stubGlobal("GetPlayerName", () => null);
    await expect(inspector.inspectPlayer(7)).rejects.toThrow(
      "disconnected during inspection",
    );
  });

  it("distinguishes invalid/deleted entities from unavailable natives and OneSync", async () => {
    await expect(
      inspector.inspectEntity({ target: "server", handle: 99 }),
    ).rejects.toThrow("Invalid entity:");
    await expect(
      inspector.inspectEntity({ target: "server", networkId: 1 }),
    ).rejects.toThrow("Invalid entity:");
    vi.stubGlobal("GetEntityCoords", undefined);
    await expect(
      inspector.inspectEntity({ target: "server", handle: 20 }),
    ).rejects.toThrow("Unavailable: GetEntityCoords");
    vi.stubGlobal("GetAllPeds", () => {
      throw new Error("onesync disabled");
    });
    await expect(
      inspector.findEntities({ target: "server", position: zero }),
    ).rejects.toThrow("GetAllPeds failed: onesync disabled");
    vi.stubGlobal("GetAllPeds", () => undefined);
    await expect(
      inspector.findEntities({ target: "server", position: zero }),
    ).rejects.toThrow("Unavailable: entity pool");
  });

  it("rejects an entity deleted during a read and marks optional fields unavailable", async () => {
    vi.stubGlobal("GetEntityHeading", undefined);
    vi.stubGlobal("NetworkGetNetworkIdFromEntity", undefined);
    const value = await inspector.inspectEntity({
      target: "server",
      handle: 20,
    });
    expect(value.heading).toBeNull();
    expect(value.networkId).toBeNull();
    expect(value.unavailable).toEqual(
      expect.arrayContaining([
        "GetEntityHeading",
        "NetworkGetNetworkIdFromEntity",
      ]),
    );
    vi.stubGlobal("GetEntityHealth", () => {
      entities.delete(20);
      return 100;
    });
    await expect(
      inspector.inspectEntity({ target: "server", handle: 20 }),
    ).rejects.toThrow("deleted during inspection");
  });

  it("does not call network ID natives for local-only client entities", async () => {
    vi.stubGlobal("NetworkGetEntityIsNetworked", () => false);
    const network = vi.fn(() => {
      throw new Error("must not run");
    });
    vi.stubGlobal("NetworkGetNetworkIdFromEntity", network);
    expect(
      await inspector.inspectEntity({ target: "client", handle: 20 }),
    ).toMatchObject({ networkId: null, owner: null });
    expect(network).not.toHaveBeenCalled();
  });

  it("labels explicitly disabled OneSync without preventing client-side reads", async () => {
    vi.stubGlobal("GetConvar", () => "off");
    await expect(
      inspector.inspectEntity({ target: "server", handle: 20 }),
    ).rejects.toThrow("requires OneSync");
    await expect(
      inspector.findEntities({ target: "server", position: zero }),
    ).rejects.toThrow("requires OneSync");
    expect(
      (await inspector.inspectEntity({ target: "client", handle: 20 })).handle,
    ).toBe(20);
  });

  it("rejects unspawned client search centers instead of searching the origin", async () => {
    vi.stubGlobal("PlayerPedId", () => 0);
    await expect(inspector.findEntities({ target: "client" })).rejects.toThrow(
      "Invalid entity:",
    );
    expect(
      (await inspector.findEntities({ target: "client", position: zero }))
        .position,
    ).toEqual(zero);
  });

  it("rejects missing client pools and strips unrecognized executable input", async () => {
    const input = {
      target: "client",
      handle: 20,
      code: "THIS_MUST_NOT_APPEAR_IN_A_SNIPPET",
    } as const;
    await inspector.inspectEntity(input);
    expect(execute.mock.calls[0]?.[1].code).not.toContain(input.code);
    vi.stubGlobal("GetGamePool", undefined);
    await expect(inspector.findEntities({ target: "client" })).rejects.toThrow(
      "Unavailable: GetGamePool",
    );
  });

  it("sorts nearest deterministically and filters radius, type, duplicates and model", async () => {
    vi.stubGlobal("GetAllVehicles", () => [21, 10, 20, 20, 99]);
    const result = await inspector.findEntities({
      target: "server",
      position: zero,
      type: "vehicle",
      radius: 5,
      model: "car",
      limit: 1,
    });
    expect(result.entities.map((value) => value.handle)).toEqual([20]);
    expect(result.entities[0]?.distance).toBe(5);
    expect(result).toMatchObject({ matched: 2, scanned: 5, truncated: true });
    expect(
      (
        await inspector.findEntities({
          target: "server",
          position: zero,
          radius: 4,
        })
      ).entities.map((value) => value.handle),
    ).toEqual([10]);
  });

  it("normalizes signed model hashes and uses a client player center when omitted", async () => {
    entities.get(20)!.model = -1;
    const result = await inspector.findEntities({
      target: "client",
      type: "vehicle",
      model: 4_294_967_295,
    });
    expect(result.position).toEqual(zero);
    expect(result.entities.map((value) => value.handle)).toEqual([20]);
  });

  it("caps scanning at 10000 entries and labels subset-only nearest sorting", async () => {
    vi.stubGlobal("GetAllPeds", () => Array.from({ length: 10_050 }, () => 10));
    const result = await inspector.findEntities({
      target: "server",
      position: zero,
    });
    expect(result.scanned).toBe(10_000);
    expect(result.truncated).toBe(true);
    expect(result.notes.join(" ")).toContain("scanned subset");
  });

  it("keeps large client searches below serializer depth, item and transport budgets", async () => {
    const pool = Array.from({ length: 100 }, (_value, index) => {
      const handle = index + 100;
      entities.set(handle, { type: 2, coords: [index, 0, 0], model: 456 });
      return handle;
    });
    vi.stubGlobal("GetGamePool", () => pool);
    const result = await inspector.findEntities({
      target: "client",
      type: "vehicle",
      limit: 100,
      radius: 500,
    });
    expect(result.entities.length).toBeGreaterThan(20);
    expect(result.entities.length).toBeLessThanOrEqual(100);
    expect(result.entities[0]?.handle).toBe(100);
    expect(result.matched).toBe(100);
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(24_000);
    expect(result.truncated).toBe(true);
  });

  it("never invokes state/identifier getters or writes", async () => {
    const forbidden = vi.fn(() => {
      throw new Error("sensitive or mutating API");
    });
    for (const name of [
      "Entity",
      "Player",
      "GetPlayerIdentifiers",
      "GetStateBagValue",
      "SetEntityCoords",
      "DeleteEntity",
      "ExecuteCommand",
    ])
      vi.stubGlobal(name, forbidden);
    await inspector.inspectEntity({ target: "server", handle: 20 });
    await inspector.inspectPlayer(7);
    await inspector.findEntities({ target: "client" });
    expect(forbidden).not.toHaveBeenCalled();
  });

  it("validates bounds and runtime handle scope before dispatch", async () => {
    const invalid = [
      { target: "server", handle: 0 },
      { target: "server", handle: -1 },
      { target: "client", handle: 2.5 },
      { target: "client" },
      { target: "server", handle: 10, networkId: 1010 },
      { target: "server", playerId: 7, handle: 10 },
    ];
    for (const input of invalid)
      expect(inspectEntitySchema.safeParse(input).success).toBe(false);
    for (const input of [
      { target: "server" },
      { target: "client", radius: 501 },
      { target: "client", limit: 101 },
      { target: "client", radius: Infinity },
      { target: "client", position: { x: NaN, y: 0, z: 0 } },
      { target: "client", model: '");DeleteEntity(10);//' },
    ])
      expect(findEntitiesSchema.safeParse(input).success).toBe(false);
    await expect(inspector.inspectPlayer(0)).rejects.toThrow();
    expect(execute).not.toHaveBeenCalled();
  });

  describe("resource metadata", () => {
    const metadata = new Map<string, string[]>();
    beforeEach(() => {
      metadata.clear();
      metadata.set("test:author", ["Author"]);
      metadata.set("test:version", ["1.2.3"]);
      metadata.set("test:export", ["read"]);
      metadata.set("test:server_export", ["get"]);
      metadata.set("dependent:dependency", ["test"]);
      vi.stubGlobal("GetResourceState", (name: string) =>
        name === "absent" ? "missing" : "started",
      );
      vi.stubGlobal(
        "GetNumResourceMetadata",
        (name: string, key: string) =>
          metadata.get(`${name}:${key}`)?.length ?? 0,
      );
      vi.stubGlobal(
        "GetResourceMetadata",
        (name: string, key: string, index: number) =>
          metadata.get(`${name}:${key}`)?.[index],
      );
      vi.stubGlobal("GetNumResources", () => 2);
      vi.stubGlobal(
        "GetResourceByFindIndex",
        (index: number) => ["test", "dependent"][index],
      );
    });
    it("reads only bounded whitelist metadata and declared exports/dependencies", async () => {
      metadata.set("test:secret", ["do not leak"]);
      const result = await inspector.inspectResource("test");
      expect(result).toMatchObject({
        runtime: "server",
        name: "test",
        state: "started",
        metadata: { author: ["Author"], version: ["1.2.3"] },
        declaredExports: { client: ["read"], server: ["get"] },
        reverseDependencies: ["dependent"],
        truncated: false,
      });
      expect(JSON.stringify(result)).not.toContain("do not leak");
      expect(result.notes.join(" ")).toContain(
        "dynamic exports are not discoverable",
      );
    });
    it("rejects missing resources and absent metadata APIs explicitly", async () => {
      await expect(inspector.inspectResource("absent")).rejects.toThrow(
        "Invalid resource",
      );
      vi.stubGlobal("GetResourceMetadata", undefined);
      await expect(inspector.inspectResource("test")).rejects.toThrow(
        "Unavailable",
      );
      await expect(inspector.inspectResource("test;quit")).rejects.toThrow();
    });
    it("caps values, string sizes, total metadata, reverse dependencies and scanned resources", async () => {
      metadata.set(
        "test:description",
        Array.from({ length: 100 }, () => "x".repeat(2000)),
      );
      const reads = vi.fn((_name: string, key: string, _index: number) =>
        key === "dependency" ? "test" : "x".repeat(2000),
      );
      vi.stubGlobal("GetResourceMetadata", reads);
      vi.stubGlobal("GetNumResourceMetadata", (_name: string, key: string) =>
        key === "dependency" ? 1 : 100,
      );
      vi.stubGlobal("GetNumResources", () => 2000);
      vi.stubGlobal(
        "GetResourceByFindIndex",
        (index: number) => `dependent${index}`,
      );
      const result = await inspector.inspectResource("test");
      expect(result.truncated).toBe(true);
      expect(result.reverseDependencies).toHaveLength(100);
      expect(
        Object.values(result.metadata)
          .flat()
          .every((value) => value.length <= 512),
      ).toBe(true);
      expect(
        Object.values(result.metadata)
          .flat()
          .reduce((sum, value) => sum + value.length, 0),
      ).toBeLessThanOrEqual(24_000);
      expect(reads.mock.calls.length).toBeLessThan(300);
    });
  });
});
