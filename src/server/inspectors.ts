import { z } from "zod";
import { gameThread, type GameService } from "./game";

const playerIdSchema = z.number().int().positive().max(2_147_483_647);
const handleSchema = z.number().int().positive().max(2_147_483_647);
export const inspectionPositionSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  z: z.number().finite(),
});
export const inspectResourceSchema = z.object({
  resource: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/),
});
export const inspectPlayerSchema = z.object({ playerId: playerIdSchema });
const targetShape = {
  target: z.enum(["server", "client"]),
  playerId: playerIdSchema.optional(),
};
export const findEntitiesSchema = z
  .object({
    ...targetShape,
    type: z.enum(["ped", "vehicle", "object", "all"]).default("all"),
    radius: z.number().finite().positive().max(500).default(100),
    position: inspectionPositionSchema.optional(),
    model: z
      .union([
        z.number().int().min(-2_147_483_648).max(4_294_967_295),
        z
          .string()
          .min(1)
          .max(128)
          .regex(/^[A-Za-z0-9_.-]+$/),
      ])
      .optional(),
    limit: z.number().int().min(1).max(100).default(25),
  })
  .superRefine((input, ctx) => {
    if (input.target === "server" && !input.position)
      ctx.addIssue({
        code: "custom",
        message: "Server search requires position",
      });
    if (input.target === "server" && input.playerId !== undefined)
      ctx.addIssue({
        code: "custom",
        message: "Server handles have no playerId",
      });
  });
export const inspectEntitySchema = z
  .object({
    ...targetShape,
    handle: handleSchema.optional(),
    networkId: handleSchema.optional(),
  })
  .superRefine((input, ctx) => {
    if ((input.handle === undefined) === (input.networkId === undefined))
      ctx.addIssue({
        code: "custom",
        message: "Supply exactly one of handle or networkId",
      });
    if (input.target === "server" && input.playerId !== undefined)
      ctx.addIssue({
        code: "custom",
        message: "Server handles have no playerId",
      });
  });

const scopeShape = {
  runtime: z.enum(["server", "client"]),
  playerId: playerIdSchema.nullable(),
  handleScope: z.string().max(160),
};
export const entityInspectionSchema = z.object({
  ...scopeShape,
  exists: z.literal(true),
  handle: handleSchema,
  networkId: z.number().int().positive().nullable(),
  owner: z.number().int().nullable(),
  ownerKind: z.enum(["server-player-id", "client-player-index"]),
  model: z.number().int(),
  type: z.enum(["ped", "vehicle", "object"]),
  position: inspectionPositionSchema,
  heading: z.number().finite().nullable(),
  health: z.number().finite().nullable(),
  unavailable: z.array(z.string().max(160)).max(20),
  unavailableReasons: z.record(z.string().max(160), z.string().max(512)),
});
export const entitySearchSchema = z.object({
  ...scopeShape,
  position: inspectionPositionSchema,
  radius: z.number().finite(),
  entities: z
    .array(entityInspectionSchema.extend({ distance: z.number().finite() }))
    .max(100),
  scanned: z.number().int().min(0).max(10_000),
  matched: z.number().int().min(0).max(10_000),
  truncated: z.boolean(),
  notes: z.array(z.string().max(256)).max(10),
});
const runtimePlayerSchema = z.object({
  ...scopeShape,
  playerId: playerIdSchema,
  ped: entityInspectionSchema,
  vehicleHandle: z.number().int().nonnegative().nullable(),
  unavailable: z.array(z.string().max(160)).max(20),
  unavailableReasons: z.record(z.string().max(160), z.string().max(512)),
});
export type EntityInspection = z.infer<typeof entityInspectionSchema>;
export type EntitySearch = z.infer<typeof entitySearchSchema>;
type RuntimePlayer = z.infer<typeof runtimePlayerSchema>;
type RuntimeRequest =
  | ({ operation: "entity" } & z.output<typeof inspectEntitySchema>)
  | ({ operation: "find" } & z.output<typeof findEntitiesSchema>)
  | { operation: "player"; target: "client"; playerId: number };

// Deliberately self-contained: its JavaScript source also runs on the selected client.
function readRuntime(
  request: RuntimeRequest,
): EntityInspection | EntitySearch | RuntimePlayer {
  function reason(error: unknown): string {
    return (
      error instanceof Error
        ? error.message
        : typeof error === "string"
          ? error
          : "Native threw a non-Error value"
    ).slice(0, 512);
  }
  function native(name: string, ...args: unknown[]): unknown {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
    if (
      !descriptor ||
      !("value" in descriptor) ||
      typeof descriptor.value !== "function"
    )
      throw new Error(
        `Unavailable: ${name}; this runtime/build may not support it (server entities require OneSync).`,
      );
    try {
      return Reflect.apply(descriptor.value, globalThis, args);
    } catch (error) {
      throw new Error(`Unavailable: ${name} failed: ${reason(error)}`);
    }
  }
  function number(name: string, ...args: unknown[]): number {
    const result = native(name, ...args);
    if (typeof result !== "number" || !Number.isFinite(result))
      throw new Error(
        `Unavailable: ${name} expected a finite number, received ${typeof result}`,
      );
    return result;
  }
  function integer(name: string, ...args: unknown[]): number {
    const result = number(name, ...args);
    if (!Number.isSafeInteger(result))
      throw new Error(
        `Unavailable: ${name} expected a safe integer, received ${result}`,
      );
    return result;
  }
  function optionalNumber(
    unavailable: string[],
    unavailableReasons: Record<string, string>,
    name: string,
    integral: boolean,
    ...args: unknown[]
  ): number | null {
    try {
      return integral ? integer(name, ...args) : number(name, ...args);
    } catch (error) {
      if (!unavailable.includes(name)) unavailable.push(name);
      unavailableReasons[name] = reason(error);
      return null;
    }
  }
  function boolean(name: string, ...args: unknown[]): boolean {
    const result = native(name, ...args);
    if (result === true || result === 1) return true;
    if (result === false || result === 0) return false;
    throw new Error(
      `Unavailable: ${name} expected boolean or 0/1, received ${typeof result}`,
    );
  }
  function exists(handle: number): boolean {
    return boolean("DoesEntityExist", handle);
  }
  function position(handle: number): { x: number; y: number; z: number } {
    if (!Number.isInteger(handle) || handle <= 0 || !exists(handle))
      throw new Error(
        "Invalid entity: no existing entity for the requested position",
      );
    const result = native("GetEntityCoords", handle);
    if (
      !Array.isArray(result) ||
      result.length < 3 ||
      ![result[0], result[1], result[2]].every(
        (value: unknown) => typeof value === "number" && Number.isFinite(value),
      )
    )
      throw new Error(
        "Unavailable: GetEntityCoords expected a finite [x, y, z] array",
      );
    return {
      x: result[0] as number,
      y: result[1] as number,
      z: result[2] as number,
    };
  }
  const scope = {
    runtime: request.target,
    playerId: request.playerId ?? null,
    handleScope:
      request.target === "server"
        ? "server runtime only; handles are ephemeral"
        : `client runtime for player ${request.playerId}; handles are ephemeral`,
  };
  const convar = Object.getOwnPropertyDescriptor(globalThis, "GetConvar");
  if (
    request.target === "server" &&
    convar &&
    "value" in convar &&
    typeof convar.value === "function" &&
    native("GetConvar", "onesync", "") === "off"
  )
    throw new Error("Unavailable: server entity inspection requires OneSync");
  function entity(handle: number): EntityInspection {
    if (!Number.isInteger(handle) || handle <= 0 || !exists(handle))
      throw new Error(
        "Invalid entity: handle is missing, deleted or not visible in this runtime",
      );
    const kind = integer("GetEntityType", handle);
    const type =
      kind === 1
        ? "ped"
        : kind === 2
          ? "vehicle"
          : kind === 3
            ? "object"
            : null;
    if (!type)
      throw new Error("Invalid entity: unsupported or deleted entity type");
    const unavailable: string[] = [];
    const unavailableReasons: Record<string, string> = {};
    let networkId: number | null = null;
    let owner: number | null = null;
    let networked = true;
    if (request.target === "client") {
      try {
        networked = boolean("NetworkGetEntityIsNetworked", handle);
      } catch (error) {
        networked = false;
        unavailable.push("NetworkGetEntityIsNetworked");
        unavailableReasons.NetworkGetEntityIsNetworked = reason(error);
      }
    }
    if (networked) {
      networkId = optionalNumber(
        unavailable,
        unavailableReasons,
        "NetworkGetNetworkIdFromEntity",
        true,
        handle,
      );
      if (networkId !== null && networkId <= 0) networkId = null;
      owner = optionalNumber(
        unavailable,
        unavailableReasons,
        "NetworkGetEntityOwner",
        true,
        handle,
      );
    }
    const result: EntityInspection = {
      ...scope,
      exists: true,
      handle,
      networkId,
      owner,
      ownerKind:
        request.target === "server"
          ? "server-player-id"
          : "client-player-index",
      model: integer("GetEntityModel", handle),
      type,
      position: position(handle),
      heading: optionalNumber(
        unavailable,
        unavailableReasons,
        "GetEntityHeading",
        false,
        handle,
      ),
      health: optionalNumber(
        unavailable,
        unavailableReasons,
        "GetEntityHealth",
        false,
        handle,
      ),
      unavailable,
      unavailableReasons,
    };
    if (!exists(handle))
      throw new Error("Invalid entity: deleted during inspection");
    return result;
  }
  if (request.operation === "entity") {
    const handle =
      request.handle ??
      integer("NetworkGetEntityFromNetworkId", request.networkId);
    return entity(handle);
  }
  if (request.operation === "player") {
    const ped = entity(integer("PlayerPedId"));
    const unavailable: string[] = [];
    const unavailableReasons: Record<string, string> = {};
    return {
      ...scope,
      playerId: request.playerId,
      ped,
      vehicleHandle: optionalNumber(
        unavailable,
        unavailableReasons,
        "GetVehiclePedIsIn",
        true,
        ped.handle,
        false,
      ),
      unavailable,
      unavailableReasons,
    };
  }
  const center = request.position ?? position(integer("PlayerPedId"));
  const model =
    typeof request.model === "string"
      ? integer("GetHashKey", request.model) >>> 0
      : request.model === undefined
        ? undefined
        : request.model >>> 0;
  const kinds =
    request.type === "all" ? ["ped", "vehicle", "object"] : [request.type];
  const candidates: Array<{ handle: number; distance: number }> = [];
  const seen = new Set<number>();
  let scanned = 0;
  let truncated = false;
  const notes = [
    "Only entities visible to the selected runtime; state bags are not read.",
  ];
  for (const kind of kinds) {
    const pool =
      request.target === "client"
        ? native(
            "GetGamePool",
            kind === "ped"
              ? "CPed"
              : kind === "vehicle"
                ? "CVehicle"
                : "CObject",
          )
        : native(
            kind === "ped"
              ? "GetAllPeds"
              : kind === "vehicle"
                ? "GetAllVehicles"
                : "GetAllObjects",
          );
    if (!Array.isArray(pool))
      throw new Error(
        "Unavailable: entity pool (server entities require OneSync)",
      );
    for (let index = 0; index < pool.length; index++) {
      if (scanned >= 10_000) {
        truncated = true;
        break;
      }
      scanned++;
      const handle: unknown = pool[index];
      if (
        typeof handle !== "number" ||
        !Number.isInteger(handle) ||
        handle <= 0 ||
        seen.has(handle)
      )
        continue;
      seen.add(handle);
      if (!exists(handle)) continue;
      const actualKind = integer("GetEntityType", handle);
      if (actualKind !== (kind === "ped" ? 1 : kind === "vehicle" ? 2 : 3))
        continue;
      if (
        model !== undefined &&
        integer("GetEntityModel", handle) >>> 0 !== model
      )
        continue;
      const coords = position(handle);
      const distance = Math.hypot(
        coords.x - center.x,
        coords.y - center.y,
        coords.z - center.z,
      );
      if (distance <= request.radius) candidates.push({ handle, distance });
    }
    if (truncated) break;
  }
  if (truncated)
    notes.push(
      "Scan capped at 10000 pool entries; nearest ordering only covers the scanned subset.",
    );
  candidates.sort((a, b) => a.distance - b.distance || a.handle - b.handle);
  const entities: EntitySearch["entities"] = [];
  for (const candidate of candidates) {
    if (entities.length >= request.limit) break;
    try {
      entities.push({
        ...entity(candidate.handle),
        distance: candidate.distance,
      });
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !error.message.startsWith("Invalid entity:")
      )
        throw error;
    }
  }
  const result: EntitySearch = {
    ...scope,
    position: center,
    radius: request.radius,
    entities,
    scanned,
    matched: candidates.length,
    truncated: truncated || candidates.length > entities.length,
    notes,
  };
  if (candidates.length > entities.length)
    notes.push(
      "Results capped by limit or entities disappeared during inspection.",
    );
  // Leave room for escaping and the execution envelope on the bounded client transport.
  if (JSON.stringify(result).length > 24_000) {
    result.truncated = true;
    notes.push("Results additionally capped by the response byte budget.");
    while (JSON.stringify(result).length > 24_000 && entities.length)
      entities.pop();
  }
  return result;
}

const metadataKeys = [
  "author",
  "version",
  "description",
  "fx_version",
  "game",
  "dependency",
  "ui_page",
  "export",
  "server_export",
] as const;
type MetadataKey = (typeof metadataKeys)[number];
export interface ResourceInspection {
  runtime: "server";
  name: string;
  state: string;
  metadata: Record<MetadataKey, string[]>;
  declaredExports: { client: string[]; server: string[] };
  reverseDependencies: string[];
  truncated: boolean;
  notes: string[];
}
export interface PlayerInspection extends RuntimePlayer {
  routingBucket: number | null;
  notes: string[];
}
export interface InspectorGame {
  players(): Promise<
    Array<{ playerId: number; authorized: boolean; ready: boolean }>
  >;
  execute: GameService["execute"];
}

export class FiveMInspector {
  constructor(private readonly game: InspectorGame) {}

  async inspectResource(name: string): Promise<ResourceInspection> {
    const { resource } = inspectResourceSchema.parse({ resource: name });
    return gameThread(() => {
      if (
        typeof GetResourceState !== "function" ||
        typeof GetNumResourceMetadata !== "function" ||
        typeof GetResourceMetadata !== "function" ||
        typeof GetNumResources !== "function" ||
        typeof GetResourceByFindIndex !== "function"
      )
        throw new Error("Unavailable: resource metadata natives");
      const state = GetResourceState(resource);
      if (typeof state !== "string")
        throw new Error("Unavailable: GetResourceState expected a string");
      if (!state || state === "missing" || state === "unknown")
        throw new Error("Invalid resource: resource not found");
      let truncated = false;
      let budget = 24_000;
      function metadata(
        name: string,
        key: MetadataKey,
        output: boolean,
      ): string[] {
        const count = GetNumResourceMetadata(name, key);
        if (!Number.isInteger(count) || count < 0)
          throw new Error("Unavailable: resource metadata count");
        if (count > 64) truncated = true;
        const values: string[] = [];
        for (let index = 0; index < Math.min(count, 64); index++) {
          const value = GetResourceMetadata(name, key, index);
          if (typeof value !== "string") continue;
          const max = output ? Math.min(512, budget) : 128;
          if (value.length > max) truncated = true;
          if (output && budget <= 0) break;
          const bounded = value.slice(0, max);
          if (output) budget -= bounded.length;
          // Never mistake a truncated dependency name for the requested resource.
          if (!output && value.length > max) continue;
          values.push(bounded);
        }
        return values;
      }
      const values = Object.fromEntries(
        metadataKeys.map((key) => [key, metadata(resource, key, true)]),
      ) as Record<MetadataKey, string[]>;
      const count = GetNumResources();
      if (!Number.isInteger(count) || count < 0)
        throw new Error("Unavailable: resource count");
      if (count > 1000) truncated = true;
      const reverseDependencies: string[] = [];
      for (let index = 0; index < Math.min(count, 1000); index++) {
        const candidate = GetResourceByFindIndex(index);
        if (!candidate || candidate === resource) continue;
        if (metadata(candidate, "dependency", false).includes(resource)) {
          if (reverseDependencies.length >= 100) {
            truncated = true;
            break;
          }
          reverseDependencies.push(candidate.slice(0, 128));
        }
      }
      return {
        runtime: "server",
        name: resource,
        state: state.slice(0, 128),
        metadata: values,
        declaredExports: {
          client: values.export,
          server: values.server_export,
        },
        reverseDependencies: reverseDependencies.sort(),
        truncated,
        notes: [
          "Only whitelisted manifest metadata; dynamic exports are not discoverable.",
          "Reverse dependencies cover declared dependency metadata only, not runtime use or provide aliases.",
          "Bounded to 64 values/key, 512 characters/value, 1000 resources and 100 reverse dependencies.",
        ],
      };
    });
  }

  private async selectPlayer(playerId?: number): Promise<number> {
    const players = await this.game.players();
    if (playerId !== undefined) {
      const player = players.find((value) => value.playerId === playerId);
      if (!player) throw new Error("Invalid player: disconnected or not found");
      if (!player.authorized)
        throw new Error("Unauthorized player: missing MCP ACE");
      if (!player.ready)
        throw new Error("Unavailable player: client bridge is not ready");
      return playerId;
    }
    const ready = players.filter((value) => value.authorized && value.ready);
    if (ready.length !== 1 || !ready[0])
      throw new Error(
        "Specify playerId: expected exactly one authorized ready client",
      );
    return ready[0].playerId;
  }

  private async read(request: RuntimeRequest): Promise<unknown> {
    if (request.target === "server")
      return gameThread(() => readRuntime(request));
    const playerId = await this.selectPlayer(request.playerId);
    const input = { ...request, playerId };
    const job = await this.game.execute(
      "client",
      {
        language: "javascript",
        timeoutMs: 10_000,
        wait: true,
        code: `const value = (${readRuntime.toString()})(${JSON.stringify(input)});\nconst json = JSON.stringify(value);\nreturn json.match(/[\\s\\S]{1,4000}/g);`,
      },
      playerId,
    );
    if (job.target !== "client" || job.playerId !== playerId)
      throw new Error(
        "Invalid inspection response: client runtime does not match requested player",
      );
    if (job.state !== "completed" || !job.outcome?.ok)
      throw new Error(
        `Client inspection ${job.state}: ${job.outcome?.error ?? "no result available"}`,
      );
    const chunks = z
      .array(z.string().max(4000))
      .max(10)
      .parse(job.outcome.values[0]);
    const result: unknown = JSON.parse(chunks.join(""));
    const scope = z
      .object({ runtime: z.literal("client"), playerId: z.literal(playerId) })
      .safeParse(result);
    if (!scope.success)
      throw new Error("Invalid inspection response: incorrect runtime scope");
    return result;
  }

  async inspectPlayer(playerId: number): Promise<PlayerInspection> {
    inspectPlayerSchema.parse({ playerId });
    const value = runtimePlayerSchema.parse(
      await this.read({ operation: "player", target: "client", playerId }),
    );
    await this.selectPlayer(playerId);
    const routingBucket = await gameThread(() => {
      if (typeof GetPlayerName !== "function")
        throw new Error("Unavailable: GetPlayerName");
      if (!GetPlayerName(String(playerId)))
        throw new Error("Invalid player: disconnected during inspection");
      if (typeof GetPlayerRoutingBucket !== "function") {
        value.unavailableReasons.GetPlayerRoutingBucket =
          "Unavailable: GetPlayerRoutingBucket";
        return null;
      }
      try {
        const bucket = GetPlayerRoutingBucket(String(playerId));
        if (!Number.isSafeInteger(bucket) || bucket < 0)
          throw new Error(
            "GetPlayerRoutingBucket expected a nonnegative safe integer",
          );
        return bucket;
      } catch (error) {
        value.unavailableReasons.GetPlayerRoutingBucket = (
          error instanceof Error
            ? error.message
            : typeof error === "string"
              ? error
              : "Native threw a non-Error value"
        ).slice(0, 512);
        return null;
      }
    });
    if (routingBucket === null)
      value.unavailable.push("GetPlayerRoutingBucket");
    return {
      ...value,
      routingBucket,
      notes: [
        "Ped and vehicle handles belong only to this player's client runtime; routing bucket is read on the server.",
        "Player identifiers and state bags are not read.",
      ],
    };
  }

  async findEntities(
    input: z.input<typeof findEntitiesSchema>,
  ): Promise<EntitySearch> {
    const request = findEntitiesSchema.parse(input);
    return entitySearchSchema.parse(
      await this.read({ ...request, operation: "find" }),
    );
  }

  async inspectEntity(
    input: z.input<typeof inspectEntitySchema>,
  ): Promise<EntityInspection> {
    const request = inspectEntitySchema.parse(input);
    return entityInspectionSchema.parse(
      await this.read({ ...request, operation: "entity" }),
    );
  }
}
