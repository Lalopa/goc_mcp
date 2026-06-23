import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { GocApiClient } from "../api-client.js";
import { McpTracker } from "../tracker.js";
import { withTracking } from "../tool-wrapper.js";

const ANNOTATIONS = { readOnlyHint: true, destructiveHint: false, idempotentHint: true } as const;

export function registerOrderTools(server: McpServer, client: GocApiClient, tracker: McpTracker): void {
  server.registerTool(
    "order_detail",
    {
      title: "Order Detail",
      description: "Get full details of an order: materials, status, provider, project, comments, and change history.",
      annotations: ANNOTATIONS,
      inputSchema: {
        id: z.string().describe("Order ID"),
      },
    },
    withTracking("order_detail", client, tracker, async ({ id }) => {
      const data = await client.get(`/orders/${id}`);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    })
  );

  server.registerTool(
    "orders_list",
    {
      title: "Orders List",
      description: "List orders with optional filters. Returns orders with their current status, materials, and associated project.",
      annotations: ANNOTATIONS,
      inputSchema: {
        project_id: z.string().optional().describe("Filter by project ID"),
        status: z.string().optional().describe("Filter by order status (draft, pending, paid, delivered, etc.)"),
      },
    },
    withTracking("orders_list", client, tracker, async (params) => {
      const data = await client.get("/orders", params);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    })
  );

  server.registerTool(
    "kanban_cards",
    {
      title: "Kanban Cards",
      description: "Kanban view of orders grouped by status, provider, and project. Shows the full material flow from request to delivery.",
      annotations: ANNOTATIONS,
      inputSchema: {
        project_id: z.string().optional().describe("Filter by project ID"),
        provider_id: z.string().optional().describe("Filter by provider ID"),
      },
    },
    withTracking("kanban_cards", client, tracker, async (params) => {
      const data = await client.get("/kanban/cards", params);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    })
  );
}
