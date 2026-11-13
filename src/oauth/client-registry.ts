import axios from "axios";

const GOC_API_URL = process.env.GOC_API_URL!;

// El canje de código llama a getClientTrackingMetadata con el código ya quemado: nunca debe colgarse.
export const CLIENT_REGISTRY_TIMEOUT_MS = 5000;

export async function registerOAuthClientInApi(data: {
  clientId: string;
  clientName: string;
  redirectUris: string[];
  tokenEndpointAuthMethod?: string;
}): Promise<void> {
  await axios.post(`${GOC_API_URL}/mcp/clients/register`, {
    clientId: data.clientId,
    clientName: data.clientName,
    redirectUris: data.redirectUris,
    tokenEndpointAuthMethod: data.tokenEndpointAuthMethod,
  }, { timeout: CLIENT_REGISTRY_TIMEOUT_MS });
}

export async function getClientTrackingMetadata(
  clientId: string | undefined
): Promise<Record<string, string>> {
  if (!clientId) return {};

  try {
    const response = await axios.get(`${GOC_API_URL}/mcp/clients/${encodeURIComponent(clientId)}`, {
      timeout: CLIENT_REGISTRY_TIMEOUT_MS,
    });
    const data = response.data?.data as { clientId?: string; clientName?: string } | null;
    if (data?.clientId && data.clientName) {
      return {
        client_id: data.clientId,
        client_name: data.clientName,
      };
    }
  } catch {
    // Client not found or API unavailable
  }

  return { client_id: clientId };
}

export type ClientLookup =
  | { kind: "found"; clientName: string; redirectUris: string[] }
  | { kind: "not_found" }
  | { kind: "unavailable" };

// Consulta el cliente registrado para validar authorize y login-action. Falla cerrado: cualquier cosa
// distinta de un 404 claro o de un cliente bien formado es `unavailable`, nunca «aceptar».
export async function findOAuthClient(clientId: string): Promise<ClientLookup> {
  try {
    const response = await axios.get(`${GOC_API_URL}/mcp/clients/${encodeURIComponent(clientId)}`, {
      timeout: CLIENT_REGISTRY_TIMEOUT_MS,
      validateStatus: (status) => status === 200 || status === 404,
    });
    if (response.status === 404) return { kind: "not_found" };
    const data = response.data?.data as { clientId?: unknown; clientName?: unknown; redirectUris?: unknown } | null | undefined;
    // Una respuesta de otro cliente no sirve para validar este: no se acepta.
    if (data?.clientId !== clientId) return { kind: "unavailable" };
    const uris = data?.redirectUris;
    if (!Array.isArray(uris) || !uris.every((u) => typeof u === "string")) return { kind: "unavailable" };
    const clientName = typeof data?.clientName === "string" ? data.clientName : "";
    return { kind: "found", clientName, redirectUris: uris as string[] };
  } catch {
    return { kind: "unavailable" };
  }
}
