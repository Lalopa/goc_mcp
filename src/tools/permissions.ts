import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { GocApiClient } from "../api-client.js";
import { McpTracker } from "../tracker.js";
import { withTracking } from "../tool-wrapper.js";

const id = z.number().int().positive();
const ids = z.array(id).min(1).max(100);
const projectModule = z.enum(["orders", "tools", "employees"]);
const flags = {
  view: z.boolean().optional(), create: z.boolean().optional(),
  edit: z.boolean().optional(), delete: z.boolean().optional(),
};
const paging = { page: id.default(1), limit: id.max(100).default(25) };

const query = z.discriminatedUnion("scope", [
  z.object({ scope: z.literal("modules"), moduleIds: ids.optional(), ...paging }).strict(),
  z.object({ scope: z.literal("roles"), userIds: ids.optional(), roleIds: ids.optional(), moduleIds: ids.optional(), action: z.enum(["view", "create", "edit", "delete"]).optional(), ...paging }).strict(),
  z.object({ scope: z.literal("users"), userIds: ids.optional(), roleIds: ids.optional(), moduleIds: ids.optional(), action: z.enum(["view", "create", "edit", "delete"]).optional(), ...paging }).strict(),
  z.object({ scope: z.literal("project"), projectModule, projectId: id.optional(), userIds: ids.optional(), roleIds: ids.optional(), permissionType: z.enum(["read", "edit"]).optional(), ...paging }).strict(),
]);

const edit = z.discriminatedUnion("scope", [
  z.object({
    scope: z.literal("roles"), roleId: id,
    permissions: z.array(z.object({ moduleId: id, ...flags }).strict().refine(p => [p.view, p.create, p.edit, p.delete].some(v => v !== undefined), "Provide at least one action")).min(1).max(100),
  }).strict(),
  z.object({
    scope: z.literal("project"), projectId: id, projectModule,
    userIds: ids.optional(), roleIds: ids.optional(),
    permissionType: z.enum(["read", "edit"]).nullable().describe("null revokes the project permission; read/edit assign or change it"),
  }).strict().refine(p => p.userIds?.length || p.roleIds?.length, "Provide userIds or roleIds"),
]);

export function registerPermissionTools(server: McpServer, client: GocApiClient, tracker: McpTracker): void {
  server.registerTool("permissions_view", {
    title: "View Permissions",
    description: "Administrators only. Query module catalog (scope modules), general role permissions (scope roles), users holding a role/permission (scope users), or project assignments (scope project: orders/tools/employees). Filter roles/users by one/multiple userIds, roleIds, moduleIds or action; multiple moduleIds match any. Returns pagination; follow hasMore with the next page. User general permissions come from their role. Project assignments alone do not grant all module actions; administrator bypasses and resource-specific rules still apply. Use module catalog to discover valid module IDs and supported actions.",
    inputSchema: { query },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  }, withTracking("permissions_view", client, tracker, async ({ query: input }) => {
    await client.assertAdministrator();
    const data = await client.post("/permissions/query", input);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }));

  server.registerTool("permissions_edit", {
    title: "Edit Permissions",
    description: "Administrators only. Apply partial permission changes atomically. scope roles changes general module actions for the ENTIRE role and all its users; omitted actions/modules are preserved. scope project assigns/changes read or edit, or revokes with permissionType null, for users and/or the current users of roles on one project (orders/tools/employees). Role recipients are a snapshot, not future inheritance. Other users/projects are preserved. Web permission dependencies and supported module actions are enforced by the API. Result includes before/after and affected users. Query permissions first to identify exact IDs and understand impact. Revoking an assignment does not remove administrator bypass access.",
    inputSchema: { edit },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  }, withTracking("permissions_edit", client, tracker, async ({ edit: input }) => {
    await client.assertAdministrator();
    const data = await client.patch("/permissions/manage", input);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }));
}
