import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { GocApiClient } from "../api-client.js";

export function registerAttendanceTools(server: McpServer, client: GocApiClient): void {
  server.registerTool(
    "attendance_history",
    {
      description: "Historial de asistencias. Permite filtrar por empleado, obra, y rango de fechas. Devuelve registros con quién asistió, cuándo y cómo (FACE/QR/MANUAL).",
      inputSchema: {
        employee_id: z.string().optional().describe("ID del empleado"),
        project_id: z.string().optional().describe("ID de la obra/proyecto"),
        from: z.string().optional().describe("Fecha inicio en formato YYYY-MM-DD"),
        to: z.string().optional().describe("Fecha fin en formato YYYY-MM-DD"),
        page: z.number().optional().describe("Número de página (por defecto 1)"),
        limit: z.number().optional().describe("Resultados por página"),
      },
    },
    async (params) => {
      const data = await client.get("/face-recognition/attendance/history", params);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.registerTool(
    "attendance_detail",
    {
      description: "Obtener el detalle completo de un registro de asistencia: empleado, fecha, hora de entrada/salida, método (FACE/QR/MANUAL) e imágenes.",
      inputSchema: {
        id: z.string().describe("ID del registro de asistencia"),
      },
    },
    async ({ id }) => {
      const data = await client.get(`/face-recognition/attendance/history/${id}`);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.registerTool(
    "attendance_summary",
    {
      description: "Resumen de asistencias agrupadas por proyecto y día. Útil para ver cuántos empleados asistieron a cada obra en una fecha.",
      inputSchema: {
        date: z.string().optional().describe("Fecha en formato YYYY-MM-DD (por defecto hoy)"),
        project_id: z.string().optional().describe("Filtrar por ID de obra"),
      },
    },
    async (params) => {
      const data = await client.get("/face-recognition/attendance/summary", params);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.registerTool(
    "attendance_today",
    {
      description: "Ver todas las asistencias registradas en el día de hoy, incluyendo entradas y salidas en tiempo real.",
      inputSchema: {},
    },
    async () => {
      const data = await client.get("/face-recognition/attendance/today");
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.registerTool(
    "attendance_stats",
    {
      description: "Estadísticas generales de asistencia: totales, promedios y métricas por período.",
      inputSchema: {},
    },
    async () => {
      const data = await client.get("/face-recognition/stats");
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );
}
