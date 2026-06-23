import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { GocApiClient } from "../api-client.js";

export function registerProjectTools(server: McpServer, client: GocApiClient): void {
  server.registerTool(
    "project_list",
    {
      description: "Listar todas las obras/proyectos disponibles con su información básica: nombre, estatus y responsable.",
      inputSchema: {},
    },
    async () => {
      const data = await client.get("/projects/all");
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.registerTool(
    "project_detail",
    {
      description: "Obtener información detallada de una obra: nombre, responsable, geofences, estatus y empleados asignados.",
      inputSchema: {
        project_id: z.string().describe("ID de la obra/proyecto"),
      },
    },
    async ({ project_id }) => {
      const data = await client.get(`/projects/${project_id}`);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.registerTool(
    "project_employees",
    {
      description: "Ver los empleados asignados a una obra específica con su rol y permisos en el proyecto.",
      inputSchema: {
        project_id: z.string().describe("ID de la obra/proyecto"),
      },
    },
    async ({ project_id }) => {
      const data = await client.get(`/projects/${project_id}/employees`);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );
}
