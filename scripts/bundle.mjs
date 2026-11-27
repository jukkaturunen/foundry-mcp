// Bundles the MCP server and its dependencies into one file, bundle/foundry-mcp.mjs.
// The release tarball and the Claude Desktop extension both ship only this file,
// so nothing has to be installed or built on the user's computer.
import { build } from "esbuild";
import { chmodSync } from "node:fs";

const outfile = "bundle/foundry-mcp.mjs";
await build({
  entryPoints: ["src/index.ts"],
  outfile,
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  // The shebang comes from src/index.ts. Some dependencies (ws) are CommonJS and call require() for Node built-ins.
  banner: {
    js: [
      'import { createRequire as __foundryMcpCreateRequire } from "node:module";',
      "const require = __foundryMcpCreateRequire(import.meta.url);",
    ].join("\n"),
  },
  // Optional native speedups of ws; it works without them.
  external: ["bufferutil", "utf-8-validate"],
  legalComments: "none",
  logLevel: "info",
});
chmodSync(outfile, 0o755);
