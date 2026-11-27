import { randomUUID } from "node:crypto";
import WebSocket, { type RawData } from "ws";
import { FoundryBridge, NOT_CONNECTED, type BridgeOptions, type FoundryClientInfo, type FoundryConnection, type PeerMessage } from "./bridge.js";

export type Role = "owner" | "peer" | "starting";

export interface SharedBridgeOptions extends BridgeOptions {
  /** Longest wait between attempts to own or join the connection, in milliseconds. */
  maxRetryMs?: number;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

/** Peers wait this much longer than the owner does, so the owner's own timeout error arrives first. */
const PEER_EXTRA_TIMEOUT_MS = 2000;
const MIN_RETRY_MS = 50;

/**
 * A Foundry connection that several foundry-mcp processes on the same computer
 * can share (for example Claude Code and Claude Desktop running at once).
 *
 * The first process listens on the port and owns the Foundry connection. Later
 * ones find the port taken and connect to it as peers with the same token; their
 * requests go through the owner. When the owner exits, a peer takes over the
 * port and the Foundry module reconnects to it on its own.
 */
export class SharedBridge implements FoundryConnection {
  private owner?: FoundryBridge;
  private peer?: WebSocket;
  private peerConnected = false;
  private peerInfo?: FoundryClientInfo;
  private pending = new Map<string, Pending>();
  private retryTimer?: NodeJS.Timeout;
  private retryMs = MIN_RETRY_MS;
  private stopped = false;
  private warnedToken = false;
  private readonly log: (msg: string) => void;

  constructor(private readonly opts: SharedBridgeOptions) {
    this.log = opts.log ?? ((msg) => process.stderr.write(`[foundry-mcp] ${msg}\n`));
  }

  get role(): Role {
    if (this.owner) return "owner";
    if (this.peer?.readyState === WebSocket.OPEN) return "peer";
    return "starting";
  }

  get connected(): boolean {
    if (this.owner) return this.owner.connected;
    return this.role === "peer" && this.peerConnected;
  }

  get clientInfo(): FoundryClientInfo | undefined {
    if (this.owner) return this.owner.clientInfo;
    return this.connected ? this.peerInfo : undefined;
  }

  /** Become the owner or a peer. Resolves once one of them has worked. */
  start(): Promise<Role> {
    this.stopped = false;
    return new Promise((resolve) => {
      const attempt = async () => {
        if (this.stopped) return;
        const role = (await this.tryOwn()) ?? (await this.tryJoin());
        if (role) {
          this.retryMs = MIN_RETRY_MS;
          this.warnedToken = false;
          resolve(role);
          return;
        }
        this.retryTimer = setTimeout(attempt, this.nextDelay());
      };
      void attempt();
    });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    this.rejectAll(new Error("Bridge stopped"));
    const peer = this.peer;
    this.peer = undefined;
    peer?.terminate();
    const owner = this.owner;
    this.owner = undefined;
    await owner?.stop();
  }

  request<T = unknown>(method: string, params: unknown = {}, timeoutMs = this.opts.requestTimeoutMs ?? 30000): Promise<T> {
    if (this.owner) return this.owner.request<T>(method, params, timeoutMs);
    const ws = this.peer;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("The connection to Foundry is being handed over to another foundry-mcp process. Try again in a moment."));
    }
    if (!this.peerConnected) return Promise.reject(new Error(NOT_CONNECTED));
    const id = randomUUID();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Foundry did not answer "${method}" within ${timeoutMs} ms`));
      }, timeoutMs + PEER_EXTRA_TIMEOUT_MS);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      ws.send(JSON.stringify({ type: "peer-request", id, method, params, timeoutMs }), (err) => {
        if (err) this.settle(id, (p) => p.reject(err));
      });
    });
  }

  /** Listen on the port. Returns undefined when another process already has it. */
  private async tryOwn(): Promise<Role | undefined> {
    const owner = new FoundryBridge({ ...this.opts, log: this.log });
    try {
      await owner.start();
    } catch (err) {
      await owner.stop().catch(() => {});
      if ((err as NodeJS.ErrnoException).code !== "EADDRINUSE") this.log(`Could not listen: ${(err as Error).message}`);
      return undefined;
    }
    if (this.stopped) {
      await owner.stop();
      return undefined;
    }
    this.owner = owner;
    return "owner";
  }

  /** Connect to the process that has the port. Returns undefined if that did not work. */
  private tryJoin(): Promise<Role | undefined> {
    return new Promise((resolve) => {
      const ws = new WebSocket(`ws://${this.opts.host}:${this.opts.port}`, { maxPayload: 256 * 1024 * 1024 });
      let welcomed = false;
      const finish = (role?: Role) => {
        if (welcomed && role) return;
        welcomed = !!role;
        resolve(role);
      };
      ws.on("open", () => ws.send(JSON.stringify({ type: "peer-hello", token: this.opts.token })));
      ws.on("message", (data: RawData) => {
        let msg: PeerMessage;
        try {
          msg = JSON.parse(data.toString());
        } catch {
          return;
        }
        if (msg.type === "peer-welcome" || msg.type === "status") {
          this.peerConnected = !!msg.connected;
          this.peerInfo = msg.info;
          if (msg.type === "peer-welcome" && !welcomed) {
            if (this.stopped) {
              ws.terminate();
              return finish(undefined);
            }
            this.peer = ws;
            this.log(`Port ${this.opts.port} is used by another foundry-mcp process; sharing its Foundry connection`);
            finish("peer");
          }
          return;
        }
        if (msg.type === "peer-response") {
          this.settle(msg.id, (p) => (msg.ok ? p.resolve(msg.result) : p.reject(new Error(msg.error))));
        }
      });
      ws.on("error", () => {});
      ws.on("close", (code) => {
        if (!welcomed) {
          if (code === 4003 && !this.warnedToken) {
            this.warnedToken = true;
            this.log(
              `Port ${this.opts.port} is used by a program that did not accept the token. It may be an older foundry-mcp; restart it to update it. Retrying.`,
            );
          }
          return finish(undefined);
        }
        if (this.peer !== ws) return;
        this.peer = undefined;
        this.peerConnected = false;
        this.peerInfo = undefined;
        this.rejectAll(new Error("The foundry-mcp process that held the Foundry connection exited before answering. Try again."));
        if (this.stopped) return;
        this.log("The foundry-mcp process holding the Foundry connection went away; taking over");
        // A small random wait so several peers don't all race for the port at once.
        this.retryTimer = setTimeout(() => void this.start(), Math.floor(Math.random() * 200));
      });
    });
  }

  private nextDelay(): number {
    const delay = this.retryMs + Math.floor(Math.random() * this.retryMs);
    this.retryMs = Math.min(this.retryMs * 2, this.opts.maxRetryMs ?? 5000);
    return delay;
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
