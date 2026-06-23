import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { GocApiClient } from "../api-client.js";

export function registerOrderTools(server: McpServer, client: GocApiClient): void {
  server.registerTool(
    "order_detail",
    {
      description: "Obtener el detalle completo de un pedido: materiales, estatus, proveedor, obra, comentarios e historial de cambios.",
      inputSchema: {
        id: z.string().describe("ID del pedido"),
      },
    },
    async ({ id }) => {
      const data = await client.get(`/orders/${id}`);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.registerTool(
    "orders_list",
    {
      description: "Listar pedidos con filtros opcionales. Devuelve pedidos con su estatus actual, materiales y obra asociada.",
      inputSchema: {
        project_id: z.string().optional().describe("Filtrar por ID de obra/proyecto"),
        status: z.string().optional().describe("Filtrar por estatus del pedido (draft, pending, paid, delivered, etc.)"),
      },
    },
    async (params) => {
      const data = await client.get("/orders", params);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.registerTool(
    "kanban_cards",
    {
      description: "Vista kanban de pedidos agrupados por estatus, proveedor y obra. Muestra el flujo completo de materiales desde solicitud hasta entrega.",
      inputSchema: {
        project_id: z.string().optional().describe("Filtrar por ID de obra"),
        provider_id: z.string().optional().describe("Filtrar por proveedor"),
      },
    },
    async (params) => {
      const data = await client.get("/kanban/cards", params);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );
}
