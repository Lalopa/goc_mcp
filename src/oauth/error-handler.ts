import type { NextFunction, Request, Response } from "express";
import { oauthError, unavailable } from "./responses.js";

// Errores de express.json()/urlencoded() (JSON mal formado, cuerpo demasiado grande…) en /oauth/*: sin
// este manejador salen como HTML de finalhandler, y un cliente OAuth no sabe interpretarlo.
// body-parser adjunta el cuerpo crudo en `err.body` (puede llevar tokens): ni el cuerpo ni el error se
// registran ni se devuelven; solo el código de estado.
export function createOauthErrorHandler(log: (message: string) => void = (m) => console.warn(m)) {
  return (err: unknown, req: Request, res: Response, next: NextFunction): void => {
    if (!req.path.startsWith("/oauth/") || res.headersSent) {
      next(err);
      return;
    }
    const status = (err as { status?: unknown } | null)?.status;
    if (typeof status === "number" && status >= 400 && status < 500) {
      log(`oauth: cuerpo de petición inválido status=${status}`);
      oauthError(res, 400, "invalid_request", "Invalid request body");
      return;
    }
    log("oauth: error inesperado fuera de los handlers");
    unavailable(res);
  };
}
