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
