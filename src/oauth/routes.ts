import { Router } from "express";
import type { Request, RequestHandler, Response } from "express";
import { renderLoginPage } from "./login-page.js";
import { createCode, redeemCode } from "./store.js";
import type { GocAuthApi } from "./goc-auth-api.js";
import { secondsUntilExpiry } from "./jwt.js";
import {
  LOGIN_RATE_LIMIT,
  REVOKE_RATE_LIMIT,
  TOKEN_RATE_LIMIT,
  createRateLimiter,
  rateLimitMiddleware,
} from "./rate-limit.js";
import type { RateLimitConfig } from "./rate-limit.js";

export interface OauthDeps {
  api: GocAuthApi;
  mcpBaseUrl: string;
  /** Metadatos del cliente OAuth para el tracking. No debe lanzar. */
  getClientMeta(clientId: string | undefined): Promise<Record<string, string>>;
  registerClient(data: {
    clientId: string;
    clientName: string;
    redirectUris: string[];
    tokenEndpointAuthMethod?: string;
  }): Promise<void>;
  /** Solo recibe mensajes sin tokens ni datos del usuario. */
  log?: (message: string) => void;
  limits?: { token?: RateLimitConfig; login?: RateLimitConfig; revoke?: RateLimitConfig };
}

const TEMPORARILY_UNAVAILABLE = "temporarily_unavailable";

function str(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function noStore(res: Response): void {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Pragma", "no-cache");
}

function oauthError(res: Response, status: number, error: string, description: string): void {
  noStore(res);
  res.status(status).json({ error, error_description: description });
}

function unavailable(res: Response): void {
  oauthError(res, 503, TEMPORARILY_UNAVAILABLE, "Authorization service temporarily unavailable");
}

export function createOauthRouter(deps: OauthDeps): Router {
  const { api, mcpBaseUrl } = deps;
  const log = deps.log ?? ((message: string) => console.warn(message));
  const router = Router();

  const tokenLimit = rateLimitMiddleware(
    createRateLimiter(deps.limits?.token ?? TOKEN_RATE_LIMIT),
    (_req, res, retryAfter) => {
      res.setHeader("Retry-After", String(retryAfter));
      oauthError(res, 429, TEMPORARILY_UNAVAILABLE, "Too many requests");
    }
  );
  const revokeLimit = rateLimitMiddleware(
    createRateLimiter(deps.limits?.revoke ?? REVOKE_RATE_LIMIT),
    (_req, res, retryAfter) => {
      res.setHeader("Retry-After", String(retryAfter));
      oauthError(res, 429, TEMPORARILY_UNAVAILABLE, "Too many requests");
    }
  );
  const loginLimit = rateLimitMiddleware(
    createRateLimiter(deps.limits?.login ?? LOGIN_RATE_LIMIT),
    (req, res, retryAfter) => {
      res.setHeader("Retry-After", String(retryAfter));
      const body = (req.body ?? {}) as Record<string, unknown>;
      const redirect_uri = str(body.redirect_uri);
      if (!redirect_uri) {
        res.status(429).send("Too many attempts");
        return;
      }
      res.redirect(
        buildUrl("/oauth/authorize", {
          redirect_uri,
          state: str(body.state),
          client_id: str(body.client_id),
          error: "Too many attempts. Please wait a few minutes and try again.",
        })
      );
    }
  );

  // Protected Resource Metadata (RFC 9728) — tells Claude where to authenticate.
  // Required by the modern MCP authorization spec so the client can re-auth on 401.
  router.get("/.well-known/oauth-protected-resource", (_req, res) => {
    res.json({
      resource: mcpBaseUrl,
      authorization_servers: [mcpBaseUrl],
      scopes_supported: ["read", "permissions:write"],
      bearer_methods_supported: ["header"],
    });
  });

  router.get("/.well-known/oauth-authorization-server", (_req, res) => {
    res.json({
      issuer: mcpBaseUrl,
      authorization_endpoint: `${mcpBaseUrl}/oauth/authorize`,
      token_endpoint: `${mcpBaseUrl}/oauth/token`,
      registration_endpoint: `${mcpBaseUrl}/oauth/register`,
      revocation_endpoint: `${mcpBaseUrl}/oauth/revoke`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      revocation_endpoint_auth_methods_supported: ["none"],
      scopes_supported: ["read", "permissions:write"],
    });
  });

  router.post("/oauth/register", async (req, res) => {
    const { redirect_uris, client_name, token_endpoint_auth_method } = (req.body ?? {}) as Record<string, unknown>;

    if (!Array.isArray(redirect_uris) || redirect_uris.length === 0) {
      res.status(400).json({ error: "invalid_client_metadata", error_description: "redirect_uris required" });
      return;
    }

    const client_id = crypto.randomUUID();
    const resolvedClientName = typeof client_name === "string" && client_name.trim()
      ? client_name.trim()
      : "MCP Client";

    try {
      await deps.registerClient({
        clientId: client_id,
        clientName: resolvedClientName,
        redirectUris: redirect_uris as string[],
        tokenEndpointAuthMethod: typeof token_endpoint_auth_method === "string"
          ? token_endpoint_auth_method
          : "none",
      });
    } catch {
      res.status(500).json({
        error: "server_error",
        error_description: "Could not persist OAuth client registration",
      });
      return;
    }

    res.status(201).json({
      client_id,
      client_name: resolvedClientName,
      redirect_uris,
      token_endpoint_auth_method: token_endpoint_auth_method ?? "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    });
  });

  router.get("/oauth/authorize", (req, res) => {
    const { redirect_uri, state, client_id, error } = req.query as Record<string, string>;

    if (!redirect_uri) {
      res.status(400).send("Missing redirect_uri");
      return;
    }

    res.send(renderLoginPage({ redirect_uri, state, client_id, error }));
  });

  router.post("/oauth/login-action", loginLimit, async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const username = str(body.username);
    const password = str(body.password);
    const redirect_uri = str(body.redirect_uri);
    const state = str(body.state);
    const client_id = str(body.client_id);

    if (!redirect_uri) {
      res.status(400).send("Missing redirect_uri");
      return;
    }

    const fail = (message: string, reason: string) => {
      // Sin usuario, contraseña ni el mensaje de la API.
      log(`oauth login fallido: ${reason}`);
      res.redirect(buildUrl("/oauth/authorize", { redirect_uri, state, client_id, error: message }));
    };

    try {
      if (!username || !password) {
        fail("Invalid credentials", "faltan credenciales");
        return;
      }

      const login = await api.login(username, password);
      if (!login.ok) {
        fail(login.message, "login rechazado");
        return;
      }

      const admin = await api.assertAdministrator(login.jwt);
      if (!admin.ok) {
        fail(
          admin.kind === "rejected" ? "Administrator access required" : "Service temporarily unavailable",
          `verificación de administrador ${admin.kind} status=${admin.status ?? "n/a"}`
        );
        return;
      }

      const code = createCode({ jwt: login.jwt, gocRefreshToken: login.gocRefreshToken, redirect_uri });
      res.redirect(buildUrl(redirect_uri, { code, state }));
    } catch {
      fail("Unexpected error", "error inesperado");
    }
  });

  router.post("/oauth/token", tokenLimit, guardJson(log, async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const grant_type = str(body.grant_type);
    const clientId = str(body.client_id);
    const caller = { ipAddress: req.ip, userAgent: req.headers["user-agent"] };

    // --- Authorization code grant ---
    if (grant_type === "authorization_code") {
      const code = str(body.code);
      const redirect_uri = str(body.redirect_uri);
      // Se valida todo antes de redimir: un request incompleto no debe quemar el código.
      if (!code || !redirect_uri || !clientId) {
        oauthError(res, 400, "invalid_request", "Missing code, redirect_uri or client_id");
        return;
      }

      const result = redeemCode(code, { redirect_uri });
      if (!result) {
        oauthError(res, 400, "invalid_grant", "Code expired or invalid");
        return;
      }

      const admin = await api.assertAdministrator(result.jwt);
      if (!admin.ok) {
        if (admin.kind === "rejected") {
          oauthError(res, 400, "invalid_grant", "Active administrator access could not be verified");
        } else {
          log(`oauth canje: verificación de administrador no disponible status=${admin.status ?? "n/a"}`);
          unavailable(res);
        }
        return;
      }

      const clientMeta = await deps.getClientMeta(clientId);
      const session = await api.createSession(result.jwt, {
        gocRefreshToken: result.gocRefreshToken,
        clientId,
        ...caller,
        metadata: clientMeta,
      });
      if (!session.ok) {
        log(`oauth canje: alta de sesión ${session.kind} status=${session.status ?? "n/a"}`);
        if (session.kind === "rejected") {
          oauthError(res, 400, "invalid_grant", "Session could not be created");
        } else {
          unavailable(res);
        }
        return;
      }

      api.logEvent(result.jwt, {
        eventType: "auth_success",
        clientId,
        description: `User authenticated via OAuth (${clientMeta.client_name ?? "unknown agent"})`,
        metadata: clientMeta,
        ...caller,
      });

      noStore(res);
      res.json({
        access_token: result.jwt,
        token_type: "Bearer",
        ...optionalExpiresIn(secondsUntilExpiry(result.jwt)),
        refresh_token: session.data.refreshToken,
      });
      return;
    }

    // --- Refresh token grant ---
    if (grant_type === "refresh_token") {
      const refreshToken = str(body.refresh_token);
      if (!refreshToken || !clientId) {
        oauthError(res, 400, "invalid_request", "Missing refresh_token or client_id");
        return;
      }

      // Sin encabezado Authorization: la credencial es el refresh token del cuerpo.
      const refreshed = await api.refreshSession({ refreshToken, clientId, ...caller });
      if (!refreshed.ok) {
        log(`oauth refresh ${refreshed.kind} status=${refreshed.status ?? "n/a"}`);
        if (refreshed.kind === "rejected") {
          oauthError(res, 400, "invalid_grant", "Refresh token invalid or expired");
        } else {
          unavailable(res);
        }
        return;
      }

      noStore(res);
      res.json({
        access_token: refreshed.data.accessToken,
        token_type: "Bearer",
        expires_in: refreshed.data.expiresIn,
        refresh_token: refreshed.data.refreshToken,
      });
      return;
    }

    oauthError(res, 400, "unsupported_grant_type", "Unsupported grant_type");
  }));

  // --- Token revocation (RFC 7009) ---
  // Claude uses this to show Disconnect button
  router.post("/oauth/revoke", revokeLimit, guardJson(log, async (req, res) => {
    const token = str(((req.body ?? {}) as Record<string, unknown>).token);

    if (token) {
      // El token va a la API tal cual (refresh token o no); la API decide y nunca lo usamos como Bearer.
      const revoked = await api.revokeSession({ token, ipAddress: req.ip, userAgent: req.headers["user-agent"] });
      if (!revoked.ok) log(`oauth revoke ${revoked.kind} status=${revoked.status ?? "n/a"}`);
    }

    // RFC 7009: always return 200, even if token is invalid
    noStore(res);
    res.status(200).json({});
  }, true));

  return router;
}

function optionalExpiresIn(seconds: number | undefined): { expires_in?: number } {
  return seconds === undefined ? {} : { expires_in: seconds };
}

// Ningún camino puede devolver algo que no sea JSON OAuth: un 500 HTML o un error desconocido haría que
// el cliente abra un login nuevo; temporarily_unavailable conserva sus credenciales.
function guardJson(
  log: (message: string) => void,
  handler: (req: Request, res: Response) => Promise<void>,
  alwaysOk = false
): RequestHandler {
  return async (req, res) => {
    try {
      await handler(req, res);
    } catch {
      log("oauth: error inesperado");
      if (res.headersSent) return;
      if (alwaysOk) {
        noStore(res);
        res.status(200).json({});
      } else {
        unavailable(res);
      }
    }
  };
}

function buildUrl(base: string, params: Record<string, string | undefined>): string {
  const url = new URL(base.startsWith("http") ? base : `http://placeholder${base}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== "") url.searchParams.set(k, v);
  }
  return base.startsWith("http") ? url.toString() : `${url.pathname}${url.search}`;
}
