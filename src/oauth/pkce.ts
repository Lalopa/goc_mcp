import { createHash, timingSafeEqual } from "node:crypto";

// S256 produce SHA-256 en base64url sin padding: siempre 43 caracteres.
const CODE_CHALLENGE = /^[A-Za-z0-9_-]{43}$/;
// RFC 7636 §4.1.
const CODE_VERIFIER = /^[A-Za-z0-9\-._~]{43,128}$/;

export const CODE_CHALLENGE_METHOD = "S256";

export function isValidCodeChallenge(value: unknown): value is string {
  return typeof value === "string" && CODE_CHALLENGE.test(value);
}

export function isValidCodeVerifier(value: unknown): value is string {
  return typeof value === "string" && CODE_VERIFIER.test(value);
}

/** `sha256(verifier)` en base64url contra el challenge guardado, en tiempo constante. */
export function verifyPkce(verifier: unknown, challenge: string): boolean {
  if (!isValidCodeVerifier(verifier)) return false;
  const computed = Buffer.from(createHash("sha256").update(verifier).digest("base64url"));
  const expected = Buffer.from(challenge);
  return computed.length === expected.length && timingSafeEqual(computed, expected);
}
