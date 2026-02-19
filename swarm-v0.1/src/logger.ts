import { trace } from "@opentelemetry/api";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

let _minLevel: LogLevel = (process.env.LOG_LEVEL as LogLevel) ?? "info";
let _context: Record<string, unknown> = {};

export function setLogContext(ctx: Record<string, unknown>): void {
  _context = { ..._context, ...ctx };
}

export function setLogLevel(level: LogLevel): void {
  _minLevel = level;
}

function shouldLog(level: LogLevel): boolean {
  return LEVEL_RANK[level] >= LEVEL_RANK[_minLevel];
}

export interface LogEntry {
  ts: string;
  level: LogLevel;
  msg: string;
  [key: string]: unknown;
}

function emit(level: LogLevel, msg: string, extra?: Record<string, unknown>): void {
  if (!shouldLog(level)) return;
  const ctx = trace.getActiveSpan()?.spanContext();
  const entry: LogEntry = {
    ts: new Date().toISOString(),
    level,
    msg,
    ..._context,
    ...(ctx?.traceId && { trace_id: ctx.traceId }),
    ...(ctx?.spanId && { span_id: ctx.spanId }),
    ...extra,
  };
  const line = JSON.stringify(entry);
  if (level === "error") {
    process.stderr.write(line + "\n");
  } else {
    process.stdout.write(line + "\n");
  }
}

export const logger = {
  debug: (msg: string, extra?: Record<string, unknown>) => emit("debug", msg, extra),
  info: (msg: string, extra?: Record<string, unknown>) => emit("info", msg, extra),
  warn: (msg: string, extra?: Record<string, unknown>) => emit("warn", msg, extra),
  error: (msg: string, extra?: Record<string, unknown>) => emit("error", msg, extra),
};
