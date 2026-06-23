import { Router } from "express";
import axios from "axios";
import { renderLoginPage } from "./login-page.js";
import { createCode, redeemCode } from "./store.js";

const GOC_API_URL = process.env.GOC_API_URL!;
const MCP_BASE_URL = process.env.MCP_BASE_URL!;

export const oauthRouter = Router();

oauthRouter.get("/.well-known/oauth-authorization-server", (_req, res) => {
  res.json({
    issuer: MCP_BASE_URL,
    authorization_endpoint: `${MCP_BASE_URL}/oauth/authorize`,
    token_endpoint: `${MCP_BASE_URL}/oauth/token`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    code_challenge_methods_supported: ["S256"],
    scopes_supported: ["read"],
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

    if (!jwt) {
      const errorUrl = buildUrl("/oauth/authorize", { redirect_uri, state, client_id, error: "No se recibió token" });
      res.redirect(errorUrl);
      return;
    }

    const code = createCode(jwt, redirect_uri);
    const callbackUrl = buildUrl(redirect_uri, { code, state });
    res.redirect(callbackUrl);
  } catch (err: unknown) {
    const message = extractErrorMessage(err);
    const errorUrl = buildUrl("/oauth/authorize", { redirect_uri, state, client_id, error: message });
    res.redirect(errorUrl);
  }
});

oauthRouter.post("/oauth/token", (req, res) => {
  const { grant_type, code, redirect_uri } = req.body as Record<string, string>;

  if (grant_type !== "authorization_code") {
    res.status(400).json({ error: "unsupported_grant_type" });
    return;
  }

  if (!code || !redirect_uri) {
    res.status(400).json({ error: "invalid_request", error_description: "Missing code or redirect_uri" });
    return;
  }

  const jwt = redeemCode(code, redirect_uri);
  if (!jwt) {
    res.status(400).json({ error: "invalid_grant", error_description: "Code expired or invalid" });
    return;
  }

  res.json({ access_token: jwt, token_type: "Bearer" });
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
    return err.response?.data?.message ?? err.response?.data?.error ?? "Credenciales incorrectas";
  }
  if (err instanceof Error) return err.message;
  return "Error desconocido";
}
