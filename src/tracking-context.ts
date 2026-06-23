export interface McpRequestContext {
  ipAddress?: string;
  userAgent?: string;
  mcpRequestId?: string;
}

export function extractMcpRequestId(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const id = (body as { id?: unknown }).id;
  if (id === null || id === undefined) return undefined;
  return String(id);
}
