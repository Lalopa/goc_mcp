import type { Express } from "express";

export const DEFAULT_TRUST_PROXY_HOPS = 1;

// Número de proxies de confianza delante del MCP. Entero >= 0; cualquier otro valor (vacío, negativo,
// decimal, texto) cae al valor por defecto.
export function parseTrustProxyHops(raw: string | undefined): number {
  if (raw === undefined || !/^\d{1,3}$/.test(raw.trim())) return DEFAULT_TRUST_PROXY_HOPS;
  return Number(raw.trim());
}

export function configureTrustProxy(app: Express, raw: string | undefined): void {
  app.set("trust proxy", parseTrustProxyHops(raw));
}
