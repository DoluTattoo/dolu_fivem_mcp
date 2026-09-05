import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { setTimeout, clearTimeout } from "node:timers";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";

const scenarioTools = [
  "execute_server",
  "execute_client",
  "execute_nui",
  "manage_resource",
  "wait_for_resource",
  "wait_for_log",
  "read_logs",
  "nui_snapshot",
  "nui_interact",
  "nui_wait_for",
  "game_screenshot",
  "inspect_resource",
  "inspect_player",
  "find_entities",
  "inspect_entity",
] as const;
const pathSchema = z
  .array(z.union([z.string().max(128), z.number().int().nonnegative()]))
  .max(12);
const assertionSchema = z
  .object({
    path: pathSchema.default([]),
    operator: z.enum(["equals", "contains", "exists"]),
    expected: z.unknown().optional(),
  })
  .superRefine((value, context) => {
    if (value.operator !== "exists" && !Object.hasOwn(value, "expected"))
      context.addIssue({
        code: "custom",
        message: "Assertion requires expected",
      });
    if (value.operator === "contains" && typeof value.expected !== "string")
      context.addIssue({
        code: "custom",
        message: "Contains assertion requires a string",
      });
  });
const stepSchema = z.object({
  label: z.string().min(1).max(100),
  tool: z.enum(scenarioTools),
  arguments: z.record(z.string().max(128), z.unknown()).default({}),
  assertions: z.array(assertionSchema).max(10).default([]),
});
export const scenarioSchema = z.object({
  name: z.string().min(1).max(100),
  resource: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/),
  playerId: z.number().int().positive().optional(),
  timeoutMs: z.number().int().min(1000).max(60000).default(30000),
  steps: z.array(stepSchema).min(1).max(12),
  cleanup: z.array(stepSchema).max(4).default([]),
});
export type ScenarioInput = z.output<typeof scenarioSchema>;
type ScenarioStep = z.output<typeof stepSchema>;
type StepState = "passed" | "failed" | "not_verified";
type InvokeTool = (
  name: string,
  args: Record<string, unknown>,
  signal: AbortSignal,
) => Promise<CallToolResult>;
interface StepReport {
  label: string;
  tool: string;
  state: StepState;
  durationMs: number;
  error?: string;
  result?: unknown;
  evidenceId?: string;
}
export interface ScenarioReport {
  id: string;
  name: string;
  resource: string;
  playerId?: number;
  state: "running" | "passed" | "failed" | "cancelled";
  startedAt: string;
  finishedAt?: string;
  steps: StepReport[];
  cleanup: StepReport[];
  note: string;
}
interface Evidence {
  id: string;
  reportId: string;
  image: { type: "image"; data: string; mimeType: string };
  bytes: number;
}
function ownPath(value: unknown, path: z.output<typeof pathSchema>): unknown {
  for (const key of path) {
    if (
      typeof value !== "object" ||
      value === null ||
      !Object.hasOwn(value, key)
    )
      return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    value = descriptor && "value" in descriptor ? descriptor.value : undefined;
  }
  return value;
}
function summarize(value: unknown): unknown {
  const text = JSON.stringify(value);
  if (!text || Buffer.byteLength(text) <= 16384) return value;
  return {
    truncated: true,
    reason:
      "Step result exceeds 16 KiB; inspect its execution/log cursor separately.",
  };
}
function bounded<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () =>
      reject(
        new Error(
          "Scenario step cancelled or deadline exceeded; unmanaged effects may continue.",
        ),
      );
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    work
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}

export class ScenarioRunner {
  private readonly reports = new Map<string, ScenarioReport>();
  private readonly evidence = new Map<string, Evidence>();
  private active: AbortController | undefined;
  private closed = false;
  private retainedBytes = 0;

  async run(
    input: ScenarioInput,
    invoke: InvokeTool,
    signal: AbortSignal,
    validate?: (name: string, args: Record<string, unknown>) => void,
  ): Promise<ScenarioReport> {
    const args = scenarioSchema.parse(input);
    if (this.closed) throw new Error("Scenario runner is closed");
    if (this.active) throw new Error("A scenario is already running");
    this.prune();
    // Validate every step, including cleanup, before dispatching any side effects.
    for (const step of [...args.steps, ...args.cleanup]) {
      const parameters = this.arguments(args, step);
      validate?.(step.tool, parameters);
    }
    const controller = new AbortController();
    this.active = controller;
    const abort = () => controller.abort();
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) controller.abort();
    const timer = setTimeout(abort, args.timeoutMs);
    const report: ScenarioReport = {
      id: randomUUID(),
      name: args.name,
      resource: args.resource,
      playerId: args.playerId,
      state: "running",
      startedAt: new Date().toISOString(),
      steps: [],
      cleanup: [],
      note: "Only declared cleanup steps run, in order, even after failure. No rollback or arbitrary-code interruption is guaranteed. Failed steps are never retried.",
    };
    this.reports.set(report.id, report);
    let completion: ScenarioReport["state"] = "failed";
    try {
      let stopped = false;
      for (const step of args.steps) {
        if (stopped || controller.signal.aborted) {
          report.steps.push({
            label: step.label,
            tool: step.tool,
            state: "not_verified",
            durationMs: 0,
          });
          continue;
        }
        const result = await this.step(
          report.id,
          args,
          step,
          invoke,
          controller.signal,
        );
        report.steps.push(result);
        stopped = result.state !== "passed";
      }
      completion = controller.signal.aborted
        ? "cancelled"
        : report.steps.every((step) => step.state === "passed")
          ? "passed"
          : "failed";
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      // Give cleanup its own bounded budget even when the caller disconnected.
      const cleanupController = new AbortController();
      const cleanupTimer = setTimeout(() => cleanupController.abort(), 10000);
      try {
        for (const step of args.cleanup) {
          if (cleanupController.signal.aborted || this.closed) {
            report.cleanup.push({
              label: step.label,
              tool: step.tool,
              state: "not_verified",
              durationMs: 0,
            });
          } else {
            report.cleanup.push(
              await this.step(
                report.id,
                args,
                step,
                invoke,
                cleanupController.signal,
              ),
            );
          }
        }
        if (report.cleanup.some((step) => step.state !== "passed"))
          completion = "failed";
      } finally {
        clearTimeout(cleanupTimer);
        report.state = completion;
        report.finishedAt = new Date().toISOString();
        this.active = undefined;
        this.prune();
      }
    }
    return report;
  }

  get(id: string): ScenarioReport {
    this.prune();
    const report = this.reports.get(id);
    if (!report) throw new Error("Unknown or expired scenario id");
    return report;
  }
  list() {
    this.prune();
    return [...this.reports.values()]
      .reverse()
      .map(({ steps, cleanup, ...report }) => ({
        ...report,
        steps: steps.length,
        cleanup: cleanup.length,
      }));
  }
  getEvidence(id: string): CallToolResult {
    this.prune();
    const item = this.evidence.get(id);
    if (!item) throw new Error("Unknown or expired evidence id");
    return {
      content: [item.image],
      structuredContent: {
        result: { id, reportId: item.reportId, bytes: item.bytes },
      },
    };
  }
  remove(id: string): { removed: string } {
    const report = this.get(id);
    if (report.state === "running")
      throw new Error("Cannot remove a running scenario");
    this.reports.delete(id);
    this.removeEvidence(id);
    return { removed: id };
  }
  close(): void {
    this.closed = true;
    this.active?.abort();
    this.evidence.clear();
    this.retainedBytes = 0;
    this.reports.clear();
  }
  private arguments(
    scenario: ScenarioInput,
    step: ScenarioStep,
  ): Record<string, unknown> {
    const args = { ...step.arguments };
    if (args.wait === false)
      throw new Error("Scenario executions must wait for completion");
    if (args.resource !== undefined && args.resource !== scenario.resource)
      throw new Error(
        "Scenario step resource must match the declared resource",
      );
    if (args.playerId !== undefined && args.playerId !== scenario.playerId)
      throw new Error("Scenario step player must match the declared playerId");
    if (
      [
        "manage_resource",
        "wait_for_resource",
        "execute_nui",
        "nui_snapshot",
        "nui_interact",
        "nui_wait_for",
        "inspect_resource",
      ].includes(step.tool)
    ) {
      args.resource = scenario.resource;
    }
    if (
      [
        "execute_client",
        "execute_nui",
        "nui_snapshot",
        "nui_interact",
        "nui_wait_for",
        "game_screenshot",
        "inspect_player",
        "find_entities",
        "inspect_entity",
      ].includes(step.tool)
    ) {
      if (
        scenario.playerId !== undefined &&
        (!["find_entities", "inspect_entity"].includes(step.tool) ||
          args.target === "client")
      )
        args.playerId = scenario.playerId;
    }
    if (step.tool === "manage_resource" && args.action === "refresh")
      throw new Error("Resource refresh is not a scoped scenario action");
    return args;
  }
  private async step(
    reportId: string,
    input: ScenarioInput,
    step: ScenarioStep,
    invoke: InvokeTool,
    signal: AbortSignal,
  ): Promise<StepReport> {
    const start = Date.now();
    const result: StepReport = {
      label: step.label,
      tool: step.tool,
      state: "failed",
      durationMs: 0,
    };
    try {
      const output = await bounded(
        invoke(step.tool, this.arguments(input, step), signal),
        signal,
      );
      const value = ownPath(output.structuredContent, ["result"]);
      result.result = summarize(value);
      if (output.isError)
        throw new Error(
          `Tool ${step.tool} failed: ${JSON.stringify(result.result ?? output.content).slice(0, 2048)}`,
        );
      for (const assertion of step.assertions) {
        const actual = ownPath(value, assertion.path);
        const passed =
          assertion.operator === "exists"
            ? actual !== undefined
            : assertion.operator === "equals"
              ? isDeepStrictEqual(actual, assertion.expected)
              : typeof actual === "string" &&
                  typeof assertion.expected === "string"
                ? actual.includes(assertion.expected)
                : Array.isArray(actual) &&
                  actual.some((entry) =>
                    isDeepStrictEqual(entry, assertion.expected),
                  );
        if (!passed)
          throw new Error(
            `Assertion ${assertion.operator} failed at ${JSON.stringify(assertion.path)}`,
          );
      }
      const image = output.content.find((item) => item.type === "image");
      if (image?.type === "image") {
        const bytes = Buffer.byteLength(image.data);
        if (bytes > 2_097_152 || this.retainedBytes + bytes > 8_388_608)
          throw new Error(
            "Scenario evidence budget exceeded; release older reports or use smaller screenshots",
          );
        const id = randomUUID();
        this.evidence.set(id, {
          id,
          reportId,
          image: { type: "image", data: image.data, mimeType: image.mimeType },
          bytes,
        });
        this.retainedBytes += bytes;
        result.evidenceId = id;
      }
      result.state = "passed";
    } catch (error) {
      result.error = (
        error instanceof Error ? error.message : String(error)
      ).slice(0, 4096);
    }
    result.durationMs = Date.now() - start;
    return result;
  }
  private prune(): void {
    for (const [id, report] of this.reports) {
      if (
        report.state !== "running" &&
        (this.reports.size > 20 ||
          Date.now() - Date.parse(report.startedAt) > 900000)
      ) {
        this.reports.delete(id);
        this.removeEvidence(id);
      }
    }
  }
  private removeEvidence(reportId: string): void {
    for (const [id, item] of this.evidence) {
      if (item.reportId === reportId) {
        this.retainedBytes -= item.bytes;
        this.evidence.delete(id);
      }
    }
  }
}
