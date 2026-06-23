import { randomUUID } from "crypto";

interface AuthCodeEntry {
  jwt: string;
  redirect_uri: string;
  expiry: number;
}

const store = new Map<string, AuthCodeEntry>();

const TTL_MS = 5 * 60 * 1000;

export function createCode(jwt: string, redirect_uri: string): string {
  const code = randomUUID();
  store.set(code, { jwt, redirect_uri, expiry: Date.now() + TTL_MS });
  return code;
}

export function redeemCode(code: string, redirect_uri: string): string | null {
  const entry = store.get(code);
  if (!entry) return null;
  store.delete(code);
  if (Date.now() > entry.expiry) return null;
  if (entry.redirect_uri !== redirect_uri) return null;
  return entry.jwt;
}
