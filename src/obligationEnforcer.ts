/**
 * Obligation enforcer: executes mandatory or advisory obligations after a governance decision.
 * Phase 0: skeleton with registry and execute stub. Phase 2: real handlers (dual_review, etc.).
 */

import type { Obligation } from "./policyEngine.js";

export type ObligationHandler = (obligation: Obligation) => Promise<void>;

const registry = new Map<string, ObligationHandler>();

/**
 * Register a handler for an obligation type. Overwrites existing handler for that type.
 */
export function registerObligationHandler(type: string, handler: ObligationHandler): void {
  registry.set(type, handler);
}

/**
 * Execute a single obligation. No-op if no handler is registered (stub behaviour).
 */
export async function executeObligation(obligation: Obligation): Promise<void> {
  const handler = registry.get(obligation.type);
  if (handler) {
    await handler(obligation);
  }
  // Stub: unregistered obligation types are logged but not executed
}

/**
 * Execute all obligations from a decision. Runs in sequence; failures are logged and do not stop the rest.
 */
export async function executeObligations(obligations: Obligation[]): Promise<void> {
  for (const ob of obligations) {
    try {
      await executeObligation(ob);
    } catch (err) {
      // Log and continue; full error handling in Phase 2
      console.error(`Obligation ${ob.type} failed:`, err);
    }
  }
}

/**
 * List registered obligation types (for tests and debugging).
 */
export function getRegisteredObligationTypes(): string[] {
  return Array.from(registry.keys());
}
