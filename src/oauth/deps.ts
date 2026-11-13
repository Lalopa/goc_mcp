import { registerOAuthClientInApi, getClientTrackingMetadata, findOAuthClient } from "./client-registry.js";
import { createAxiosHttpClient, createGocAuthApi } from "./goc-auth-api.js";
import type { OauthDeps } from "./routes.js";
import { GocApiClient } from "../api-client.js";
import { McpTracker } from "../tracker.js";

// Cableado real. Lee el entorno al llamarse (no al importar) para que src/index.ts cargue dotenv antes.
export function createDefaultDeps(): OauthDeps {
  const api = createGocAuthApi(createAxiosHttpClient(process.env.GOC_API_URL!), (jwt, event) => {
    new McpTracker(new GocApiClient(jwt)).logEvent(event);
  });
  return {
    api,
    mcpBaseUrl: process.env.MCP_BASE_URL!,
    getClientMeta: getClientTrackingMetadata,
    findClient: findOAuthClient,
    registerClient: registerOAuthClientInApi,
  };
}
