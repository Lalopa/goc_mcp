import { GocApiClient, ApiCallRecord } from "./api-client.js";
import type { McpRequestContext } from "./tracking-context.js";

const API_PREFIX = "/mcp";

interface SessionResponse {
  success: boolean;
  data: { id: number };
}

interface ActiveSessionResponse {
  success: boolean;
  data: { id: number } | null;
}

export class McpTracker {
  private client: GocApiClient;
  private sessionDbId: number | null = null;
  private requestContext: McpRequestContext = {};

  constructor(client: GocApiClient) {
    this.client = client;
  }

  setRequestContext(context: McpRequestContext): void {
    this.requestContext = context;
  }

  get sessionId(): number | null {
    return this.sessionDbId;
  }

  async resolveActiveSession(): Promise<number | null> {
    try {
      const result = await this.client.get<ActiveSessionResponse>(`${API_PREFIX}/sessions/active`);
      if (result.data?.id != null) {
        this.sessionDbId = result.data.id;
      }
      return this.sessionDbId;
    } catch {
      return this.sessionDbId;
    }
  }

  bindSession(sessionId: number): void {
    this.sessionDbId = sessionId;
  }

  async createSession(data: {
    mcpRefreshToken: string;
    gocRefreshToken: string;
    clientId?: string;
    ipAddress?: string;
    userAgent?: string;
    metadata?: Record<string, unknown>;
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

  async findSessionByToken(token: string): Promise<{
    id: number;
    status: string;
    gocRefreshToken: string;
    clientId?: string | null;
  } | null> {
    const result = await this.client.get<{
      success: boolean;
      data: {
        id: number;
        status: string;
        gocRefreshToken: string;
        clientId?: string | null;
      } | null;
    }>(
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
    const payload = {
      ...data,
      sessionId: this.sessionDbId,
      ipAddress: data.ipAddress ?? this.requestContext.ipAddress,
      userAgent: data.userAgent ?? this.requestContext.userAgent,
      mcpRequestId: data.mcpRequestId ?? this.requestContext.mcpRequestId,
    };
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
    this.client.post(`${API_PREFIX}/events`, {
      ...data,
      ipAddress: data.ipAddress ?? this.requestContext.ipAddress,
      userAgent: data.userAgent ?? this.requestContext.userAgent,
    }).catch(() => {});
  }
}
