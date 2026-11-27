import { randomUUID, timingSafeEqual } from "node:crypto";
import { WebSocketServer, WebSocket, type RawData } from "ws";

/** Info the Foundry module reports when it connects. */
export interface FoundryClientInfo {
  world?: string;
  worldTitle?: string;
  system?: string;
  foundryVersion?: string;
  user?: string;
  moduleVersion?: string;
}

export interface BridgeOptions {
  host: string;
  port: number;
  token: string;
  /** Default time to wait for a reply from Foundry, in milliseconds. */
  requestTimeoutMs?: number;
  log?: (msg: string) => void;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

/** What the MCP tools need from a Foundry connection, whether this process owns it or shares another's. */
export interface FoundryConnection {
  readonly connected: boolean;
  readonly clientInfo: FoundryClientInfo | undefined;
  request<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T>;
}

/** Messages sent by the Foundry module, or by another foundry-mcp process sharing this one's connection. */
type ClientMessage =
  | ({ type: "hello"; token: string } & FoundryClientInfo)
  | { type: "response"; id: string; ok: true; result: unknown }
  | { type: "response"; id: string; ok: false; error: string }
  | { type: "peer-hello"; token: string }
  | { type: "peer-request"; id: string; method: string; params?: unknown; timeoutMs?: number };

/** Messages this server sends to a peer foundry-mcp process. */
export type PeerMessage =
  | { type: "peer-welcome" | "status"; connected: boolean; info?: FoundryClientInfo }
  | { type: "peer-response"; id: string; ok: true; result: unknown }
  | { type: "peer-response"; id: string; ok: false; error: string };

const HELLO_TIMEOUT_MS = 5000;

function tokensMatch(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export const NOT_CONNECTED =
  "Foundry is not connected. Open your Foundry world in a browser as a GM, with the JT Foundry MCP Bridge module enabled and its token set.";

/**
 * WebSocket server that the Foundry module (running in the GM's browser)
 * connects to. The MCP tools send requests through it and await replies.
 * Only one Foundry client is active at a time; a newer one replaces the older.
 *
 * Other foundry-mcp processes (for example a second MCP client on the same
 * computer) can connect as peers with the same token and send their requests
 * through this one's Foundry connection.
 */
export class FoundryBridge implements FoundryConnection {
  private wss?: WebSocketServer;
  private client?: WebSocket;
  private peers = new Set<WebSocket>();
  private info?: FoundryClientInfo;
  private pending = new Map<string, Pending>();
  private readonly log: (msg: string) => void;

  constructor(private readonly opts: BridgeOptions) {
    this.log = opts.log ?? ((msg) => process.stderr.write(`[foundry-mcp] ${msg}\n`));
  }

  /** Start listening. Resolves with the actual port (useful when port is 0). */
  start(): Promise<number> {
    return new Promise((resolve, reject) => {
      const wss = new WebSocketServer({ host: this.opts.host, port: this.opts.port, maxPayload: 256 * 1024 * 1024 });
      this.wss = wss;
      wss.once("error", reject);
      wss.once("listening", () => {
        wss.off("error", reject);
        wss.on("error", (err) => this.log(`WebSocket server error: ${err.message}`));
        const addr = wss.address();
        const port = typeof addr === "object" && addr ? addr.port : this.opts.port;
        this.log(`Waiting for Foundry on ws://${this.opts.host}:${port}`);
        resolve(port);
      });
      wss.on("connection", (ws) => this.onConnection(ws));
    });
  }

  async stop(): Promise<void> {
    this.rejectAll(new Error("Bridge stopped"));
    for (const ws of this.wss?.clients ?? []) ws.terminate();
    await new Promise<void>((resolve) => (this.wss ? this.wss.close(() => resolve()) : resolve()));
  }

  get connected(): boolean {
    return !!this.client && this.client.readyState === WebSocket.OPEN;
  }

  get clientInfo(): FoundryClientInfo | undefined {
    return this.connected ? this.info : undefined;
  }

  /** Send a request to Foundry and wait for its result. */
  request<T = unknown>(method: string, params: unknown = {}, timeoutMs = this.opts.requestTimeoutMs ?? 30000): Promise<T> {
    const ws = this.client;
    if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error(NOT_CONNECTED));
    const id = randomUUID();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Foundry did not answer "${method}" within ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      ws.send(JSON.stringify({ type: "request", id, method, params }), (err) => {
        if (err) this.settle(id, (p) => p.reject(err));
      });
    });
  }

  private onConnection(ws: WebSocket): void {
    let authed = false;
    let peer = false;
    const helloTimer = setTimeout(() => {
      if (!authed) ws.close(4001, "No hello received");
    }, HELLO_TIMEOUT_MS);

    ws.on("message", (data: RawData) => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (!authed) {
        if (msg.type === "peer-hello" && typeof msg.token === "string" && tokensMatch(msg.token, this.opts.token)) {
          authed = peer = true;
          clearTimeout(helloTimer);
          this.peers.add(ws);
          this.sendTo(ws, { type: "peer-welcome", connected: this.connected, info: this.clientInfo });
          this.log(`Another foundry-mcp process is sharing this connection (${this.peers.size} in total)`);
          return;
        }
        if (msg.type !== "hello" || typeof msg.token !== "string" || !tokensMatch(msg.token, this.opts.token)) {
          this.log("Rejected a connection with a missing or wrong token");
          ws.close(4003, "Invalid token");
          return;
        }
        authed = true;
        clearTimeout(helloTimer);
        const { type: _t, token: _tok, ...info } = msg;
        this.attach(ws, info);
        ws.send(JSON.stringify({ type: "welcome" }));
        return;
      }
      if (peer) {
        if (msg.type === "peer-request") this.servePeer(ws, msg);
        return;
      }
      if (msg.type === "response" && ws === this.client) {
        this.settle(msg.id, (p) => (msg.ok ? p.resolve(msg.result) : p.reject(new Error(msg.error))));
      }
    });

    ws.on("close", () => {
      clearTimeout(helloTimer);
      if (this.peers.delete(ws)) return;
      if (ws === this.client) {
        this.client = undefined;
        this.info = undefined;
        this.rejectAll(new Error("Foundry disconnected before answering"));
        this.log("Foundry disconnected");
        this.broadcastStatus();
      }
    });
    ws.on("error", (err) => this.log(`Client socket error: ${err.message}`));
  }

  private attach(ws: WebSocket, info: FoundryClientInfo): void {
    if (this.client && this.client !== ws) {
      this.rejectAll(new Error("Foundry connection was replaced by a newer one"));
      this.client.close(4000, "Replaced by a newer connection");
    }
    this.client = ws;
    this.info = info;
    this.log(`Foundry connected: world "${info.worldTitle ?? info.world ?? "?"}" as ${info.user ?? "?"}`);
    this.broadcastStatus();
  }

  /** Run a peer's request on this process's Foundry connection and send the result back. */
  private servePeer(ws: WebSocket, msg: { id: string; method: string; params?: unknown; timeoutMs?: number }): void {
    if (typeof msg.id !== "string" || typeof msg.method !== "string") return;
    const timeout = typeof msg.timeoutMs === "number" && msg.timeoutMs > 0 ? msg.timeoutMs : undefined;
    this.request(msg.method, msg.params ?? {}, timeout).then(
      (result) => this.sendTo(ws, { type: "peer-response", id: msg.id, ok: true, result }),
      (err: unknown) =>
        this.sendTo(ws, { type: "peer-response", id: msg.id, ok: false, error: err instanceof Error ? err.message : String(err) }),
    );
  }

  private broadcastStatus(): void {
    for (const ws of this.peers) this.sendTo(ws, { type: "status", connected: this.connected, info: this.clientInfo });
  }

  private sendTo(ws: WebSocket, msg: PeerMessage): void {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }

  private settle(id: string, fn: (p: Pending) => void): void {
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    clearTimeout(p.timer);
    fn(p);
  }

  private rejectAll(err: Error): void {
    for (const id of [...this.pending.keys()]) this.settle(id, (p) => p.reject(err));
  }
}
