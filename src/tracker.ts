import { GocApiClient, ApiCallRecord } from "./api-client.js";
import type { McpRequestContext } from "./tracking-context.js";

const API_PREFIX = "/mcp";

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
