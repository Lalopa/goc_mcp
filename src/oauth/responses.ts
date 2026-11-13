import type { Response } from "express";

export const TEMPORARILY_UNAVAILABLE = "temporarily_unavailable";

export function noStore(res: Response): void {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Pragma", "no-cache");
}

// Las páginas HTML de /oauth/* no se enmarcan: un iframe invisible permitiría un clickjacking del login.
export function frameGuard(res: Response): void {
  res.setHeader("Content-Security-Policy", "frame-ancestors 'none'");
  res.setHeader("X-Frame-Options", "DENY");
}

export function oauthError(res: Response, status: number, error: string, description: string): void {
  noStore(res);
  res.status(status).json({ error, error_description: description });
}

export function unavailable(res: Response): void {
  oauthError(res, 503, TEMPORARILY_UNAVAILABLE, "Authorization service temporarily unavailable");
}
