import express from "express";
import type { Express, Request, Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createOauthRouter } from "./oauth/routes.js";
import type { OauthDeps } from "./oauth/routes.js";
import { createDefaultDeps } from "./oauth/deps.js";
import { createOauthErrorHandler } from "./oauth/error-handler.js";
import { configureTrustProxy } from "./oauth/trust-proxy.js";
import { createMcpServer } from "./mcp-server.js";
import { GocApiClient, GocApiError } from "./api-client.js";
import { McpTracker } from "./tracker.js";
import { extractMcpRequestId } from "./tracking-context.js";

export interface AppOptions {
  /** Valor crudo de TRUST_PROXY_HOPS. Por defecto, el del entorno al crear la app. */
  trustProxyHops?: string;
}

// Returns true if the JWT is missing, malformed, or its `exp` claim is in the past.
function isJwtExpired(jwt: string): boolean {
  try {
    const [, payloadB64] = jwt.split(".");
    if (!payloadB64) return true;
    const payload = JSON.parse(Buffer.from(payloadB64, "base64").toString("utf-8"));
    if (typeof payload.exp !== "number") return false; // no exp → let the API decide
    return Date.now() >= payload.exp * 1000;
  } catch {
    return true;
  }
}

// Construye la app sin abrir un puerto: src/index.ts hace `listen`. TRUST_PROXY_HOPS y los valores de
// createDefaultDeps se leen al llamar; client-registry.ts lee GOC_API_URL al cargarse, así que
// src/index.ts importa dotenv antes que este módulo.
export function createApp(deps: OauthDeps = createDefaultDeps(), options: AppOptions = {}): Express {
  const app = express();
  // Saltos de proxy de confianza (TRUST_PROXY_HOPS, por defecto 1: nginx delante). De esto depende req.ip.
  configureTrustProxy(app, options.trustProxyHops ?? process.env.TRUST_PROXY_HOPS);
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  app.use(createOauthRouter(deps));
  // Errores de los parsers de arriba en /oauth/*: respuesta OAuth en vez del HTML de finalhandler.
  app.use(createOauthErrorHandler(deps.log));

  const RESOURCE_METADATA_URL = `${deps.mcpBaseUrl}/.well-known/oauth-protected-resource`;

  // Sends a 401 with the WWW-Authenticate header so Claude knows to re-run the OAuth flow.
  function sendUnauthorized(res: Response, message: string): void {
    res.setHeader(
      "WWW-Authenticate",
      `Bearer resource_metadata="${RESOURCE_METADATA_URL}", error="invalid_token", error_description="${message}"`
    );
    res.status(401).json({
      jsonrpc: "2.0",
      error: { code: -32001, message },
      id: null,
    });
  }

  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  app.post("/mcp", async (req: Request, res: Response) => {
    const authHeader = req.headers.authorization ?? "";
    const jwt = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;

    if (!jwt) {
      sendUnauthorized(res, "Bearer token required. Please authenticate.");
      return;
    }

    // Reject expired tokens up front so Claude re-authenticates instead of
    // receiving an opaque tool error from the upstream GOC API.
    if (isJwtExpired(jwt)) {
      sendUnauthorized(res, "Token expired. Please re-authenticate.");
      return;
    }

    const client = new GocApiClient(jwt);
    try {
      await client.assertAdministrator();
    } catch (error) {
      if (error instanceof GocApiError && error.status === 401) {
        sendUnauthorized(res, "Invalid token. Please re-authenticate.");
      } else {
        const forbidden = error instanceof GocApiError && error.status === 403;
        res.status(forbidden ? 403 : 503).json({
          jsonrpc: "2.0", error: { code: -32001, message: forbidden ? "Only active administrators can access this MCP." : "Unable to verify administrator access." }, id: null,
        });
      }
      return;
    }
    const tracker = new McpTracker(client);
    tracker.setRequestContext({
      ipAddress: req.ip,
      userAgent: req.headers["user-agent"],
      mcpRequestId: extractMcpRequestId(req.body),
    });
    await tracker.resolveActiveSession();

    const server = createMcpServer(client, tracker);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      res.on("close", () => {
        transport.close();
        server.close();
      });
    } catch (error) {
      console.error("MCP request error:", error);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  });

  app.get("/mcp", (_req, res) => {
    res.status(405).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed." },
      id: null,
    });
  });

  return app;
}
