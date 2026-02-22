import { randomUUID } from "crypto";

/**
 * Unified event envelope for all events across NATS and the context WAL.
 * Enables traceability and correlation.
 */
export interface SwarmEvent extends Record<string, unknown> {
  id: string;
  type: string;
  ts: string;
  source: string;
  correlation_id: string;
  payload: Record<string, unknown>;
}

export function createSwarmEvent(
  type: string,
  payload: Record<string, unknown>,
  opts?: { source?: string; correlation_id?: string; id?: string; ts?: string },
): SwarmEvent {
  return {
    id: opts?.id ?? randomUUID(),
    type,
    ts: opts?.ts ?? new Date().toISOString(),
    source: opts?.source ?? "system",
    correlation_id: opts?.correlation_id ?? "",
    payload,
  };
}

/**
 * Type guard: true if the value has the shape of a SwarmEvent (id, type, ts, source, correlation_id, payload).
 */
export function isSwarmEvent(data: Record<string, unknown>): data is SwarmEvent {
  return (
    typeof data.id === "string" &&
    typeof data.type === "string" &&
    typeof data.ts === "string" &&
    typeof data.source === "string" &&
    "correlation_id" in data &&
    typeof data.payload === "object" &&
    data.payload !== null
  );
}

/** Suggested state change requiring approval (emitted by worker agents). */
export interface Proposal {
  proposal_id: string;
  agent: string;
  proposed_action: string;
  target_node: string;
  payload: Record<string, unknown>;
  mode: "YOLO" | "MITL" | "MASTER";
}

/** Decision from governance: approved or rejected. */
export interface Action {
  proposal_id: string;
  approved_by: string;
  result: "approved" | "rejected";
  reason: string;
  /** e.g. "advance_state" */
  action_type?: string;
  payload?: Record<string, unknown>;
}
