import { Router } from "express";
import type { Request, RequestHandler, Response } from "express";
import { renderLoginPage } from "./login-page.js";
import { INVALID_REQUEST_PAGE_TEXT, UNAVAILABLE_PAGE_TEXT, renderErrorPage } from "./error-page.js";
import { CODE_CHALLENGE_METHOD, isValidCodeChallenge } from "./pkce.js";
import { MAX_REDIRECT_URIS, isAllowedRedirectUri, matchesRegisteredRedirectUri } from "./redirect-uri.js";
import type { ClientLookup } from "./client-registry.js";
import { createCode, redeemCode } from "./store.js";
import type { GocAuthApi } from "./goc-auth-api.js";
import { secondsUntilExpiry } from "./jwt.js";
import { TEMPORARILY_UNAVAILABLE, noStore, oauthError, unavailable } from "./responses.js";
import {
  LOGIN_RATE_LIMIT,
  REGISTER_RATE_LIMIT,
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
  /**
   * Cliente registrado, para validar authorize y login-action. Falla cerrado: `unavailable` nunca
   * equivale a «aceptar». No debe lanzar.
   */
  findClient(clientId: string): Promise<ClientLookup>;
  /** Solo recibe mensajes sin tokens ni datos del usuario. */
  log?: (message: string) => void;
  /** Configuración que requiere atención del operador (p. ej. API sin los endpoints nuevos). */
  logError?: (message: string) => void;
  limits?: { token?: RateLimitConfig; login?: RateLimitConfig; revoke?: RateLimitConfig; register?: RateLimitConfig };
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

const MAX_CLIENT_FIELD_LENGTH = 255;
const MAX_AUTH_METHOD_LENGTH = 50;

interface AuthorizationRequest {
  client_id?: string;
  redirect_uri?: string;
  state?: string;
  code_challenge?: string;
  code_challenge_method?: string;
  /** Solo se exige en authorize: el formulario de login existe únicamente para `code`. */
  response_type?: string;
}

type AuthorizationCheck =
  | {
      ok: true;
      client_id: string;
      redirect_uri: string;
      state?: string;
      code_challenge: string;
      code_challenge_method: string;
      clientName: string;
    }
  // El cliente o la redirect_uri no son de fiar: página de error, jamás una redirección.
  | { ok: false; kind: "page"; status: 400 | 503 }
  // Cliente y redirect_uri válidos, pero la petición está incompleta: error OAuth a esa redirect_uri.
  | { ok: false; kind: "redirect"; location: string };

export const REFRESH_ENDPOINT_MISSING_MESSAGE =
  "oauth refresh: la API respondió 404 en el endpoint de renovación; la API no expone el endpoint " +
  "(API sin desplegar o GOC_API_URL mal configurada)";
export const REVOKE_ENDPOINT_MISSING_MESSAGE =
  "oauth revoke: la API respondió 404 en el endpoint de revocación; la API no expone el endpoint " +
  "(API sin desplegar o GOC_API_URL mal configurada)";

export function createOauthRouter(deps: OauthDeps): Router {
  const { api, mcpBaseUrl } = deps;
  const log = deps.log ?? ((message: string) => console.warn(message));
  const logError = deps.logError ?? ((message: string) => console.error(message));
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
  const registerLimit = rateLimitMiddleware(
    createRateLimiter(deps.limits?.register ?? REGISTER_RATE_LIMIT),
    (_req, res, retryAfter) => {
      res.setHeader("Retry-After", String(retryAfter));
      oauthError(res, 429, TEMPORARILY_UNAVAILABLE, "Too many requests");
    }
  );

  // Validación compartida por authorize y login-action. Orden: cliente registrado → redirect_uri de ese
  // cliente → response_type → PKCE. Hasta que el cliente y la redirect_uri no están verificados no se
  // redirige a ningún sitio.
  async function checkAuthorization(input: AuthorizationRequest, requireResponseType: boolean): Promise<AuthorizationCheck> {
    const { client_id, redirect_uri, state, code_challenge, code_challenge_method, response_type } = input;
    if (!client_id || client_id.length > MAX_CLIENT_FIELD_LENGTH || !redirect_uri) return { ok: false, kind: "page", status: 400 };

    const lookup = await deps.findClient(client_id).catch((): ClientLookup => ({ kind: "unavailable" }));
    if (lookup.kind === "unavailable") {
      log("oauth authorize: registro de clientes no disponible");
      return { ok: false, kind: "page", status: 503 };
    }
    if (lookup.kind === "not_found" || !matchesRegisteredRedirectUri(redirect_uri, lookup.redirectUris)) {
      return { ok: false, kind: "page", status: 400 };
    }

    const reject = (error: string, description: string): AuthorizationCheck => ({
      ok: false,
      kind: "redirect",
      location: buildUrl(redirect_uri, { error, error_description: description, state }),
    });
    if (requireResponseType && response_type !== "code") {
      return reject("unsupported_response_type", "response_type must be code");
    }
    if (!isValidCodeChallenge(code_challenge) || code_challenge_method !== CODE_CHALLENGE_METHOD) {
      return reject("invalid_request", "PKCE with code_challenge_method=S256 is required");
    }
    return {
      ok: true,
      client_id,
      redirect_uri,
      state,
      code_challenge,
      code_challenge_method,
      clientName: lookup.clientName,
    };
  }

  const sendCheckFailure = (res: Response, check: Exclude<AuthorizationCheck, { ok: true }>) => {
    noStore(res);
    if (check.kind === "redirect") {
      res.redirect(check.location);
      return;
    }
    res.status(check.status).send(renderErrorPage(check.status === 503 ? UNAVAILABLE_PAGE_TEXT : INVALID_REQUEST_PAGE_TEXT));
  };

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
          response_type: "code",
          redirect_uri,
          state: str(body.state),
          client_id: str(body.client_id),
          code_challenge: str(body.code_challenge),
          code_challenge_method: str(body.code_challenge_method),
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

  router.post("/oauth/register", registerLimit, async (req, res) => {
    const { redirect_uris, client_name, token_endpoint_auth_method } = (req.body ?? {}) as Record<string, unknown>;

    if (!Array.isArray(redirect_uris) || redirect_uris.length === 0) {
      res.status(400).json({ error: "invalid_client_metadata", error_description: "redirect_uris required" });
      return;
    }
    // Misma política que la API (https o loopback): lo que ella rechazaría no debe salir como 500.
    if (redirect_uris.length > MAX_REDIRECT_URIS || !redirect_uris.every(isAllowedRedirectUri)) {
      res.status(400).json({
        error: "invalid_redirect_uri",
        error_description: "redirect_uris must be https or loopback (localhost, 127.0.0.1) URLs without fragment",
      });
      return;
    }
    if (
      (client_name != null && (typeof client_name !== "string" || client_name.length > MAX_CLIENT_FIELD_LENGTH)) ||
      (token_endpoint_auth_method != null &&
        (typeof token_endpoint_auth_method !== "string" || token_endpoint_auth_method.length > MAX_AUTH_METHOD_LENGTH))
    ) {
      res.status(400).json({ error: "invalid_client_metadata", error_description: "client_name or token_endpoint_auth_method invalid" });
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

  router.get("/oauth/authorize", async (req, res) => {
    const q = req.query as Record<string, unknown>;
    const check = await checkAuthorization(
      {
        client_id: str(q.client_id),
        redirect_uri: str(q.redirect_uri),
        state: str(q.state),
        code_challenge: str(q.code_challenge),
        code_challenge_method: str(q.code_challenge_method),
        response_type: str(q.response_type),
      },
      true
    );
    if (!check.ok) {
      sendCheckFailure(res, check);
      return;
    }

    noStore(res);
    res.send(
      renderLoginPage({
        redirect_uri: check.redirect_uri,
        state: check.state,
        client_id: check.client_id,
        code_challenge: check.code_challenge,
        code_challenge_method: check.code_challenge_method,
        client_name: check.clientName,
        error: str(q.error),
      })
    );
  });

  // Orden: limitador → validación → login. El limitador va primero para que la fuerza bruta de contraseñas
  // se frene igual con peticiones válidas o no, y para que las inválidas (que cuestan una consulta de
  // cliente a la API) también tengan tope por IP. La validación va antes de `api.login`: una petición
  // inválida no gasta una llamada de login ni deja pasar credenciales a la API.
  router.post("/oauth/login-action", loginLimit, async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const username = str(body.username);
    const password = str(body.password);

    try {
      const check = await checkAuthorization(
        {
          client_id: str(body.client_id),
          redirect_uri: str(body.redirect_uri),
          state: str(body.state),
          code_challenge: str(body.code_challenge),
          code_challenge_method: str(body.code_challenge_method),
        },
        false
      );
      if (!check.ok) {
        sendCheckFailure(res, check);
        return;
      }
      const { redirect_uri, state, client_id, code_challenge, code_challenge_method } = check;

      const fail = (message: string, reason: string) => {
        // Sin usuario, contraseña ni el mensaje de la API.
        log(`oauth login fallido: ${reason}`);
        res.redirect(
          buildUrl("/oauth/authorize", {
            response_type: "code",
            redirect_uri,
            state,
            client_id,
            code_challenge,
            code_challenge_method,
            error: message,
          })
        );
      };

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

      // La redirect_uri ya pasó la validación: el código nunca viaja a otra.
      const code = createCode({ jwt: login.jwt, gocRefreshToken: login.gocRefreshToken, redirect_uri, client_id, code_challenge });
      res.redirect(buildUrl(redirect_uri, { code, state }));
    } catch {
      log("oauth login fallido: error inesperado");
      noStore(res);
      if (!res.headersSent) res.status(503).send(renderErrorPage(UNAVAILABLE_PAGE_TEXT));
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
      const codeVerifier = str(body.code_verifier);
      // Se valida todo antes de redimir: un request incompleto no debe quemar el código.
      if (!code || !redirect_uri || !clientId || !codeVerifier) {
        oauthError(res, 400, "invalid_request", "Missing code, redirect_uri, client_id or code_verifier");
        return;
      }

      const result = redeemCode(code, { redirect_uri, client_id: clientId, code_verifier: codeVerifier });
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

      // Con el código ya quemado, un fallo al resolver el nombre del cliente no debe tumbar el canje.
      const clientMeta = await deps.getClientMeta(clientId).catch((): Record<string, string> => ({ client_id: clientId }));
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
        if (refreshed.status === 404) logError(REFRESH_ENDPOINT_MISSING_MESSAGE);
        else log(`oauth refresh ${refreshed.kind} status=${refreshed.status ?? "n/a"}`);
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
      if (!revoked.ok) {
        if (revoked.status === 404) logError(REVOKE_ENDPOINT_MISSING_MESSAGE);
        else log(`oauth revoke ${revoked.kind} status=${revoked.status ?? "n/a"}`);
      }
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
// el cliente abra un login nuevo; con temporarily_unavailable el cliente no descarta sus credenciales.
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
