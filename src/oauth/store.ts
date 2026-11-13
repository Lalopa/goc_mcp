import { randomUUID } from "crypto";

export interface AuthCodeEntry {
  jwt: string;
  gocRefreshToken: string;
  redirect_uri: string;
}

interface StoredCode extends AuthCodeEntry {
  expiry: number;
}

const codeStore = new Map<string, StoredCode>();
export const CODE_TTL_MS = 5 * 60 * 1000;

function sweepExpired(now: number): void {
  for (const [code, entry] of codeStore) {
    if (now > entry.expiry) codeStore.delete(code);
  }
}

export function createCode(entry: AuthCodeEntry, now: number = Date.now()): string {
  sweepExpired(now);
  const code = randomUUID();
  codeStore.set(code, { ...entry, expiry: now + CODE_TTL_MS });
  return code;
}

// Un solo uso: el código se borra antes de validar nada más.
export function redeemCode(
  code: string,
  presented: { redirect_uri: string },
  now: number = Date.now()
): AuthCodeEntry | null {
  const entry = codeStore.get(code);
  if (!entry) return null;
  codeStore.delete(code);
  if (now > entry.expiry) return null;
  if (entry.redirect_uri !== presented.redirect_uri) return null;
  return { jwt: entry.jwt, gocRefreshToken: entry.gocRefreshToken, redirect_uri: entry.redirect_uri };
}

export function pendingCodeCount(): number {
  return codeStore.size;
}
