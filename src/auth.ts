import type { IncomingMessage, ServerResponse } from "http";

const SWARM_API_TOKEN = process.env.SWARM_API_TOKEN;
const DISABLE_AUTH = process.env.DISABLE_FEED_AUTH === "1" || process.env.DISABLE_AUTH === "1";

/**
 * Check Authorization: Bearer <token> against SWARM_API_TOKEN.
 * If SWARM_API_TOKEN is unset and DISABLE_FEED_AUTH=1 (or DISABLE_AUTH=1), allows the request.
 * Returns true if authorized, false if not (and sends 401).
 */
export function requireBearer(req: IncomingMessage, res: ServerResponse): boolean {
  if (DISABLE_AUTH || !SWARM_API_TOKEN) {
    return true;
  }
  const auth = req.headers.authorization;
  const token = auth?.startsWith("Bearer ") ? auth.slice(7).trim() : null;
  if (!token || token !== SWARM_API_TOKEN) {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "unauthorized", message: "Missing or invalid Authorization header" }));
    return false;
  }
  return true;
}
