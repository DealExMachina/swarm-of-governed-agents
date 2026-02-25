/**
 * Finality certificates: sign and verify FinalityCertificatePayload as JWS (Ed25519).
 * Persist to finality_certificates table; optional GET endpoint for verification.
 */

import {
  sign as cryptoSign,
  verify as cryptoVerify,
  generateKeyPairSync,
  createPrivateKey,
  createPublicKey,
  type KeyObject,
} from "crypto";
import type { FinalityCertificatePayload } from "./finalityEvaluator.js";
import { getGovernancePolicyVersion, getFinalityPolicyVersion } from "./policyVersions.js";
import { getPool } from "./db.js";
import type pg from "pg";

const ALG = "ed25519";
const PAYLOAD_SEPARATOR = ".";

/** Build payload for signing. Fills policy_version_hashes from current config when not provided. */
export function buildCertificatePayload(
  scopeId: string,
  decision: FinalityCertificatePayload["decision"],
  options?: {
    dimensions_snapshot?: Record<string, number>;
    policy_version_hashes?: { governance?: string; finality?: string };
  },
): FinalityCertificatePayload {
  const timestamp = new Date().toISOString();
  const policy_version_hashes = options?.policy_version_hashes ?? {
    governance: getGovernancePolicyVersion(),
    finality: getFinalityPolicyVersion(),
  };
  return {
    scope_id: scopeId,
    decision,
    timestamp,
    policy_version_hashes,
    dimensions_snapshot: options?.dimensions_snapshot,
  };
}

let _ephemeralKeys: { publicKey: KeyObject; privateKey: KeyObject } | null = null;

function getSigningKey(): { publicKey: KeyObject | null; privateKey: KeyObject } {
  const pem = process.env.FINALITY_CERT_PRIVATE_KEY_PEM;
  if (pem) {
    const privateKey = createPrivateKey(pem);
    const pubPem = process.env.FINALITY_CERT_PUBLIC_KEY_PEM;
    const publicKey = pubPem ? createPublicKey(pubPem) : null;
    return { privateKey, publicKey };
  }
  if (!_ephemeralKeys) _ephemeralKeys = generateKeyPairSync(ALG);
  return { privateKey: _ephemeralKeys.privateKey, publicKey: _ephemeralKeys.publicKey };
}

/**
 * Sign payload as compact JWS (base64url.header.payload.signature).
 * Uses Ed25519; key from FINALITY_CERT_PRIVATE_KEY_PEM or ephemeral.
 */
export function signCertificate(payload: FinalityCertificatePayload): string {
  const header = { alg: "EdDSA", typ: "JWS" };
  const payloadJson = JSON.stringify(payload);
  const b64Header = Buffer.from(JSON.stringify(header)).toString("base64url");
  const b64Payload = Buffer.from(payloadJson).toString("base64url");
  const toSign = `${b64Header}.${b64Payload}`;
  const { privateKey } = getSigningKey();
  const sig = cryptoSign(null, Buffer.from(toSign, "utf-8"), privateKey);
  const b64Sig = sig.toString("base64url");
  return `${toSign}.${b64Sig}`;
}

/**
 * Verify compact JWS and return payload. Throws if invalid.
 * Uses FINALITY_CERT_PUBLIC_KEY_PEM when set; with ephemeral key, verification uses same in-process key.
 */
export function verifyCertificate(jws: string): FinalityCertificatePayload {
  const parts = jws.split(PAYLOAD_SEPARATOR);
  if (parts.length !== 3) throw new Error("Invalid JWS: expected 3 parts");
  const [b64Header, b64Payload, b64Sig] = parts;
  const toVerify = `${b64Header}.${b64Payload}`;
  const sig = Buffer.from(b64Sig, "base64url");
  const { publicKey } = getSigningKey();
  if (!publicKey) throw new Error("FINALITY_CERT_PUBLIC_KEY_PEM required for verification");
  if (!cryptoVerify(null, Buffer.from(toVerify, "utf-8"), publicKey, sig)) {
    throw new Error("JWS signature verification failed");
  }
  const payloadJson = Buffer.from(b64Payload, "base64url").toString("utf-8");
  return JSON.parse(payloadJson) as FinalityCertificatePayload;
}

/** Persist certificate to finality_certificates table. */
export async function persistCertificate(
  scopeId: string,
  jws: string,
  payload: FinalityCertificatePayload,
  pool?: pg.Pool,
): Promise<void> {
  const p = pool ?? getPool();
  await p.query(
    `INSERT INTO finality_certificates (scope_id, certificate_jws, payload) VALUES ($1, $2, $3::jsonb)`,
    [scopeId, jws, JSON.stringify(payload)],
  );
}

/** Load latest certificate for scope. Returns null if none. */
export async function getLatestCertificate(
  scopeId: string,
  pool?: pg.Pool,
): Promise<{ certificate_jws: string; payload: FinalityCertificatePayload } | null> {
  const p = pool ?? getPool();
  const res = await p.query(
    `SELECT certificate_jws, payload FROM finality_certificates WHERE scope_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [scopeId],
  );
  if (res.rows.length === 0) return null;
  const row = res.rows[0];
  return {
    certificate_jws: row.certificate_jws,
    payload: typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload,
  };
}
