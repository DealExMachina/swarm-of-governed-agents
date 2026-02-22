/**
 * OpenFGA policy client: check whether an agent can perform an action on a target (node).
 * Falls back to allow-all when OpenFGA is unreachable if OPENFGA_ALLOW_IF_UNAVAILABLE=1.
 */

function getConfig() {
  return {
    url: process.env.OPENFGA_URL ?? "http://localhost:8080",
    storeId: process.env.OPENFGA_STORE_ID ?? "",
    modelId: process.env.OPENFGA_MODEL_ID ?? "",
    allowIfUnavailable: process.env.OPENFGA_ALLOW_IF_UNAVAILABLE === "1",
  };
}

export interface CheckResult {
  allowed: boolean;
  error?: string;
}

/**
 * Check if agent can perform relation on target (e.g. agent:facts-1, writer, node:FactsExtracted).
 * Returns { allowed: true } if OpenFGA says yes; { allowed: false } if no or error (unless ALLOW_IF_UNAVAILABLE).
 */
export async function checkPermission(
  agent: string,
  relation: string,
  target: string,
): Promise<CheckResult> {
  const { storeId, modelId, url, allowIfUnavailable } = getConfig();
  if (!storeId) {
    return { allowed: true, error: "OPENFGA_STORE_ID not set (allow by default)" };
  }

  const user = agent.startsWith("agent:") ? agent : `agent:${agent}`;
  const object = target.startsWith("node:") ? target : `node:${target}`;

  const checkUrl = `${url}/stores/${storeId}/check`;
  const body: Record<string, string> = {
    user,
    relation,
    object,
  };
  if (modelId) body.authorization_model_id = modelId;

  try {
    const res = await fetch(checkUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      if (allowIfUnavailable) return { allowed: true };
      return { allowed: false, error: `OpenFGA ${res.status}: ${text}` };
    }
    const data = (await res.json()) as { allowed?: boolean };
    return { allowed: data.allowed === true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (allowIfUnavailable) return { allowed: true };
    return { allowed: false, error: msg };
  }
}
