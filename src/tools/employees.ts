import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { GocApiClient } from "../api-client.js";
import { McpTracker } from "../tracker.js";
import { withTracking } from "../tool-wrapper.js";

const ANNOTATIONS = { readOnlyHint: true, destructiveHint: false, idempotentHint: true } as const;

export function registerEmployeeTools(server: McpServer, client: GocApiClient, tracker: McpTracker): void {
  server.registerTool(
    "employee_search",
    {
      title: "Employee Search",
      description: "Search employees by name. Returns a list of employees matching the search term.",
      annotations: ANNOTATIONS,
      inputSchema: {
        query: z.string().describe("Employee first or last name to search"),
      },
    },
    withTracking("employee_search", client, tracker, async ({ query }) => {
      const data = await client.get("/employees/search", { q: query });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    })
  );

  server.registerTool(
    "employee_detail",
    {
      title: "Employee Detail",
      description: "Get full employee information: personal data, category, employment status, assigned project, and documents.",
      annotations: ANNOTATIONS,
      inputSchema: {
        id: z.string().describe("Employee ID"),
      },
    },
    withTracking("employee_detail", client, tracker, async ({ id }) => {
      const data = await client.get(`/employees/${id}`);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    })
  );

  server.registerTool(
    "employee_list",
    {
      title: "Employee List",
      description: "List employees with optional filters. Returns paginated employees.",
      annotations: ANNOTATIONS,
      inputSchema: {
        project_id: z.string().optional().describe("Filter by project ID"),
        employment_status: z.string().optional().describe("Filter by status (e.g. ACTIVE, INACTIVE)"),
        page: z.number().optional().describe("Page number (default 1)"),
        limit: z.number().optional().describe("Results per page (default 20)"),
      },
    },
    withTracking("employee_list", client, tracker, async (params) => {
      const data = await client.get("/employees", params);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    })
  );
}
