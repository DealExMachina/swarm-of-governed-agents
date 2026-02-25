import { describe, it, expect } from "vitest";
import {
  buildCertificatePayload,
  signCertificate,
  verifyCertificate,
} from "../../src/finalityCertificates";
import type { FinalityCertificatePayload } from "../../src/finalityEvaluator";

describe("finalityCertificates", () => {
  it("buildCertificatePayload returns payload with scope_id, decision, timestamp", () => {
    const payload = buildCertificatePayload("scope-1", "RESOLVED");
    expect(payload.scope_id).toBe("scope-1");
    expect(payload.decision).toBe("RESOLVED");
    expect(payload.timestamp).toBeDefined();
    expect(new Date(payload.timestamp).getTime()).toBeLessThanOrEqual(Date.now() + 1000);
    expect(payload.policy_version_hashes).toBeDefined();
  });

  it("signCertificate produces compact JWS (3 parts)", () => {
    const payload: FinalityCertificatePayload = {
      scope_id: "test",
      decision: "RESOLVED",
      timestamp: new Date().toISOString(),
    };
    const jws = signCertificate(payload);
    const parts = jws.split(".");
    expect(parts.length).toBe(3);
    expect(Buffer.from(parts[0], "base64url").toString()).toContain("EdDSA");
    expect(Buffer.from(parts[1], "base64url").toString()).toContain("test");
  });

  it("verifyCertificate returns payload when signature valid", () => {
    const payload = buildCertificatePayload("scope-2", "ESCALATED", {
      dimensions_snapshot: { claim_confidence: 0.9 },
    });
    const jws = signCertificate(payload);
    const verified = verifyCertificate(jws);
    expect(verified.scope_id).toBe("scope-2");
    expect(verified.decision).toBe("ESCALATED");
    expect(verified.dimensions_snapshot?.claim_confidence).toBe(0.9);
  });

  it("verifyCertificate throws on invalid JWS", () => {
    expect(() => verifyCertificate("a.b")).toThrow("expected 3 parts");
    expect(() => verifyCertificate("a.b.c")).toThrow();
  });
});
