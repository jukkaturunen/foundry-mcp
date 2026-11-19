#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { FoundryBridge } from "./bridge.js";
import { registerTools } from "./tools.js";

const VERSION = "0.2.1";

async function main(): Promise<void> {
  const token = process.env.FOUNDRY_MCP_TOKEN;
  if (!token || token.length < 16) {
    process.stderr.write(
      "[foundry-mcp] Set FOUNDRY_MCP_TOKEN to a secret of at least 16 characters, and put the same value in the Foundry module's settings.\n",
    );
    process.exit(1);
  }

  const bridge = new FoundryBridge({
    host: process.env.FOUNDRY_MCP_HOST ?? "127.0.0.1",
    port: Number(process.env.FOUNDRY_MCP_PORT ?? 37777),
    token,
  });
  await bridge.start();

  const server = new McpServer({ name: "foundry-mcp", version: VERSION });
  registerTools(server, bridge);
  await server.connect(new StdioServerTransport());

  const shutdown = async () => {
    await bridge.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.stdin.on("close", shutdown);
}

main().catch((err) => {
  process.stderr.write(`[foundry-mcp] ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
