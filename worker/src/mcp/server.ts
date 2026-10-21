import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { ConnectorEnv } from "../app";
import { audit } from "../lib/audit";
import { DAILY_COLUMNS, healthDaily } from "./tools/daily";
import { healthIntraday } from "./tools/intraday";
import { healthSleep } from "./tools/sleep";

export async function mcp(request: Request, env: ConnectorEnv, ctx: ExecutionContext): Promise<Response> {
  const server = new McpServer({ name: "pixel-health", version: "0.1.0" });
  const annotations = { readOnlyHint: true, openWorldHint: false };
  const call = async (name: string, args: object, query: () => Promise<Record<string, unknown>>): Promise<CallToolResult> => {
    const started = Date.now();
    let error: string | undefined;
    try {
      const result = await query();
      return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
    } catch (cause) {
      error = cause instanceof RangeError ? cause.message : "Unable to read health data";
      return { isError: true, content: [{ type: "text", text: error }] };
    } finally {
      audit(ctx, env.DB, { kind: "tool", name, args, started, error });
    }
  };
  server.registerTool("health_daily", {
    description: "Read daily health summaries for up to 90 dates.",
    inputSchema: {
      start: z.string().describe("Start date in YYYY-MM-DD format; inclusive range must contain 1 to 90 dates."),
      end: z.string().describe("End date in YYYY-MM-DD format; inclusive range must contain 1 to 90 dates."),
      metrics: z.array(z.string()).optional().describe(`Non-empty array of distinct metric names: ${DAILY_COLUMNS.join(", ")}. Omit for all metrics.`),
    }, annotations,
  }, (args) => call("health_daily", args, () => healthDaily(env.DB, args)));
  server.registerTool("health_sleep", {
    description: "Read sleep sessions and stages for up to 31 dates.",
    inputSchema: {
      start: z.string().describe("Start date in YYYY-MM-DD format; inclusive range must contain 1 to 31 dates."),
      end: z.string().describe("End date in YYYY-MM-DD format; inclusive range must contain 1 to 31 dates."),
    }, annotations,
  }, (args) => call("health_sleep", args, () => healthSleep(env.DB, args)));
  server.registerTool("health_intraday", {
    description: "Read intraday heart rate at 1m, 5m or 1h resolution.",
    inputSchema: {
      metric: z.string().describe("Metric name: hr (heart rate)."),
      date: z.string().describe("Date in YYYY-MM-DD format, between 2000-01-01 and 2099-12-31 inclusive."),
      resolution: z.string().describe("Resolution: 1m, 5m or 1h."),
    }, annotations,
  }, (args) => call("health_intraday", args, () => healthIntraday(env.DB, {
    ...args, resolution: args.resolution as Parameters<typeof healthIntraday>[1]["resolution"],
  })));
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  return transport.handleRequest(request);
}
