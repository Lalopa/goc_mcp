import type { NextFunction, Request, RequestHandler, Response } from "express";

export interface RateLimitConfig {
  max: number;
  windowMs: number;
}

export const TOKEN_RATE_LIMIT: RateLimitConfig = { max: 60, windowMs: 60 * 1000 };
export const LOGIN_RATE_LIMIT: RateLimitConfig = { max: 10, windowMs: 5 * 60 * 1000 };
export const REVOKE_RATE_LIMIT: RateLimitConfig = { max: 30, windowMs: 60 * 1000 };

/** Tope de claves (cubos) por limitador: acota la memoria y el costo de cada barrida. */
export const MAX_RATE_LIMIT_KEYS = 10_000;
/** Con el Map lleno se permite barrer a lo sumo una vez por este intervalo. */
export const FULL_SWEEP_MIN_INTERVAL_MS = 1000;

export interface Bucket {
  count: number;
  resetAt: number;
}

export interface RateLimiter {
  /** Cuenta un intento. Devuelve los segundos a esperar si se excedió, o null si pasa. */
  hit(key: string, now?: number): number | null;
  /** Cubos vivos en memoria (observabilidad y tests). */
  size(): number;
}

export interface RateLimiterOptions {
  maxKeys?: number;
  /** Inyectable para observar cuántas veces se recorre. */
  store?: Map<string, Bucket>;
}

// Ventana fija en memoria (una sola instancia, igual que el store de códigos).
// - La barrida de vencidos ocurre a lo sumo una vez por ventana, no en cada hit.
// - El Map nunca pasa de `maxKeys`: con el Map lleno una clave nueva se responde como excedida y no crea
//   cubo (con claves rotadas, quien ataca se frena a sí mismo; una clave ya existente sigue contando).
export function createRateLimiter(config: RateLimitConfig, options: RateLimiterOptions = {}): RateLimiter {
  const buckets = options.store ?? new Map<string, Bucket>();
  const maxKeys = options.maxKeys ?? MAX_RATE_LIMIT_KEYS;
  let lastSweepAt: number | null = null;

  function sweep(now: number): void {
    for (const [key, bucket] of buckets) {
      if (now >= bucket.resetAt) buckets.delete(key);
    }
    lastSweepAt = now;
  }

  const retryAfter = (resetAt: number, now: number) => Math.max(1, Math.ceil((resetAt - now) / 1000));

  return {
    size: () => buckets.size,
    hit(key, now = Date.now()) {
      if (lastSweepAt === null) lastSweepAt = now;
      else if (now - lastSweepAt >= config.windowMs) sweep(now);

      let bucket = buckets.get(key);
      if (bucket && now >= bucket.resetAt) {
        buckets.delete(key);
        bucket = undefined;
      }
      if (!bucket) {
        if (buckets.size >= maxKeys && now - (lastSweepAt ?? now) >= FULL_SWEEP_MIN_INTERVAL_MS) sweep(now);
        if (buckets.size >= maxKeys) return Math.max(1, Math.ceil(config.windowMs / 1000));
        bucket = { count: 0, resetAt: now + config.windowMs };
        buckets.set(key, bucket);
      }
      bucket.count += 1;
      return bucket.count > config.max ? retryAfter(bucket.resetAt, now) : null;
    },
  };
}

// La clave es req.ip. Su valor depende de `trust proxy` (src/index.ts, variable TRUST_PROXY_HOPS, por
// defecto 1 salto: EC2 + nginx): con N saltos Express toma la IP que el N-ésimo proxy de confianza vio
// conectarse, y lo que el cliente escriba en X-Forwarded-For a su izquierda no cuenta. Si el número de
// saltos no coincide con el despliegue, o la IP del cliente es falsificable (más saltos reales que
// configurados) o todos comparten la del proxy (menos).
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
