import type { ExecutionLog } from "../shared/protocol";

export interface LogEntry extends ExecutionLog {
  seq: number;
  time: string;
  source: "server" | "client" | "audit";
  channel: string;
  playerId?: number;
  executionId?: string;
}
export interface LogFilter {
  after?: number;
  limit?: number;
  source?: LogEntry["source"];
  contains?: string;
  playerId?: number;
  executionId?: string;
  channel?: string;
  level?: ExecutionLog["level"];
}
export class LogBuffer {
  private entries: LogEntry[] = [];
  private sequence = 0;
  constructor(private readonly capacity = 1000) {}
  add(entry: Omit<LogEntry, "seq" | "time">): void {
    const message = entry.message.slice(0, 4096);
    this.entries.push({
      ...entry,
      message,
      seq: ++this.sequence,
      time: new Date().toISOString(),
    });
    if (this.entries.length > this.capacity)
      this.entries.splice(0, this.entries.length - this.capacity);
  }
  read(filter: LogFilter = {}) {
    const limit = Math.min(200, Math.max(1, filter.limit ?? 50));
    const selected = this.entries.filter(
      (entry) =>
        entry.seq > (filter.after ?? 0) &&
        (!filter.source || entry.source === filter.source) &&
        (filter.playerId === undefined || entry.playerId === filter.playerId) &&
        (filter.executionId === undefined ||
          entry.executionId === filter.executionId) &&
        (filter.channel === undefined || entry.channel === filter.channel) &&
        (filter.level === undefined || entry.level === filter.level) &&
        (!filter.contains ||
          entry.message.toLowerCase().includes(filter.contains.toLowerCase())),
    );
    const lines =
      filter.after === undefined
        ? selected.slice(-limit)
        : selected.slice(0, limit);
    return {
      lines,
      nextCursor: lines.at(-1)?.seq ?? this.sequence,
      oldestCursor: this.entries[0]?.seq ?? this.sequence,
      dropped:
        filter.after !== undefined &&
        filter.after < (this.entries[0]?.seq ?? 1) - 1,
      hasMore: filter.after !== undefined && selected.length > limit,
    };
  }
}
