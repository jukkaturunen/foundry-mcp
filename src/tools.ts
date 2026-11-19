import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { FoundryBridge } from "./bridge.js";

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

function ok(value: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function fail(err: unknown): ToolResult {
  return { content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }], isError: true };
}

/** Run a bridge request and wrap the result (or error) as an MCP tool result. */
async function call(bridge: FoundryBridge, method: string, params: unknown = {}): Promise<ToolResult> {
  try {
    return ok(await bridge.request(method, params));
  } catch (err) {
    return fail(err);
  }
}

export function registerTools(server: McpServer, bridge: FoundryBridge): void {
  server.registerTool(
    "foundry_status",
    {
      title: "Foundry connection status",
      description:
        "Check whether a Foundry VTT world is connected, and which world, system, Foundry version and GM user it is.",
      inputSchema: {},
    },
    async () => {
      if (!bridge.connected) {
        return ok({ connected: false, hint: "Open the Foundry world in a browser as a GM with the Foundry MCP Bridge module enabled." });
      }
      try {
        return ok({ connected: true, ...(await bridge.request<object>("status")) });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "list_scenes",
    {
      title: "List scenes",
      description: "List all scenes in the connected Foundry world with their id, name, folder, size and background image.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    () => call(bridge, "scenes.list"),
  );

  server.registerTool(
    "list_journals",
    {
      title: "List journal entries",
      description: "List all journal entries in the connected Foundry world with their id, name, folder and pages.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    () => call(bridge, "journals.list"),
  );
}
