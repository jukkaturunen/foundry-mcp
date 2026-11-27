// Builds the Claude Desktop extension, foundry-mcp.mcpb, from bundle/foundry-mcp.mjs
// and mcpb/manifest.json. Run `npm run bundle` first.
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const { version } = JSON.parse(readFileSync("package.json", "utf8"));
const manifest = JSON.parse(readFileSync("mcpb/manifest.json", "utf8"));
manifest.version = version;

const stage = "build/mcpb";
rmSync(stage, { recursive: true, force: true });
mkdirSync(`${stage}/server`, { recursive: true });
cpSync("bundle/foundry-mcp.mjs", `${stage}/server/index.mjs`);
cpSync("mcpb/icon.png", `${stage}/icon.png`);
writeFileSync(`${stage}/manifest.json`, JSON.stringify(manifest, null, 2) + "\n");

const mcpb = "node_modules/@anthropic-ai/mcpb/dist/cli/cli.js";
execFileSync(process.execPath, [mcpb, "validate", `${stage}/manifest.json`], { stdio: "inherit" });
execFileSync(process.execPath, [mcpb, "pack", stage, "foundry-mcp.mcpb"], { stdio: "inherit" });
