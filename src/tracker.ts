import { GocApiClient, ApiCallRecord } from "./api-client.js";

const API_PREFIX = "/mcp";

interface SessionResponse {
  success: boolean;
  data: { id: number };
}

export class McpTracker {
  private client: GocApiClient;
  private sessionDbId: number | null = null;

  constructor(client: GocApiClient) {
    this.client = client;
  }

  get sessionId(): number | null {
    return this.sessionDbId;
  }

  async createSession(data: {
    mcpRefreshToken: string;
    gocRefreshToken: string;
    clientId?: string;
    ipAddress?: string;
    userAgent?: string;
    expiresAt?: string;
  }): Promise<number> {
    const result = await this.client.post<SessionResponse>(`${API_PREFIX}/sessions`, data);
    this.sessionDbId = result.data.id;
    return this.sessionDbId;
  }

  async updateSession(id: number, data: {
    status?: string;
    mcpRefreshToken?: string;
    gocRefreshToken?: string;
    lastActivityAt?: string;
  }): Promise<void> {
    await this.client.patch(`${API_PREFIX}/sessions/${id}`, data);
  }

  async findSessionByToken(token: string): Promise<{ id: number; status: string; gocRefreshToken: string } | null> {
    const result = await this.client.get<{ success: boolean; data: { id: number; status: string; gocRefreshToken: string } | null }>(
      `${API_PREFIX}/sessions/find`,
      { token }
    );
    return result.data;
  }

  logToolCall(data: {
    toolName: string;
    inputParams: Record<string, unknown>;
    status: "success" | "error";
    durationMs: number;
    errorMessage?: string;
    apiCalls: ApiCallRecord[];
    mcpRequestId?: string;
    ipAddress?: string;
    userAgent?: string;
  }): void {
    const payload = { ...data, sessionId: this.sessionDbId };
    this.client.post(`${API_PREFIX}/tool-calls`, payload).catch(() => {});
  }

  logEvent(data: {
    eventType: string;
    clientId?: string;
    description?: string;
    metadata?: Record<string, unknown>;
    ipAddress?: string;
    userAgent?: string;
  }): void {
    this.client.post(`${API_PREFIX}/events`, data).catch(() => {});
  }
}
