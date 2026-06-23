import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { GocApiClient } from "./api-client.js";
import { McpTracker } from "./tracker.js";

export function withTracking<TParams>(
  toolName: string,
  client: GocApiClient,
  tracker: McpTracker,
  handler: (params: TParams) => Promise<CallToolResult>
): (params: TParams) => Promise<CallToolResult> {
  return async (params: TParams) => {
    const startTime = Date.now();
    try {
      const result = await handler(params);
      tracker.logToolCall({
        toolName,
        inputParams: params as Record<string, unknown>,
        status: "success",
        durationMs: Date.now() - startTime,
        apiCalls: client.getAndResetApiCallLog(),
      });
      return result;
    } catch (error) {
      tracker.logToolCall({
        toolName,
        inputParams: params as Record<string, unknown>,
        status: "error",
        durationMs: Date.now() - startTime,
        errorMessage: error instanceof Error ? error.message : String(error),
        apiCalls: client.getAndResetApiCallLog(),
      });
      throw error;
    }
  };
}
