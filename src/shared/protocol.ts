import { z } from "zod";

export const VERSION = "0.1.1";
export const MAX_CODE = 65_536;
export const MAX_RESULT = 131_072;
export const MAX_LOGS = 100;
export const MAX_LOG_PACKET = 25_000;
export const helloSchema = z.object({
  version: z.string().max(32),
  buildId: z.string().min(1).max(128),
  nuiBuildId: z.string().min(1).max(128).nullable(),
  nuiReady: z.boolean(),
});
export const languageSchema = z.enum(["javascript", "lua"]);
export const executionSchema = z.object({
  language: languageSchema,
  code: z.string().min(1).max(MAX_CODE),
  timeoutMs: z.number().int().min(100).max(60_000).default(10_000),
  wait: z.boolean().default(true),
});
export const wireRequestSchema = executionSchema.omit({ wait: true }).extend({
  id: z.string().uuid(),
  buildId: z.string().min(1).max(128).optional(),
});
export const logSchema = z.object({
  level: z.enum(["debug", "info", "warn", "error"]),
  message: z.string().max(4096),
});
export const progressSchema = z
  .object({
    id: z.string().uuid(),
    seq: z.number().int().min(1).max(MAX_LOGS),
    log: logSchema,
  })
  .strict();
export type ProgressLog = z.infer<typeof progressSchema>;
export const outcomeSchema = z.object({
  ok: z.boolean(),
  values: z.array(z.unknown()).max(100),
  error: z.string().max(8192).optional(),
  logs: z.array(logSchema).max(MAX_LOGS),
  durationMs: z.number().finite().nonnegative(),
  truncated: z.boolean().optional(),
});
export type ExecutionInput = z.infer<typeof executionSchema>;
export type WireRequest = z.infer<typeof wireRequestSchema>;
export type Outcome = z.infer<typeof outcomeSchema>;
export type ExecutionLog = z.infer<typeof logSchema>;
export type Target = "server" | "client";

export function events(resource: string) {
  const prefix = `${resource}:mcp:`;
  return {
    hello: `${prefix}hello`,
    execute: `${prefix}execute`,
    cancel: `${prefix}cancel`,
    result: `${prefix}result`,
    log: `${prefix}log`,
    luaExecute: `${prefix}lua:execute`,
    luaCancel: `${prefix}lua:cancel`,
    luaResult: `${prefix}lua:result`,
    luaLog: `${prefix}lua:log`,
  };
}

export function errorMessage(error: unknown): string {
  return (
    error instanceof Error ? (error.stack ?? error.message) : String(error)
  ).slice(0, 8192);
}

// No Node/browser APIs: this module also runs in FiveM's client V8 runtime.
export function sanitize(
  value: unknown,
  depth = 0,
  seen = new Set<object>(),
  budget = { remaining: 1000 },
): unknown {
  if (--budget.remaining < 0) return { $type: "max-items" };
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string")
    return value.length > 8192 ? `${value.slice(0, 8192)}[truncated]` : value;
  if (typeof value === "number")
    return Number.isFinite(value)
      ? value
      : { $type: "number", value: String(value) };
  if (value === undefined) return { $type: "undefined" };
  if (typeof value === "bigint")
    return { $type: "bigint", value: String(value) };
  if (typeof value !== "object") return { $type: typeof value };
  if (seen.has(value)) return { $type: "circular" };
  if (depth >= 6) return { $type: "max-depth" };
  seen.add(value);
  try {
    if (value instanceof Error)
      return {
        $type: "error",
        message: value.message,
        stack: value.stack?.slice(0, 8192),
      };
    if (Array.isArray(value)) {
      const result = value
        .slice(0, 100)
        .map((item) => sanitize(item, depth + 1, seen, budget));
      if (value.length > 100)
        result.push({ $type: "truncated", omitted: value.length - 100 });
      return result;
    }
    const result: Record<string, unknown> = Object.create(null);
    const keys = Object.keys(value);
    for (const key of keys.slice(0, 100)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      result[key.slice(0, 256)] =
        descriptor && "value" in descriptor
          ? sanitize(descriptor.value, depth + 1, seen, budget)
          : { $type: "accessor" };
    }
    if (keys.length > 100) result.$truncated = keys.length - 100;
    return result;
  } finally {
    seen.delete(value);
  }
}

export function logText(values: unknown[]): string {
  return values
    .map((value) =>
      typeof value === "string" ? value : JSON.stringify(sanitize(value)),
    )
    .join(" ")
    .slice(0, 4096);
}

export function encodeOutcome(outcome: Outcome): string {
  const text = JSON.stringify(outcome);
  // UTF-8 can need up to three bytes per UTF-16 code unit.
  if (text.length * 3 <= MAX_RESULT) return text;
  return JSON.stringify({
    ok: false,
    values: [],
    logs: outcome.logs.slice(0, 5),
    error: "Result exceeds the transport size limit; return a smaller value.",
    durationMs: outcome.durationMs,
    truncated: true,
  } satisfies Outcome);
}
