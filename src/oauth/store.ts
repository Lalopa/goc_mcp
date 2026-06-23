import { randomUUID } from "crypto";

interface AuthCodeEntry {
  jwt: string;
  gocRefreshToken: string;
  redirect_uri: string;
  expiry: number;
}

const codeStore = new Map<string, AuthCodeEntry>();
const CODE_TTL_MS = 5 * 60 * 1000;

export function createCode(jwt: string, gocRefreshToken: string, redirect_uri: string): string {
  const code = randomUUID();
  codeStore.set(code, { jwt, gocRefreshToken, redirect_uri, expiry: Date.now() + CODE_TTL_MS });
  return code;
}

export function redeemCode(code: string, redirect_uri: string): { jwt: string; gocRefreshToken: string } | null {
  const entry = codeStore.get(code);
  if (!entry) return null;
  codeStore.delete(code);
  if (Date.now() > entry.expiry) return null;
  if (entry.redirect_uri !== redirect_uri) return null;
  return { jwt: entry.jwt, gocRefreshToken: entry.gocRefreshToken };
}

export function generateRefreshToken(): string {
  return randomUUID();
}
