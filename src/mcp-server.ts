import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { GocApiClient } from "./api-client.js";
import { registerEmployeeTools } from "./tools/employees.js";
import { registerAttendanceTools } from "./tools/attendance.js";
import { registerOrderTools } from "./tools/orders.js";
import { registerProjectTools } from "./tools/projects.js";

export function createMcpServer(jwt: string): McpServer {
  const server = new McpServer({
    name: "goc",
    version: "1.0.0",
  });

  const client = new GocApiClient(jwt);

  registerEmployeeTools(server, client);
  registerAttendanceTools(server, client);
  registerOrderTools(server, client);
  registerProjectTools(server, client);

  return server;
}
