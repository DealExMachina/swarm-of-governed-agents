/**
 * Singleton EventBus for the feed server.
 */

import { makeEventBus, type EventBus } from "../eventBus.js";

let _feedBus: EventBus | null = null;

export async function getFeedBus(): Promise<EventBus> {
  if (!_feedBus) {
    _feedBus = await makeEventBus();
    await _feedBus.ensureStream(
      process.env.NATS_STREAM ?? "SWARM_JOBS",
      ["swarm.events.>"],
    );
  }
  return _feedBus;
}
