import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { GocApiClient } from "../api-client.js";
import { McpTracker } from "../tracker.js";
import { withTracking } from "../tool-wrapper.js";

const ANNOTATIONS = { readOnlyHint: true, destructiveHint: false, idempotentHint: true } as const;

export function registerAttendanceTools(server: McpServer, client: GocApiClient, tracker: McpTracker): void {
  server.registerTool(
    "attendance_history",
    {
      title: "Attendance History",
      description: "Attendance history. Filter by employee, project, and date range. Returns records with who attended, when, and how (FACE/QR/MANUAL).",
      annotations: ANNOTATIONS,
      inputSchema: {
        employee_id: z.string().optional().describe("Employee ID"),
        project_id: z.string().optional().describe("Project ID"),
        from: z.string().optional().describe("Start date in YYYY-MM-DD format"),
        to: z.string().optional().describe("End date in YYYY-MM-DD format"),
        page: z.number().optional().describe("Page number (default 1)"),
        limit: z.number().optional().describe("Results per page"),
      },
    },
    withTracking("attendance_history", client, tracker, async (params) => {
      const data = await client.get("/face-recognition/attendance/history", params);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    })
  );

  server.registerTool(
    "attendance_detail",
    {
      title: "Attendance Detail",
      description: "Get full details of an attendance record: employee, date, check-in/check-out time, method (FACE/QR/MANUAL), and images.",
      annotations: ANNOTATIONS,
      inputSchema: {
        id: z.string().describe("Attendance record ID"),
      },
    },
    withTracking("attendance_detail", client, tracker, async ({ id }) => {
      const data = await client.get(`/face-recognition/attendance/history/${id}`);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    })
  );

  server.registerTool(
    "attendance_summary",
    {
      title: "Attendance Summary",
      description: "Attendance summary grouped by project and day. Useful to see how many employees attended each project on a given date.",
      annotations: ANNOTATIONS,
      inputSchema: {
        date: z.string().optional().describe("Date in YYYY-MM-DD format (defaults to today)"),
        project_id: z.string().optional().describe("Filter by project ID"),
      },
    },
    withTracking("attendance_summary", client, tracker, async (params) => {
      const data = await client.get("/face-recognition/attendance/summary", params);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    })
  );

  server.registerTool(
    "attendance_today",
    {
      title: "Today's Attendance",
      description: "View all attendance records for today, including real-time check-ins and check-outs.",
      annotations: ANNOTATIONS,
      inputSchema: {},
    },
    withTracking("attendance_today", client, tracker, async () => {
      const data = await client.get("/face-recognition/attendance/today");
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    })
  );

  server.registerTool(
    "attendance_stats",
    {
      title: "Attendance Stats",
      description: "General attendance statistics: totals, averages, and metrics by period.",
      annotations: ANNOTATIONS,
      inputSchema: {},
    },
    withTracking("attendance_stats", client, tracker, async () => {
      const data = await client.get("/face-recognition/stats");
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    })
  );
}
