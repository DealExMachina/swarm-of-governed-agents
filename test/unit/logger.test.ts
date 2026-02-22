import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { logger, setLogContext, setLogLevel, type LogEntry } from "../../src/logger";

describe("logger", () => {
  let stdoutLines: string[];
  let stderrLines: string[];
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stdoutLines = [];
    stderrLines = [];
    stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: any) => {
      stdoutLines.push(typeof chunk === "string" ? chunk : chunk.toString());
      return true;
    });
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: any) => {
      stderrLines.push(typeof chunk === "string" ? chunk : chunk.toString());
      return true;
    });
    setLogLevel("debug");
    setLogContext({});
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  it("outputs valid JSON with required fields", () => {
    logger.info("hello world");
    expect(stdoutLines).toHaveLength(1);

    const entry = JSON.parse(stdoutLines[0]) as LogEntry;
    expect(entry.ts).toBeDefined();
    expect(entry.level).toBe("info");
    expect(entry.msg).toBe("hello world");
  });

  it("includes extra fields", () => {
    logger.info("with context", { job_id: "abc", duration_ms: 42 });
    const entry = JSON.parse(stdoutLines[0]) as LogEntry;
    expect(entry.job_id).toBe("abc");
    expect(entry.duration_ms).toBe(42);
  });

  it("includes persistent context from setLogContext", () => {
    setLogContext({ agent_id: "facts-1", role: "facts" });
    logger.info("tagged");
    const entry = JSON.parse(stdoutLines[0]) as LogEntry;
    expect(entry.agent_id).toBe("facts-1");
    expect(entry.role).toBe("facts");
  });

  it("sends error level to stderr", () => {
    logger.error("bad thing");
    expect(stdoutLines).toHaveLength(0);
    expect(stderrLines).toHaveLength(1);

    const entry = JSON.parse(stderrLines[0]) as LogEntry;
    expect(entry.level).toBe("error");
  });

  it("respects log level filtering", () => {
    setLogLevel("warn");
    logger.debug("hidden");
    logger.info("also hidden");
    logger.warn("visible");
    logger.error("also visible");

    expect(stdoutLines).toHaveLength(1);
    expect(stderrLines).toHaveLength(1);
  });

  it("writes all four log levels", () => {
    logger.debug("d");
    logger.info("i");
    logger.warn("w");
    logger.error("e");

    expect(stdoutLines).toHaveLength(3);
    expect(stderrLines).toHaveLength(1);

    expect(JSON.parse(stdoutLines[0]).level).toBe("debug");
    expect(JSON.parse(stdoutLines[1]).level).toBe("info");
    expect(JSON.parse(stdoutLines[2]).level).toBe("warn");
    expect(JSON.parse(stderrLines[0]).level).toBe("error");
  });
});
