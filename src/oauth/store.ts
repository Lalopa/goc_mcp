import { randomUUID } from "crypto";
import { verifyPkce } from "./pkce.js";

export interface AuthCodeEntry {
  jwt: string;
  gocRefreshToken: string;
  redirect_uri: string;
  client_id: string;
  code_challenge: string;
}

interface StoredCode extends AuthCodeEntry {
  expiry: number;
}

export interface PresentedGrant {
  redirect_uri: string;
  client_id: string;
  code_verifier: string;
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

// Un solo uso: el código se borra antes de validar nada más. Cualquier fallo (vencido, otra redirect_uri,
// otro cliente, verificador incorrecto) devuelve null sin distinguir el motivo.
export function redeemCode(code: string, presented: PresentedGrant, now: number = Date.now()): AuthCodeEntry | null {
  const entry = codeStore.get(code);
  if (!entry) return null;
  codeStore.delete(code);
  if (now > entry.expiry) return null;
  if (entry.redirect_uri !== presented.redirect_uri) return null;
  if (entry.client_id !== presented.client_id) return null;
  if (!verifyPkce(presented.code_verifier, entry.code_challenge)) return null;
  return {
    jwt: entry.jwt,
    gocRefreshToken: entry.gocRefreshToken,
    redirect_uri: entry.redirect_uri,
    client_id: entry.client_id,
    code_challenge: entry.code_challenge,
  };
}

export function pendingCodeCount(): number {
  return codeStore.size;
}
