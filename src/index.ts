import "dotenv/config";
import express, { Request, Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { oauthRouter } from "./oauth/routes.js";
import { createMcpServer } from "./mcp-server.js";
import { GocApiClient } from "./api-client.js";
import { McpTracker } from "./tracker.js";

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(oauthRouter);

const MCP_BASE_URL = process.env.MCP_BASE_URL!;
const RESOURCE_METADATA_URL = `${MCP_BASE_URL}/.well-known/oauth-protected-resource`;

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
  const tracker = new McpTracker(client);
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

const PORT = process.env.PORT ?? 3002;
app.listen(PORT, () => {
  console.log(`GOC MCP server running on port ${PORT}`);
});
