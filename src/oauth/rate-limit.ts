import type { NextFunction, Request, RequestHandler, Response } from "express";

export interface RateLimitConfig {
  max: number;
  windowMs: number;
}

export const TOKEN_RATE_LIMIT: RateLimitConfig = { max: 60, windowMs: 60 * 1000 };
export const LOGIN_RATE_LIMIT: RateLimitConfig = { max: 10, windowMs: 5 * 60 * 1000 };
export const REVOKE_RATE_LIMIT: RateLimitConfig = { max: 30, windowMs: 60 * 1000 };
/** La página de login es anónima y cada visita puede costar una consulta de cliente a la API. */
export const AUTHORIZE_RATE_LIMIT: RateLimitConfig = { max: 60, windowMs: 60 * 1000 };
/** El registro es anónimo y escribe en la API (que limita a 60/min por IP, compartida por todo el MCP). */
export const REGISTER_RATE_LIMIT: RateLimitConfig = { max: 20, windowMs: 10 * 60 * 1000 };

/** Tope de claves (cubos) por limitador: acota la memoria. */
export const MAX_RATE_LIMIT_KEYS = 10_000;

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
  /** Aviso de Map lleno (como mucho uno por ventana). Sin claves ni IPs. */
  onFull?: () => void;
}

// Ventana fija en memoria (una sola instancia, igual que el store de códigos).
//
// Invariante: el orden de inserción del Map es el orden de `resetAt`. Un cubo solo se inserta con
// `resetAt = now + windowMs` (con `now` creciente) y nunca se modifica su `resetAt`; el cubo propio
// vencido se BORRA y se vuelve a insertar (un `set` sobre una clave existente conservaría su posición
// antigua y rompería el orden). Por eso:
// - la barrida de vencidos solo mira el principio del Map y se detiene en el primer cubo vigente
//   (costo proporcional a lo que borra, no al tamaño del Map);
// - con el Map lleno se desaloja el primero, que es el que vence antes (O(1)), y se admite la clave
//   nueva: quien rote claves no puede dejar sin servicio a los demás, solo reinicia cubos antiguos.
export function createRateLimiter(config: RateLimitConfig, options: RateLimiterOptions = {}): RateLimiter {
  const buckets = options.store ?? new Map<string, Bucket>();
  const maxKeys = options.maxKeys ?? MAX_RATE_LIMIT_KEYS;
  const onFull = options.onFull ?? (() => console.warn("oauth: limitador de tasa lleno; se desalojan los cubos más antiguos"));
  let lastFullLogAt: number | null = null;

  function sweep(now: number): void {
    for (const [key, bucket] of buckets) {
      if (now < bucket.resetAt) break;
      buckets.delete(key);
    }
  }

  const retryAfter = (resetAt: number, now: number) => Math.max(1, Math.ceil((resetAt - now) / 1000));

  return {
    size: () => buckets.size,
    hit(key, now = Date.now()) {
      sweep(now);

      let bucket = buckets.get(key);
      if (bucket && now >= bucket.resetAt) {
        buckets.delete(key);
        bucket = undefined;
      }
      if (!bucket) {
        if (buckets.size >= maxKeys) {
          const oldest = buckets.keys().next();
          if (!oldest.done) buckets.delete(oldest.value);
          if (lastFullLogAt === null || now - lastFullLogAt >= config.windowMs) {
            lastFullLogAt = now;
            onFull();
          }
        }
        bucket = { count: 0, resetAt: now + config.windowMs };
        buckets.set(key, bucket);
      }
      bucket.count += 1;
      return bucket.count > config.max ? retryAfter(bucket.resetAt, now) : null;
    },
  };
}

// La clave es req.ip. Su valor depende de `trust proxy` (src/app.ts, variable TRUST_PROXY_HOPS, por
// defecto 1 salto: EC2 + nginx). Con N saltos Express toma la N-ésima dirección contando desde la
// conexión (proxy-addr: se confía en las N primeras y se devuelve la siguiente). Si el número no
// coincide con el despliegue:
// - más saltos REALES que configurados: req.ip es la IP de un proxy exterior y todos los clientes la
//   comparten (un solo cubo para todos);
// - menos saltos reales que configurados: req.ip es un valor que escribió el cliente en X-Forwarded-For
//   y es falsificable (el limitador se evade rotándolo).
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
