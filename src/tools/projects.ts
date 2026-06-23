import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { GocApiClient } from "../api-client.js";
import { McpTracker } from "../tracker.js";
import { withTracking } from "../tool-wrapper.js";

const ANNOTATIONS = { readOnlyHint: true, destructiveHint: false, idempotentHint: true } as const;

export function registerProjectTools(server: McpServer, client: GocApiClient, tracker: McpTracker): void {
  server.registerTool(
    "project_list",
    {
      title: "Project List",
      description: "List all available projects with basic info: name, status, and person in charge.",
      annotations: ANNOTATIONS,
      inputSchema: {},
    },
    withTracking("project_list", client, tracker, async () => {
      const data = await client.get("/projects/all");
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    })
  );

  server.registerTool(
    "project_detail",
    {
      title: "Project Detail",
      description: "Get detailed project information: name, person in charge, geofences, status, and assigned employees.",
      annotations: ANNOTATIONS,
      inputSchema: {
        project_id: z.string().describe("Project ID"),
      },
    },
    withTracking("project_detail", client, tracker, async ({ project_id }) => {
      const data = await client.get(`/projects/${project_id}`);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    })
  );

  server.registerTool(
    "project_employees",
    {
      title: "Project Employees",
      description: "View employees assigned to a specific project with their role and permissions.",
      annotations: ANNOTATIONS,
      inputSchema: {
        project_id: z.string().describe("Project ID"),
      },
    },
    withTracking("project_employees", client, tracker, async ({ project_id }) => {
      const data = await client.get(`/projects/${project_id}/employees`);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    })
  );
}
