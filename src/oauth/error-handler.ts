import type { NextFunction, Request, Response } from "express";
import { INVALID_REQUEST_PAGE_TEXT, UNAVAILABLE_PAGE_TEXT, renderErrorPage } from "./error-page.js";
import { noStore, oauthError, unavailable } from "./responses.js";

// Rutas que abre una persona en el navegador: ahí un error se muestra como página, no como JSON.
const BROWSER_PATHS = new Set(["/oauth/authorize", "/oauth/login-action"]);

// Solo identificadores cortos y seguros (p. ej. "SyntaxError", "entity.parse.failed"): nunca el mensaje
// del error, que en un JSON.parse fallido contiene parte del cuerpo (puede llevar tokens).
function safeTag(value: unknown): string {
  return typeof value === "string" && /^[\w.\-]{1,64}$/.test(value) ? value : "n/a";
}

function describe(err: unknown): string {
  const e = (err ?? {}) as { name?: unknown; code?: unknown; type?: unknown };
  return `name=${safeTag(e.name)} code=${safeTag(e.code ?? e.type)}`;
}

// Errores de express.json()/urlencoded() (JSON mal formado, cuerpo demasiado grande…) en /oauth/*: sin
// este manejador salen como HTML de finalhandler, y un cliente OAuth no sabe interpretarlo.
// body-parser adjunta el cuerpo crudo en `err.body` (puede llevar tokens): ni el cuerpo, ni el mensaje ni
// el error se registran ni se devuelven; solo el estado, el nombre y el código/tipo.
export function createOauthErrorHandler(log: (message: string) => void = (m) => console.warn(m)) {
  return (err: unknown, req: Request, res: Response, next: NextFunction): void => {
    if (!req.path.startsWith("/oauth/") || res.headersSent) {
      next(err);
      return;
    }
    const browser = BROWSER_PATHS.has(req.path);
    const status = (err as { status?: unknown } | null)?.status;
    if (typeof status === "number" && status >= 400 && status < 500) {
      log(`oauth: cuerpo de petición inválido status=${status} ${describe(err)}`);
      if (browser) {
        noStore(res);
        res.status(400).send(renderErrorPage(INVALID_REQUEST_PAGE_TEXT));
      } else {
        oauthError(res, 400, "invalid_request", "Invalid request body");
      }
      return;
    }
    log(`oauth: error inesperado fuera de los handlers ${describe(err)}`);
    if (browser) {
      noStore(res);
      res.status(503).send(renderErrorPage(UNAVAILABLE_PAGE_TEXT));
    } else {
      unavailable(res);
    }
  };
}
