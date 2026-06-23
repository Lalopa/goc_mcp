import { Router } from "express";
import axios from "axios";
import { renderLoginPage } from "./login-page.js";
import { createCode, redeemCode, generateRefreshToken } from "./store.js";
import { registerOAuthClientInApi, getClientTrackingMetadata } from "./client-registry.js";
import { GocApiClient } from "../api-client.js";
import { McpTracker } from "../tracker.js";

const GOC_API_URL = process.env.GOC_API_URL!;
const MCP_BASE_URL = process.env.MCP_BASE_URL!;

const ACCESS_TOKEN_TTL_SECONDS = 7200; // 2h — matches GOC API JWT expiry

export const oauthRouter = Router();

// Protected Resource Metadata (RFC 9728) — tells Claude where to authenticate.
// Required by the modern MCP authorization spec so the client can re-auth on 401.
oauthRouter.get("/.well-known/oauth-protected-resource", (_req, res) => {
  res.json({
    resource: MCP_BASE_URL,
    authorization_servers: [MCP_BASE_URL],
    scopes_supported: ["read"],
    bearer_methods_supported: ["header"],
  });
});

oauthRouter.get("/.well-known/oauth-authorization-server", (_req, res) => {
  res.json({
    issuer: MCP_BASE_URL,
    authorization_endpoint: `${MCP_BASE_URL}/oauth/authorize`,
    token_endpoint: `${MCP_BASE_URL}/oauth/token`,
    registration_endpoint: `${MCP_BASE_URL}/oauth/register`,
    revocation_endpoint: `${MCP_BASE_URL}/oauth/revoke`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    revocation_endpoint_auth_methods_supported: ["none"],
    scopes_supported: ["read"],
  });
});

oauthRouter.post("/oauth/register", async (req, res) => {
  const { redirect_uris, client_name, token_endpoint_auth_method } = req.body as Record<string, unknown>;

  if (!Array.isArray(redirect_uris) || redirect_uris.length === 0) {
    res.status(400).json({ error: "invalid_client_metadata", error_description: "redirect_uris required" });
    return;
  }

  const client_id = crypto.randomUUID();
  const resolvedClientName = typeof client_name === "string" && client_name.trim()
    ? client_name.trim()
    : "MCP Client";

  try {
    await registerOAuthClientInApi({
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

oauthRouter.get("/oauth/authorize", (req, res) => {
  const { redirect_uri, state, client_id, error } = req.query as Record<string, string>;

  if (!redirect_uri) {
    res.status(400).send("Missing redirect_uri");
    return;
  }

  res.send(renderLoginPage({ redirect_uri, state, client_id, error }));
});

oauthRouter.post("/oauth/login-action", async (req, res) => {
  const { username, password, redirect_uri, state, client_id } = req.body as Record<string, string>;

  if (!redirect_uri) {
    res.status(400).send("Missing redirect_uri");
    return;
  }

  try {
    const response = await axios.post(`${GOC_API_URL}/auth/login`, { username, password });
    const jwt: string = response.data?.token ?? response.data?.data?.accessToken ?? response.data?.accessToken;
    const gocRefreshToken: string = response.data?.refreshToken ?? response.data?.data?.refreshToken ?? "";

    if (!jwt) {
      const errorUrl = buildUrl("/oauth/authorize", { redirect_uri, state, client_id, error: "No token received" });
      res.redirect(errorUrl);
      return;
    }

    const code = createCode(jwt, gocRefreshToken, redirect_uri);
    const callbackUrl = buildUrl(redirect_uri, { code, state });
    res.redirect(callbackUrl);
  } catch (err: unknown) {
    const message = extractErrorMessage(err);
    const clientMeta = await getClientTrackingMetadata(client_id);

    // Fire-and-forget: log auth failure event
    logEventSafe(undefined, {
      eventType: "auth_failure",
      clientId: client_id,
      description: `Login failed for user "${req.body?.username ?? "unknown"}" (${clientMeta.client_name ?? "unknown agent"}): ${message}`,
      metadata: clientMeta,
      ipAddress: req.ip,
      userAgent: req.headers["user-agent"],
    });

    const errorUrl = buildUrl("/oauth/authorize", { redirect_uri, state, client_id, error: message });
    res.redirect(errorUrl);
  }
});

oauthRouter.post("/oauth/token", async (req, res) => {
  const { grant_type, code, redirect_uri, refresh_token, client_id } = req.body as Record<string, string>;

  // --- Authorization code grant ---
  if (grant_type === "authorization_code") {
    if (!code || !redirect_uri) {
      res.status(400).json({ error: "invalid_request", error_description: "Missing code or redirect_uri" });
      return;
    }

    const result = redeemCode(code, redirect_uri);
    if (!result) {
      res.status(400).json({ error: "invalid_grant", error_description: "Code expired or invalid" });
      return;
    }

    const mcpRefreshToken = generateRefreshToken();
    const clientMeta = await getClientTrackingMetadata(client_id);

    // Fire-and-forget: create session and log event in the API
    const apiClient = new GocApiClient(result.jwt);
    const tracker = new McpTracker(apiClient);

    await tracker.createSession({
      mcpRefreshToken,
      gocRefreshToken: result.gocRefreshToken,
      clientId: client_id,
      ipAddress: req.ip,
      userAgent: req.headers["user-agent"],
      metadata: clientMeta,
    }).catch(() => {});

    tracker.logEvent({
      eventType: "auth_success",
      clientId: client_id,
      description: `User authenticated via OAuth (${clientMeta.client_name ?? "unknown agent"})`,
      metadata: clientMeta,
      ipAddress: req.ip,
      userAgent: req.headers["user-agent"],
    });

    res.json({
      access_token: result.jwt,
      token_type: "Bearer",
      expires_in: ACCESS_TOKEN_TTL_SECONDS,
      refresh_token: mcpRefreshToken,
    });
    return;
  }

  // --- Refresh token grant ---
  if (grant_type === "refresh_token") {
    if (!refresh_token) {
      res.status(400).json({ error: "invalid_request", error_description: "Missing refresh_token" });
      return;
    }

    const clientMeta = await getClientTrackingMetadata(client_id);

    // Look up the session in the API to get the GOC refresh token
    // We need a JWT to call the API, but we only have the expired one.
    // The GOC API's /auth/refresh endpoint uses `authenticateIgnoreExpiration` middleware,
    // so we can use the expired JWT to call it.
    // However, we need to find the session first. We'll try to find it via a GET endpoint.

    // First, try to get session data from the API using a temporary client
    // We need some JWT to authenticate to the API — use a minimal approach:
    // Extract the expired JWT from the Authorization header if present
    const authHeader = req.headers.authorization ?? "";
    const expiredJwt = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;

    if (!expiredJwt) {
      res.status(400).json({ error: "invalid_grant", error_description: "Authorization header with expired token is required for refresh" });
      return;
    }

    const apiClient = new GocApiClient(expiredJwt);
    const tracker = new McpTracker(apiClient);

    try {
      const session = await tracker.findSessionByToken(refresh_token);
      if (!session) {
        res.status(400).json({ error: "invalid_grant", error_description: "Refresh token invalid or expired" });
        return;
      }

      // Call GOC API to refresh the token
      const response = await axios.post(
        `${GOC_API_URL}/auth/refresh`,
        { refreshToken: session.gocRefreshToken },
        { headers: { Authorization: `Bearer ${expiredJwt}` } }
      );

      const newJwt: string = response.data?.token ?? response.data?.data?.accessToken ?? "";
      const newGocRefresh: string = response.data?.refreshToken ?? response.data?.data?.refreshToken ?? "";

      if (!newJwt) {
        tracker.logEvent({
          eventType: "token_refresh_failed",
          clientId: client_id,
          metadata: clientMeta,
          description: `GOC API did not return a new token (${clientMeta.client_name ?? "unknown agent"})`,
          ipAddress: req.ip,
          userAgent: req.headers["user-agent"],
        });
        res.status(400).json({ error: "invalid_grant", error_description: "Could not refresh upstream token" });
        return;
      }

      const newMcpRefreshToken = generateRefreshToken();

      // Update session with new tokens
      const newApiClient = new GocApiClient(newJwt);
      const newTracker = new McpTracker(newApiClient);
      newTracker.bindSession(session.id);
      newTracker.setRequestContext({
        ipAddress: req.ip,
        userAgent: req.headers["user-agent"],
      });

      newTracker.logEvent({
        eventType: "token_refresh",
        clientId: client_id,
        metadata: clientMeta,
        description: `Token refreshed (${clientMeta.client_name ?? "unknown agent"})`,
        ipAddress: req.ip,
        userAgent: req.headers["user-agent"],
      });

      // Update the session in the DB
      newApiClient.patch(`/mcp/sessions/${session.id}`, {
        mcpRefreshToken: newMcpRefreshToken,
        gocRefreshToken: newGocRefresh,
        status: "active",
        lastActivityAt: new Date().toISOString(),
      }).catch(() => {});

      res.json({
        access_token: newJwt,
        token_type: "Bearer",
        expires_in: ACCESS_TOKEN_TTL_SECONDS,
        refresh_token: newMcpRefreshToken,
      });
    } catch {
      tracker.logEvent({
        eventType: "token_refresh_failed",
        clientId: client_id,
        metadata: clientMeta,
        description: `Upstream refresh failed (${clientMeta.client_name ?? "unknown agent"}) — user must re-authenticate`,
        ipAddress: req.ip,
        userAgent: req.headers["user-agent"],
      });

      res.status(400).json({ error: "invalid_grant", error_description: "Upstream refresh failed — please re-authenticate" });
    }
    return;
  }

  res.status(400).json({ error: "unsupported_grant_type" });
});

// --- Token revocation (RFC 7009) ---
// Claude uses this to show Disconnect button
oauthRouter.post("/oauth/revoke", (req, res) => {
  const { token } = req.body as Record<string, string>;

  if (!token) {
    res.status(200).json({});
    return;
  }

  // Try to invalidate the session in the API using the token as auth
  const authHeader = req.headers.authorization ?? "";
  const jwt = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : token;

  const apiClient = new GocApiClient(jwt);
  const tracker = new McpTracker(apiClient);

  tracker.findSessionByToken(token)
    .then(async (session) => {
      if (session) {
        tracker.bindSession(session.id);
        tracker.updateSession(session.id, { status: "revoked" }).catch(() => {});
        tracker.logEvent({
          eventType: "token_revoked",
          clientId: session.clientId ?? undefined,
          metadata: await getClientTrackingMetadata(session.clientId ?? undefined),
          description: "User disconnected via OAuth revocation",
          ipAddress: req.ip,
          userAgent: req.headers["user-agent"],
        });
      }
    })
    .catch(() => {});

  // RFC 7009: always return 200, even if token is invalid
  res.status(200).json({});
});

function buildUrl(base: string, params: Record<string, string | undefined>): string {
  const url = new URL(base.startsWith("http") ? base : `http://placeholder${base}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== "") url.searchParams.set(k, v);
  }
  return base.startsWith("http") ? url.toString() : `${url.pathname}${url.search}`;
}

function extractErrorMessage(err: unknown): string {
  if (axios.isAxiosError(err)) {
    return err.response?.data?.message ?? err.response?.data?.error ?? "Invalid credentials";
  }
  if (err instanceof Error) return err.message;
  return "Unknown error";
}

function logEventSafe(jwt: string | undefined, event: {
  eventType: string;
  clientId?: string;
  description?: string;
  metadata?: Record<string, string>;
  ipAddress?: string;
  userAgent?: string;
}): void {
  if (!jwt) return;
  try {
    const client = new GocApiClient(jwt);
    const tracker = new McpTracker(client);
    tracker.logEvent(event);
  } catch {}
}
