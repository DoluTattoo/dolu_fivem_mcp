import { randomUUID } from "node:crypto";
import { scheduleTimeout } from "../shared/timer";
import type {
  ExecutionInput,
  Outcome,
  Target,
  WireRequest,
  ExecutionLog,
} from "../shared/protocol";
import { BUILD_ID } from "../shared/build";

export type JobState =
  | "running"
  | "completed"
  | "failed"
  | "timed_out"
  | "cancelled"
  | "disconnected";
export interface Job {
  id: string;
  target: Target;
  language: ExecutionInput["language"];
  playerId?: number;
  state: JobState;
  startedAt: string;
  finishedAt?: string;
  outcome?: Outcome;
  note?: string;
  logs: ExecutionLog[];
}
interface Pending {
  job: Job;
  deadline: number;
  cancel: () => void;
  stopTimer: () => void;
  done: Promise<Job>;
  resolve: (job: Job) => void;
}
export class Jobs {
  private readonly records = new Map<string, Job>();
  private readonly pending = new Map<string, Pending>();
  constructor(private readonly maxActive = 8) {}

  start(
    target: Target,
    input: ExecutionInput,
    playerId: number | undefined,
    dispatch: (request: WireRequest) => void,
    cancel: (id: string) => void,
  ): { job: Job; done: Promise<Job> } {
    if (this.pending.size >= this.maxActive)
      throw new Error("Too many active executions");
    const id = randomUUID();
    const startedAt = Date.now();
    const job: Job = {
      id,
      target,
      playerId,
      language: input.language,
      state: "running",
      startedAt: new Date(startedAt).toISOString(),
      logs: [],
    };
    let resolve!: (job: Job) => void;
    const done = new Promise<Job>((r) => {
      resolve = r;
    });
    const stopTimer = scheduleTimeout(
      () => this.cancel(id, "timed_out"),
      input.timeoutMs,
    );
    this.records.set(id, job);
    this.pending.set(id, {
      job,
      deadline: startedAt + input.timeoutMs,
      resolve,
      done,
      stopTimer,
      cancel: () => cancel(id),
    });
    this.prune();
    try {
      dispatch({
        id,
        language: input.language,
        code: input.code,
        timeoutMs: input.timeoutMs,
        buildId: BUILD_ID,
      });
    } catch (error) {
      this.finish(id, {
        ok: false,
        values: [],
        logs: [],
        durationMs: 0,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return { job, done };
  }
  get(id: string): Job {
    const job = this.records.get(id);
    if (!job) throw new Error("Unknown or expired execution id");
    return job;
  }
  list(): Job[] {
    return [...this.records.values()].reverse();
  }
  accepts(id: string, playerId?: number): boolean {
    const pending = this.pending.get(id);
    if (!pending || pending.job.playerId !== playerId) return false;
    if (Date.now() >= pending.deadline) {
      this.cancel(id, "timed_out");
      return false;
    }
    return true;
  }
  progress(
    id: string,
    seq: number,
    log: ExecutionLog,
    playerId?: number,
  ): boolean {
    if (!this.accepts(id, playerId)) return false;
    const job = this.get(id);
    if (seq !== job.logs.length + 1 || seq > 100) return false;
    job.logs.push(log);
    return true;
  }
  finish(id: string, outcome: Outcome): boolean {
    const pending = this.pending.get(id);
    if (!pending) return false;
    // A result can arrive after the deadline but before the server's next tick.
    if (Date.now() >= pending.deadline) {
      this.cancel(id, "timed_out");
      return false;
    }
    const logs = [
      ...pending.job.logs,
      ...outcome.logs.slice(pending.job.logs.length),
    ].slice(0, 100);
    pending.job.logs = logs;
    pending.job.outcome = { ...outcome, logs };
    this.complete(pending, outcome.ok ? "completed" : "failed");
    return true;
  }
  cancel(
    id: string,
    state: "cancelled" | "timed_out" | "disconnected" = "cancelled",
  ): Job {
    const job = this.get(id);
    const pending = this.pending.get(id);
    if (!pending) return job;
    job.note =
      "Cancellation is cooperative. Arbitrary code and its unmanaged effects may continue.";
    this.complete(pending, state);
    pending.cancel();
    return job;
  }
  disconnect(playerId: number): void {
    for (const pending of [...this.pending.values()]) {
      if (pending.job.playerId === playerId)
        this.cancel(pending.job.id, "disconnected");
    }
  }
  close(): void {
    for (const id of [...this.pending.keys()]) this.cancel(id);
  }
  private complete(pending: Pending, state: JobState): void {
    pending.stopTimer();
    pending.job.state = state;
    pending.job.finishedAt = new Date().toISOString();
    this.pending.delete(pending.job.id);
    pending.resolve(pending.job);
  }
  private prune(): void {
    for (const [id, job] of this.records) {
      if (
        job.state !== "running" &&
        (this.records.size > 100 ||
          Date.parse(job.startedAt) < Date.now() - 600_000)
      )
        this.records.delete(id);
    }
  }
}
