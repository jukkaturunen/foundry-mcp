import { createServer } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { FoundryBridge } from "../src/bridge.js";
import { SharedBridge } from "../src/shared.js";

const TOKEN = "test-token-0123456789";
const live: { stop(): Promise<void> }[] = [];
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const s of sockets.splice(0)) s.terminate();
  for (const b of live.splice(0)) await b.stop();
});

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = createServer().listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      srv.close(() => resolve(typeof addr === "object" && addr ? addr.port : 0));
    });
  });
}

function shared(port: number, token = TOKEN) {
  const b = new SharedBridge({ host: "127.0.0.1", port, token, requestTimeoutMs: 1000, maxRetryMs: 100, log: () => {} });
  live.push(b);
  return b;
}

async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** A fake Foundry module that, like the real one, reconnects when the server goes away. */
function fakeFoundry(port: number, name: string) {
  const state = { stopped: false, ws: undefined as WebSocket | undefined };
  const connect = () => {
    if (state.stopped) return;
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    state.ws = ws;
    sockets.push(ws);
    ws.on("open", () => ws.send(JSON.stringify({ type: "hello", token: TOKEN, world: "w1", worldTitle: "World", user: "GM" })));
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === "request") {
        const result = msg.method === "fail" ? undefined : { from: name, method: msg.method, params: msg.params };
        ws.send(
          JSON.stringify(
            msg.method === "fail" ? { type: "response", id: msg.id, ok: false, error: "boom" } : { type: "response", id: msg.id, ok: true, result },
          ),
        );
      }
    });
    ws.on("error", () => {});
    ws.on("close", () => setTimeout(connect, 50));
  };
  connect();
  live.push({ stop: async () => void ((state.stopped = true), state.ws?.terminate()) });
  return state;
}

describe("SharedBridge", () => {
  it("lets a second process share the first one's Foundry connection", async () => {
    const port = await freePort();
    const a = shared(port);
    expect(await a.start()).toBe("owner");
    const b = shared(port);
    expect(await b.start()).toBe("peer");
    expect(b.connected).toBe(false);
    await expect(b.request("status")).rejects.toThrow(/not connected/);

    fakeFoundry(port, "foundry");
    await until(() => b.connected);
    expect(b.clientInfo).toMatchObject({ world: "w1", user: "GM" });
    await expect(b.request("scenes.list", { x: 1 })).resolves.toEqual({ from: "foundry", method: "scenes.list", params: { x: 1 } });
    await expect(a.request("scenes.list")).resolves.toMatchObject({ method: "scenes.list" });
    await expect(b.request("fail")).rejects.toThrow("boom");
  });

  it("hands the port and Foundry over to a peer when the owner exits", async () => {
    const port = await freePort();
    const a = shared(port);
    await a.start();
    const b = shared(port);
    const c = shared(port);
    await b.start();
    await c.start();
    fakeFoundry(port, "foundry");
    await until(() => b.connected && c.connected);

    await a.stop();
    await until(() => b.role === "owner" || c.role === "owner");
    const [owner, other] = b.role === "owner" ? [b, c] : [c, b];
    await until(() => other.role === "peer" && owner.connected && other.connected);
    await expect(other.request("journals.list")).resolves.toMatchObject({ method: "journals.list" });
    await expect(owner.request("journals.list")).resolves.toMatchObject({ method: "journals.list" });
  });

  it("does not let a peer replace the Foundry module", async () => {
    const port = await freePort();
    const a = shared(port);
    await a.start();
    const foundry = fakeFoundry(port, "foundry");
    await until(() => a.connected);
    const first = foundry.ws;
    await shared(port).start();
    expect(a.connected).toBe(true);
    expect(foundry.ws).toBe(first);
  });

  it("keeps retrying when the port is held by a server with another token", async () => {
    const port = await freePort();
    const other = new FoundryBridge({ host: "127.0.0.1", port, token: "some-other-token-0123", log: () => {} });
    await other.start();
    live.push(other);
    const b = shared(port);
    let role: string | undefined;
    void b.start().then((r) => (role = r));
    await new Promise((r) => setTimeout(r, 300));
    expect(role).toBeUndefined();
    expect(b.role).toBe("starting");
    await expect(b.request("status")).rejects.toThrow(/handed over/);
    await other.stop();
    await until(() => role === "owner");
  });
});
