import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { GocApiClient } from "./api-client.js";
import { McpTracker } from "./tracker.js";
import { registerEmployeeTools } from "./tools/employees.js";
import { registerAttendanceTools } from "./tools/attendance.js";
import { registerOrderTools } from "./tools/orders.js";
import { registerProjectTools } from "./tools/projects.js";

export function createMcpServer(client: GocApiClient, tracker: McpTracker): McpServer {
  const server = new McpServer({
    name: "goc",
    version: "1.0.0",
  });

  registerEmployeeTools(server, client, tracker);
  registerAttendanceTools(server, client, tracker);
  registerOrderTools(server, client, tracker);
  registerProjectTools(server, client, tracker);

  return server;
}
