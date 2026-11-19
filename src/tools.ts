import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
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

  // ---- Scenes ----

  const id = z.string().min(1);
  const folder = z
    .string()
    .nullable()
    .optional()
    .describe("Folder id (from Foundry). null moves it out of any folder.");
  const sceneFields = {
    width: z.number().int().positive().optional().describe("Scene width in pixels"),
    height: z.number().int().positive().optional().describe("Scene height in pixels"),
    gridSize: z.number().int().min(10).optional().describe("Grid square size in pixels"),
    navigation: z.boolean().optional().describe("Show the scene in the navigation bar"),
    background: z
      .string()
      .optional()
      .describe("Path of an image already on the Foundry server, e.g. worlds/myworld/maps/crypt.webp. Set on the scene's initial level."),
  };

  server.registerTool(
    "get_scene",
    {
      title: "Get scene",
      description: "Get one scene by id, with its size, grid, background image and levels.",
      inputSchema: { id },
      annotations: { readOnlyHint: true },
    },
    (args) => call(bridge, "scenes.get", args),
  );

  server.registerTool(
    "create_scene",
    {
      title: "Create scene",
      description: "Create a new scene. Optionally set its folder, size, grid and background image.",
      inputSchema: { name: z.string().min(1), folder, ...sceneFields },
    },
    (args) => call(bridge, "scenes.create", args),
  );

  server.registerTool(
    "update_scene",
    {
      title: "Update scene",
      description: "Change a scene's name, folder, size, grid, navigation or background image. Only the given fields change.",
      inputSchema: { id, name: z.string().min(1).optional(), folder, ...sceneFields },
    },
    (args) => call(bridge, "scenes.update", args),
  );

  server.registerTool(
    "delete_scene",
    {
      title: "Delete scene",
      description: "Permanently delete a scene and everything on it (tokens, walls, lights, ...). Cannot be undone.",
      inputSchema: { id },
      annotations: { destructiveHint: true },
    },
    (args) => call(bridge, "scenes.delete", args),
  );

  // ---- Journal entries ----

  const pageFields = {
    type: z.enum(["text", "image"]).optional().describe('Page type. Defaults to "image" when src is given, otherwise "text".'),
    text: z.string().optional().describe("HTML content of a text page"),
    src: z.string().optional().describe("Path of an image on the Foundry server, for image pages"),
    caption: z.string().optional().describe("Caption of an image page"),
  };

  server.registerTool(
    "get_journal",
    {
      title: "Get journal entry",
      description: "Get one journal entry by id, with all its pages including text page HTML and image paths.",
      inputSchema: { id },
      annotations: { readOnlyHint: true },
    },
    (args) => call(bridge, "journals.get", args),
  );

  server.registerTool(
    "create_journal",
    {
      title: "Create journal entry",
      description: "Create a journal entry, optionally in a folder and with text and image pages.",
      inputSchema: {
        name: z.string().min(1),
        folder,
        pages: z.array(z.object({ name: z.string().optional(), ...pageFields })).optional(),
      },
    },
    (args) => call(bridge, "journals.create", args),
  );

  server.registerTool(
    "update_journal",
    {
      title: "Update journal entry",
      description: "Rename a journal entry or move it to another folder. Use the page tools to change its content.",
      inputSchema: { id, name: z.string().min(1).optional(), folder },
    },
    (args) => call(bridge, "journals.update", args),
  );

  server.registerTool(
    "delete_journal",
    {
      title: "Delete journal entry",
      description: "Permanently delete a journal entry and all its pages. Cannot be undone.",
      inputSchema: { id },
      annotations: { destructiveHint: true },
    },
    (args) => call(bridge, "journals.delete", args),
  );

  server.registerTool(
    "create_journal_page",
    {
      title: "Add journal page",
      description: "Add a text or image page to a journal entry.",
      inputSchema: { journalId: id, name: z.string().optional(), ...pageFields },
    },
    (args) => call(bridge, "pages.create", args),
  );

  server.registerTool(
    "update_journal_page",
    {
      title: "Update journal page",
      description: "Change a journal page's name, HTML text, image path or caption. Only the given fields change.",
      inputSchema: { journalId: id, pageId: id, name: z.string().optional(), ...pageFields },
    },
    (args) => call(bridge, "pages.update", args),
  );

  server.registerTool(
    "delete_journal_page",
    {
      title: "Delete journal page",
      description: "Permanently delete one page from a journal entry. Cannot be undone.",
      inputSchema: { journalId: id, pageId: id },
      annotations: { destructiveHint: true },
    },
    (args) => call(bridge, "pages.delete", args),
  );
}
