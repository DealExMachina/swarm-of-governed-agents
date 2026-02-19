/**
 * Safe error serialization to avoid logging huge objects (e.g. pg Client, sockets).
 */

export function toErrorString(e: unknown): string {
  if (e === null) return "null";
  if (e === undefined) return "undefined";
  if (e instanceof Error) {
    const code = "code" in e ? String((e as Error & { code?: string }).code) : "";
    return e.message + (code ? ` [${code}]` : "");
  }
  if (typeof e === "object" && "message" in e) return String((e as { message: unknown }).message);
  return String(e);
}
