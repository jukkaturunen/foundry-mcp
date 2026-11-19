import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { FoundryBridge } from "../src/bridge.js";

const TOKEN = "test-token-0123456789";

let bridge: FoundryBridge;
let port: number;
const sockets: WebSocket[] = [];

beforeEach(async () => {
  bridge = new FoundryBridge({ host: "127.0.0.1", port: 0, token: TOKEN, requestTimeoutMs: 500, log: () => {} });
  port = await bridge.start();
});

afterEach(async () => {
  for (const s of sockets.splice(0)) s.terminate();
  await bridge.stop();
});

/** Connect a fake Foundry client that answers requests with `answer`. */
function fakeFoundry(token: string, answer?: (method: string, params: unknown) => unknown) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  sockets.push(ws);
  const closed = new Promise<number>((resolve) => ws.on("close", (code) => resolve(code)));
  const welcomed = new Promise<void>((resolve) => {
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === "welcome") resolve();
      if (msg.type === "request" && answer) {
        try {
          ws.send(JSON.stringify({ type: "response", id: msg.id, ok: true, result: answer(msg.method, msg.params) }));
        } catch (err) {
          ws.send(JSON.stringify({ type: "response", id: msg.id, ok: false, error: (err as Error).message }));
        }
      }
    });
  });
  ws.on("open", () => ws.send(JSON.stringify({ type: "hello", token, world: "w1", worldTitle: "World", user: "GM" })));
  return { ws, welcomed, closed };
}

describe("FoundryBridge", () => {
  it("rejects requests when nothing is connected", async () => {
    expect(bridge.connected).toBe(false);
    await expect(bridge.request("status")).rejects.toThrow(/not connected/);
  });

  it("forwards requests and returns results", async () => {
    const f = fakeFoundry(TOKEN, (method, params) => ({ method, params }));
    await f.welcomed;
    expect(bridge.connected).toBe(true);
    expect(bridge.clientInfo).toMatchObject({ world: "w1", user: "GM" });
    await expect(bridge.request("scenes.list", { a: 1 })).resolves.toEqual({ method: "scenes.list", params: { a: 1 } });
  });

  it("passes errors from Foundry back to the caller", async () => {
    const f = fakeFoundry(TOKEN, () => {
      throw new Error("boom");
    });
    await f.welcomed;
    await expect(bridge.request("x")).rejects.toThrow("boom");
  });

  it("closes connections with a wrong token", async () => {
    const f = fakeFoundry("wrong-token-0123456789");
    expect(await f.closed).toBe(4003);
    expect(bridge.connected).toBe(false);
  });

  it("times out when Foundry does not answer", async () => {
    const f = fakeFoundry(TOKEN);
    await f.welcomed;
    await expect(bridge.request("slow", {}, 100)).rejects.toThrow(/did not answer/);
  });

  it("replaces an older connection with a newer one", async () => {
    const a = fakeFoundry(TOKEN, () => "a");
    await a.welcomed;
    const b = fakeFoundry(TOKEN, () => "b");
    await b.welcomed;
    expect(await a.closed).toBe(4000);
    await expect(bridge.request("who")).resolves.toBe("b");
  });

  it("rejects pending requests when Foundry disconnects", async () => {
    const f = fakeFoundry(TOKEN);
    await f.welcomed;
    const pending = bridge.request("slow", {}, 5000);
    f.ws.close();
    await expect(pending).rejects.toThrow(/disconnected/);
  });
});
