import type { NextFunction, Request, RequestHandler, Response } from "express";

export interface RateLimitConfig {
  max: number;
  windowMs: number;
}

export const TOKEN_RATE_LIMIT: RateLimitConfig = { max: 60, windowMs: 60 * 1000 };
export const LOGIN_RATE_LIMIT: RateLimitConfig = { max: 10, windowMs: 5 * 60 * 1000 };
export const REVOKE_RATE_LIMIT: RateLimitConfig = { max: 30, windowMs: 60 * 1000 };

interface Bucket {
  count: number;
  resetAt: number;
}

export interface RateLimiter {
  /** Cuenta un intento. Devuelve los segundos a esperar si se excedió, o null si pasa. */
  hit(key: string, now?: number): number | null;
}

// Ventana fija en memoria (una sola instancia, igual que el store de códigos).
export function createRateLimiter(config: RateLimitConfig): RateLimiter {
  const buckets = new Map<string, Bucket>();
  return {
    hit(key, now = Date.now()) {
      for (const [k, b] of buckets) {
        if (now >= b.resetAt) buckets.delete(k);
      }
      let bucket = buckets.get(key);
      if (!bucket) {
        bucket = { count: 0, resetAt: now + config.windowMs };
        buckets.set(key, bucket);
      }
      bucket.count += 1;
      if (bucket.count > config.max) return Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
      return null;
    },
  };
}

// La clave es req.ip, que depende de la configuración `trust proxy` de src/index.ts: con `true`
// es el primer valor de X-Forwarded-For. Si la topología cambia, revisar esta clave.
export function rateLimitMiddleware(
  limiter: RateLimiter,
  onLimit: (req: Request, res: Response, retryAfterSeconds: number) => void
): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const retryAfter = limiter.hit(req.ip ?? "unknown");
    if (retryAfter === null) {
      next();
      return;
    }
    onLimit(req, res, retryAfter);
  };
}
