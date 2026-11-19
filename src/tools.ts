import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { FoundryBridge } from "./bridge.js";
import { readLocalImage } from "./images.js";

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

  // ---- Images ----

  const localPath = z.string().min(1).describe("Path of the image on this computer, e.g. ~/Pictures/map.webp");
  const targetDir = z
    .string()
    .regex(/^[A-Za-z0-9 _./-]+$/)
    .refine((d) => !d.split("/").includes(".."), "must not contain ..")
    .optional()
    .describe('Folder in Foundry\'s data storage. Default: "worlds/<world>/mcp-uploads/<scenes|journal|images>"');
  const fileName = z.string().min(1).optional().describe("File name to use in Foundry. Default: the local file name");
  const overwrite = z.boolean().optional().describe("Replace a file with the same name instead of adding -1, -2, ...");

  /** Upload a local image and return its Foundry path plus pixel size. */
  async function upload(args: { localPath: string; targetDir?: string; fileName?: string; overwrite?: boolean }, kind: string) {
    const world = bridge.clientInfo?.world;
    if (!world && !args.targetDir) throw new Error("Foundry is not connected.");
    const img = await readLocalImage(args.localPath, args.fileName);
    const dir = (args.targetDir ?? `worlds/${world}/mcp-uploads/${kind}`).replace(/^\/+|\/+$/g, "");
    const { path } = await bridge.request<{ path: string }>(
      "files.upload",
      { dir, fileName: img.fileName, mime: img.mime, data: img.data, overwrite: !!args.overwrite },
      120_000,
    );
    return { path, width: img.width, height: img.height, bytes: img.bytes };
  }

  async function run(fn: () => Promise<unknown>): Promise<ToolResult> {
    try {
      return ok(await fn());
    } catch (err) {
      return fail(err);
    }
  }

  server.registerTool(
    "upload_image",
    {
      title: "Upload image",
      description:
        "Upload an image from this computer into Foundry's data storage. Returns its Foundry path, which can be used as a scene background or an image page.",
      inputSchema: { localPath, targetDir, fileName, overwrite },
    },
    (args) => run(() => upload(args, "images")),
  );

  server.registerTool(
    "create_scene_from_image",
    {
      title: "Create scene from image",
      description:
        "Upload an image from this computer and create a new scene with it as the background. The scene gets the image's size.",
      inputSchema: {
        localPath,
        name: z.string().min(1),
        folder,
        gridSize: sceneFields.gridSize,
        navigation: sceneFields.navigation,
        targetDir,
        fileName,
        overwrite,
      },
    },
    (args) =>
      run(async () => {
        const img = await upload(args, "scenes");
        const scene = await bridge.request("scenes.create", {
          name: args.name,
          folder: args.folder,
          gridSize: args.gridSize,
          navigation: args.navigation,
          background: img.path,
          ...(img.width && img.height ? { width: img.width, height: img.height } : {}),
        });
        return { uploaded: img, scene };
      }),
  );

  server.registerTool(
    "set_scene_background_from_file",
    {
      title: "Set scene background from file",
      description:
        "Upload an image from this computer and make it the background of an existing scene. By default the scene is resized to the image.",
      inputSchema: {
        id,
        localPath,
        resize: z.boolean().optional().describe("Resize the scene to the image size (default true)"),
        targetDir,
        fileName,
        overwrite,
      },
    },
    (args) =>
      run(async () => {
        const img = await upload(args, "scenes");
        const resize = args.resize !== false && img.width && img.height;
        const scene = await bridge.request("scenes.update", {
          id: args.id,
          background: img.path,
          ...(resize ? { width: img.width, height: img.height } : {}),
        });
        return { uploaded: img, scene };
      }),
  );

  server.registerTool(
    "add_journal_image_from_file",
    {
      title: "Add image page from file",
      description: "Upload an image from this computer and add it as an image page to a journal entry.",
      inputSchema: {
        journalId: id,
        localPath,
        name: z.string().optional().describe("Page name. Default: the file name without extension"),
        caption: z.string().optional(),
        targetDir,
        fileName,
        overwrite,
      },
    },
    (args) =>
      run(async () => {
        const img = await upload(args, "journal");
        const defaultName = img.path.split("/").pop()!.replace(/\.[^.]+$/, "");
        const page = await bridge.request("pages.create", {
          journalId: args.journalId,
          type: "image",
          name: args.name ?? defaultName,
          src: img.path,
          caption: args.caption,
        });
        return { uploaded: img, page };
      }),
  );
}
