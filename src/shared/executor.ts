import {
  MAX_LOGS,
  errorMessage,
  logText,
  sanitize,
  type ExecutionLog,
  type Outcome,
  type WireRequest,
  type ProgressLog,
} from "./protocol";
import { scheduleTimeout } from "./timer";
export interface Runtime {
  resource: string;
  require?: unknown;
  exports: unknown;
  print: (level: ExecutionLog["level"], message: string) => void;
  game?: <T>(callback: () => T) => Promise<T>;
  progress?: (packet: ProgressLog) => void;
}

interface Context {
  id: string;
  resource: string;
  alive(): boolean;
  log(...values: unknown[]): void;
  sleep(ms: number): Promise<void>;
  game<T>(callback: () => T): Promise<T>;
  onCleanup(callback: () => void): void;
}

type Snippet = (
  ctx: Context,
  console: Record<string, (...args: unknown[]) => void>,
  require: unknown,
  exports: unknown,
) => Promise<unknown>;
const AsyncFunction = Object.getPrototypeOf(async function () {})
  .constructor as new (...args: string[]) => Snippet;

export class JavascriptExecutor {
  private readonly active = new Map<string, () => void>();
  constructor(private readonly runtime: Runtime) {}

  cancel(id: string): void {
    this.active.get(id)?.();
  }
  close(): void {
    for (const cancel of [...this.active.values()]) cancel();
  }

  async execute(request: WireRequest): Promise<Outcome> {
    if (this.active.has(request.id)) throw new Error("Duplicate execution id");
    const start = Date.now();
    let alive = true;
    const logs: ExecutionLog[] = [];
    const cleanups: Array<() => void> = [];
    const sleeps = new Map<() => void, (error: Error) => void>();
    const log = (level: ExecutionLog["level"], values: unknown[]) => {
      if (!alive || logs.length >= MAX_LOGS) return;
      const message = logText(values);
      logs.push({ level, message });
      this.runtime.progress?.({
        id: request.id,
        seq: logs.length,
        log: { level, message },
      });
      this.runtime.print(level, `[${request.id}] ${message}`);
    };
    let rejectCancelled: (error: Error) => void = () => {};
    const cancelled = new Promise<never>((_resolve, reject) => {
      rejectCancelled = reject;
    });
    const cancel = () => {
      if (!alive) return;
      alive = false;
      const error = new Error(
        "Execution cancelled or deadline exceeded; unmanaged effects may continue.",
      );
      for (const [stopTimer, reject] of sleeps) {
        stopTimer();
        reject(error);
      }
      sleeps.clear();
      rejectCancelled(error);
    };
    this.active.set(request.id, cancel);
    const stopDeadline = scheduleTimeout(cancel, request.timeoutMs);
    const ctx: Context = {
      id: request.id,
      resource: this.runtime.resource,
      alive: () => alive,
      game: <T>(callback: () => T) => {
        if (!alive)
          return Promise.reject(new Error("Execution is no longer active"));
        const guarded = () => {
          if (!alive) throw new Error("Execution is no longer active");
          return callback();
        };
        return this.runtime.game
          ? this.runtime.game(guarded)
          : Promise.resolve().then(guarded);
      },
      log: (...values) => log("info", values),
      sleep: (ms) => {
        if (!alive)
          return Promise.reject(new Error("Execution is no longer active"));
        if (!Number.isFinite(ms) || ms < 0 || ms > 60_000)
          return Promise.reject(
            new Error("sleep expects 0..60000 milliseconds"),
          );
        return new Promise((resolve, reject) => {
          const stopTimer = scheduleTimeout(() => {
            sleeps.delete(stopTimer);
            resolve();
          }, ms);
          sleeps.set(stopTimer, reject);
        });
      },
      onCleanup: (callback) => {
        if (!alive) throw new Error("Execution is no longer active");
        if (typeof callback !== "function")
          throw new Error("onCleanup expects a function");
        if (cleanups.length >= 100)
          throw new Error("Too many cleanup callbacks");
        cleanups.push(callback);
      },
    };
    const consoleProxy = {
      log: ctx.log,
      info: ctx.log,
      debug: (...values: unknown[]) => log("debug", values),
      warn: (...values: unknown[]) => log("warn", values),
      error: (...values: unknown[]) => log("error", values),
    };
    let outcome: Outcome;
    try {
      const snippet = new AsyncFunction(
        "ctx",
        "console",
        "require",
        "exports",
        `"use strict";\n${request.code}\n//# sourceURL=@${this.runtime.resource}/mcp/${request.id}.js`,
      );
      const value = await Promise.race([
        snippet(ctx, consoleProxy, this.runtime.require, this.runtime.exports),
        cancelled,
      ]);
      outcome = {
        ok: true,
        values: [sanitize(value)],
        logs,
        durationMs: Date.now() - start,
      };
    } catch (error) {
      outcome = {
        ok: false,
        values: [],
        error: errorMessage(error),
        logs,
        durationMs: Date.now() - start,
      };
    } finally {
      stopDeadline();
      this.active.delete(request.id);
      alive = false;
      for (const [stopTimer, reject] of sleeps) {
        stopTimer();
        reject(new Error("Execution finished"));
      }
      sleeps.clear();
    }
    for (const cleanup of cleanups.reverse()) {
      try {
        cleanup();
      } catch (error) {
        outcome.ok = false;
        outcome.error =
          `${outcome.error ?? ""}\nCleanup failed: ${errorMessage(error)}`.slice(
            0,
            8192,
          );
      }
    }
    return outcome;
  }
}
