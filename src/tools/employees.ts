import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { GocApiClient } from "../api-client.js";

export function registerEmployeeTools(server: McpServer, client: GocApiClient): void {
  server.registerTool(
    "employee_search",
    {
      description: "Buscar empleados por nombre. Devuelve una lista de empleados que coinciden con el término de búsqueda.",
      inputSchema: {
        query: z.string().describe("Nombre o apellido del empleado a buscar"),
      },
    },
    async ({ query }) => {
      const data = await client.get("/employees/search", { q: query });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.registerTool(
    "employee_detail",
    {
      description: "Obtener información completa de un empleado: datos personales, categoría, estatus laboral, proyecto asignado, documentos.",
      inputSchema: {
        id: z.string().describe("ID del empleado"),
      },
    },
    async ({ id }) => {
      const data = await client.get(`/employees/${id}`);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.registerTool(
    "employee_list",
    {
      description: "Listar empleados con filtros opcionales. Devuelve empleados paginados.",
      inputSchema: {
        project_id: z.string().optional().describe("Filtrar por ID de obra/proyecto"),
        employment_status: z.string().optional().describe("Filtrar por estatus (ej: ACTIVE, INACTIVE)"),
        page: z.number().optional().describe("Número de página (por defecto 1)"),
        limit: z.number().optional().describe("Resultados por página (por defecto 20)"),
      },
    },
    async (params) => {
      const data = await client.get("/employees", params);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );
}
