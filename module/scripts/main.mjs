import { createHandlers } from "./handlers.mjs";

const MODULE_ID = "jt-foundry-mcp-bridge";
const MIN_RETRY_MS = 2000;
const MAX_RETRY_MS = 30000;

/** WebSocket client that connects this GM browser tab to the local foundry-mcp server. */
class BridgeClient {
  ws = null;
  retryMs = MIN_RETRY_MS;
  retryTimer = null;
  stopped = false;
  handlers = createHandlers(game, {
    Scene: CONFIG.Scene.documentClass,
    JournalEntry: CONFIG.JournalEntry.documentClass,
    Folder: CONFIG.Folder.documentClass,
    FilePicker: foundry.applications.apps.FilePicker.implementation,
  });

  setting(key) {
    return game.settings.get(MODULE_ID, key);
  }

  connect() {
    this.disconnect();
    this.stopped = false;
    if (!this.setting("enabled")) return;
    const token = this.setting("token");
    if (!token) {
      ui.notifications.warn(game.i18n.localize("FOUNDRY_MCP.NoToken"));
      return;
    }

    let ws;
    try {
      ws = new WebSocket(this.setting("serverUrl"));
    } catch (err) {
      console.warn(`${MODULE_ID} | Invalid server address`, err);
      return;
    }
    this.ws = ws;

    ws.addEventListener("open", () => {
      ws.send(
        JSON.stringify({
          type: "hello",
          token,
          world: game.world.id,
          worldTitle: game.world.title,
          system: game.system.id,
          foundryVersion: game.version,
          user: game.user.name,
          moduleVersion: game.modules.get(MODULE_ID)?.version,
        }),
      );
    });

    ws.addEventListener("message", (event) => this.onMessage(ws, event.data));

    ws.addEventListener("close", (event) => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (event.code === 4003) {
        ui.notifications.error(game.i18n.localize("FOUNDRY_MCP.BadToken"));
        return;
      }
      if (event.code === 4000) {
        ui.notifications.info(game.i18n.localize("FOUNDRY_MCP.Replaced"));
        return;
      }
      this.scheduleRetry();
    });
  }

  disconnect() {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    const ws = this.ws;
    this.ws = null;
    ws?.close();
  }

  scheduleRetry() {
    if (this.stopped) return;
    console.debug(`${MODULE_ID} | MCP server not reachable, retrying in ${this.retryMs} ms`);
    this.retryTimer = setTimeout(() => this.connect(), this.retryMs);
    this.retryMs = Math.min(this.retryMs * 2, MAX_RETRY_MS);
  }

  async onMessage(ws, raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.type === "welcome") {
      this.retryMs = MIN_RETRY_MS;
      ui.notifications.info(game.i18n.localize("FOUNDRY_MCP.Connected"));
      console.log(`${MODULE_ID} | Connected to MCP server`);
      return;
    }
    if (msg.type !== "request") return;

    const reply = (body) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ type: "response", id: msg.id, ...body }));
    const handler = this.handlers[msg.method];
    if (!handler) return reply({ ok: false, error: `Unknown method: ${msg.method}` });
    try {
      reply({ ok: true, result: (await handler(msg.params ?? {})) ?? null });
    } catch (err) {
      console.error(`${MODULE_ID} | ${msg.method} failed`, err);
      reply({ ok: false, error: err?.message ?? String(err) });
    }
  }
}

let client = null;
const reconnect = () => client?.connect();

Hooks.once("init", () => {
  game.settings.register(MODULE_ID, "enabled", {
    name: "FOUNDRY_MCP.Settings.Enabled.Name",
    hint: "FOUNDRY_MCP.Settings.Enabled.Hint",
    scope: "client",
    config: true,
    type: Boolean,
    default: true,
    onChange: reconnect,
  });
  game.settings.register(MODULE_ID, "serverUrl", {
    name: "FOUNDRY_MCP.Settings.ServerUrl.Name",
    hint: "FOUNDRY_MCP.Settings.ServerUrl.Hint",
    scope: "client",
    config: true,
    type: String,
    default: "ws://127.0.0.1:37777",
    onChange: reconnect,
  });
  game.settings.register(MODULE_ID, "token", {
    name: "FOUNDRY_MCP.Settings.Token.Name",
    hint: "FOUNDRY_MCP.Settings.Token.Hint",
    scope: "client",
    config: true,
    type: String,
    default: "",
    onChange: reconnect,
  });
});

Hooks.once("ready", () => {
  if (!game.user.isGM) return;
  client = new BridgeClient();
  client.connect();
});
