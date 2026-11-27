// Starts a built server (default: the bundle) over stdio and checks that it lists its tools.
// Usage: node scripts/smoke.mjs [command...]
import { spawn } from "node:child_process";

const cmd = process.argv.length > 2 ? process.argv.slice(2) : [process.execPath, "bundle/foundry-mcp.mjs"];
const child = spawn(cmd[0], cmd.slice(1), {
  env: { ...process.env, FOUNDRY_MCP_TOKEN: "smoke-test-token-0123456789", FOUNDRY_MCP_PORT: "" },
  stdio: ["pipe", "pipe", "inherit"],
});
const send = (msg) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");
const timer = setTimeout(() => fail("no answer within 60 s"), 60_000);
function fail(why) {
  console.error(`smoke test failed: ${why}`);
  child.kill();
  process.exit(1);
}

let buf = "";
child.stdout.on("data", (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const msg = JSON.parse(buf.slice(0, i));
    buf = buf.slice(i + 1);
    if (msg.id === 1) {
      send({ method: "notifications/initialized" });
      send({ id: 2, method: "tools/list" });
    } else if (msg.id === 2) {
      const names = msg.result.tools.map((t) => t.name);
      if (!names.includes("foundry_status")) fail(`unexpected tools: ${names.join(", ")}`);
      console.log(`smoke test ok: ${names.length} tools`);
      clearTimeout(timer);
      child.stdin.end();
      child.kill();
      process.exit(0);
    }
  }
});
child.on("exit", (code) => fail(`server exited with ${code}`));
send({
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "0" } },
});
