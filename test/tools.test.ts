import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { FoundryBridge } from "../src/bridge.js";
import { registerTools } from "../src/tools.js";
import { makePng } from "./png.js";

const TOKEN = "tools-test-token-0123456789";
let bridge: FoundryBridge;
let client: Client;
let ws: WebSocket;
let calls: { method: string; params: any }[];
let png: string;

beforeEach(async () => {
  calls = [];
  bridge = new FoundryBridge({ host: "127.0.0.1", port: 0, token: TOKEN, log: () => {} });
  const port = await bridge.start();

  // Fake Foundry: records requests and answers with something plausible.
  ws = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise<void>((resolve) => {
    ws.on("open", () => ws.send(JSON.stringify({ type: "hello", token: TOKEN, world: "motw" })));
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === "welcome") resolve();
      if (msg.type !== "request") return;
      calls.push({ method: msg.method, params: msg.params });
      const result =
        msg.method === "files.upload" ? { path: `${msg.params.dir}/${msg.params.fileName}` } : { id: "x", ...msg.params };
      ws.send(JSON.stringify({ type: "response", id: msg.id, ok: true, result }));
    });
  });

  const server = new McpServer({ name: "test", version: "0" });
  registerTools(server, bridge);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  client = new Client({ name: "test", version: "0" });
  await client.connect(b);

  const dir = await mkdtemp(join(tmpdir(), "foundry-mcp-tools-"));
  png = join(dir, "Crypt Map.png");
  await writeFile(png, makePng(640, 480));
});

afterEach(async () => {
  ws.terminate();
  await client.close();
  await bridge.stop();
});

const text = (r: any) => JSON.parse(r.content[0].text);

describe("image tools", () => {
  it("create_scene_from_image uploads and creates a scene sized to the image", async () => {
    const r = await client.callTool({ name: "create_scene_from_image", arguments: { localPath: png, name: "Crypt", gridSize: 100 } });
    expect(r.isError).toBeFalsy();
    expect(calls.map((c) => c.method)).toEqual(["files.upload", "scenes.create"]);
    expect(calls[0].params).toMatchObject({ dir: "worlds/motw/mcp-uploads/scenes", fileName: "Crypt-Map.png", mime: "image/png", overwrite: false });
    expect(calls[1].params).toMatchObject({
      name: "Crypt",
      gridSize: 100,
      width: 640,
      height: 480,
      background: "worlds/motw/mcp-uploads/scenes/Crypt-Map.png",
    });
    expect(text(r).uploaded).toMatchObject({ width: 640, height: 480 });
  });

  it("set_scene_background_from_file can keep the scene size", async () => {
    await client.callTool({ name: "set_scene_background_from_file", arguments: { id: "s1", localPath: png, resize: false } });
    expect(calls[1]).toEqual({ method: "scenes.update", params: { id: "s1", background: "worlds/motw/mcp-uploads/scenes/Crypt-Map.png" } });
  });

  it("add_journal_image_from_file adds an image page", async () => {
    await client.callTool({
      name: "add_journal_image_from_file",
      arguments: { journalId: "j1", localPath: png, caption: "The crypt", targetDir: "worlds/motw/handouts" },
    });
    expect(calls[0].params.dir).toBe("worlds/motw/handouts");
    expect(calls[1]).toEqual({
      method: "pages.create",
      params: { journalId: "j1", type: "image", name: "Crypt-Map", src: "worlds/motw/handouts/Crypt-Map.png", caption: "The crypt" },
    });
  });

  it("rejects target folders that climb out with ..", async () => {
    const r = await client.callTool({ name: "upload_image", arguments: { localPath: png, targetDir: "worlds/../../etc" } });
    expect(r.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("reports a missing local file as a tool error", async () => {
    const r = await client.callTool({ name: "upload_image", arguments: { localPath: "/nope/x.png" } });
    expect(r.isError).toBe(true);
    expect((r.content as any)[0].text).toMatch(/not found/);
  });
});
