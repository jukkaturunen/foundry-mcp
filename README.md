# foundry-mcp

An [MCP](https://modelcontextprotocol.io) server for [Foundry VTT](https://foundryvtt.com) v14. It lets an AI assistant (Claude Desktop, Claude Code, …) read and edit your Foundry world.

## How it works

Foundry has no external REST API, so this project has two parts:

```
MCP client ──stdio──> foundry-mcp server ──WebSocket──> JT Foundry MCP Bridge module ──> Foundry API
(your computer)       (your computer, 127.0.0.1)        (GM's browser tab)            (your Foundry server)
```

- **`src/`**: the MCP server. It runs on your own computer, next to the MCP client, so it can read local files such as images.
- **`module/`**: the Foundry module *JT Foundry MCP Bridge*. It runs in the browser tab of a GM user and connects to the MCP server on `ws://127.0.0.1:37777`. Changes are made through Foundry's own client API, with the GM's permissions.

The tools work only while the world is open in a browser as a GM. The connection is protected by a shared token.

## Tools

| Tool | What it does |
|---|---|
| `foundry_status` | Is a world connected, and which one |
| `list_scenes`, `get_scene` | Scenes with folder, size, grid, background image and levels |
| `create_scene`, `update_scene`, `delete_scene` | Create, change or delete a scene. `background` is a path on the Foundry server and is set on the scene's initial level |
| `list_journals`, `get_journal` | Journal entries with folder and pages (`get_journal` includes page HTML) |
| `create_journal`, `update_journal`, `delete_journal` | Create (optionally with pages), rename/move or delete a journal entry |
| `create_journal_page`, `update_journal_page`, `delete_journal_page` | Text pages (HTML) and image pages |
| `upload_image` | Upload an image from your computer into Foundry's data storage and get its path |
| `create_scene_from_image` | Upload an image and create a scene with it as background, sized to the image |
| `set_scene_background_from_file` | Upload an image and make it an existing scene's background (resizes the scene by default) |
| `add_journal_image_from_file` | Upload an image and add it as an image page to a journal entry |
| `list_folders`, `get_folder` | Scene and journal folders with path, parent and contents |
| `create_folder`, `update_folder`, `delete_folder` | Create, rename, recolor, move or delete folders. Deleting keeps the contents unless `deleteContents` is set |

Uploads go to `worlds/<world>/mcp-uploads/{images,scenes,journal}` unless you give `targetDir`. Existing files are not overwritten: a `-1`, `-2`, … suffix is added unless `overwrite` is set. Max image size is 50 MB.

Wherever a tool takes a folder, you can give its id, its name, or its path like `Maps/Dungeons`.

## Setup

You need three things: the Foundry module, the MCP server in your AI app, and one shared token in both. Nothing has to be cloned or built.

### 1. Install the Foundry module

On your Foundry server, in **Add-on Modules → Install Module**, paste this manifest URL:

```
https://github.com/jukkaturunen/foundry-mcp/releases/latest/download/module.json
```

Enable **JT Foundry MCP Bridge** in your world.

The module id is `jt-foundry-mcp-bridge`. It is deliberately different from the unrelated *Foundry MCP Bridge* (`foundry-mcp-bridge`) on foundryvtt.com: Foundry updates packages by id from its own registry, so sharing that id would replace this module with the other one.

### 2. Choose a token

Any secret of at least 16 characters, for example from `openssl rand -hex 24` or a password manager. You will paste the same value into your AI app and into Foundry.

### 3. Add the server to your AI app

**Claude Desktop** (no Node.js needed):

1. Download [`foundry-mcp.mcpb`](https://github.com/jukkaturunen/foundry-mcp/releases/latest/download/foundry-mcp.mcpb).
2. Double-click it, or drag it onto **Settings → Extensions** in Claude Desktop, and click **Install**.
3. Paste your token when asked.

To update, download the new `foundry-mcp.mcpb` and install it the same way.

**Claude Code** (needs Node.js 20 or newer): run once, with your token:

```sh
claude mcp add foundry --scope user --env FOUNDRY_MCP_TOKEN=your-secret -- npx -y https://github.com/jukkaturunen/foundry-mcp/releases/latest/download/foundry-mcp.tgz
```

`npx` downloads the server (one file, no dependencies) and caches it. If a new release does not show up, run `rm -rf ~/.npm/_npx` and restart Claude Code.

**Other MCP clients**: run `npx -y https://github.com/jukkaturunen/foundry-mcp/releases/latest/download/foundry-mcp.tgz` over stdio with `FOUNDRY_MCP_TOKEN` set. For Claude Desktop's `claude_desktop_config.json` that is:

```json
{
  "mcpServers": {
    "foundry": {
      "command": "npx",
      "args": ["-y", "https://github.com/jukkaturunen/foundry-mcp/releases/latest/download/foundry-mcp.tgz"],
      "env": { "FOUNDRY_MCP_TOKEN": "your-secret" }
    }
  }
}
```

Optional environment variables: `FOUNDRY_MCP_PORT` (default `37777`) and `FOUNDRY_MCP_HOST` (default `127.0.0.1`).

You can add the server to several apps at once (for example Claude Desktop and Claude Code) with the same token and port. The first one to start listens on the port and holds the Foundry connection; the others connect to it and send their requests through it. If the first one exits, another takes over the port and the Foundry module reconnects to it by itself within a few seconds. `foundry_status` shows `serverRole`: `owner` or `peer`.

**Moving from a local clone?** Remove the old entry first: `claude mcp remove foundry --scope user` for Claude Code, and delete the `foundry` entry from `claude_desktop_config.json` for Claude Desktop (then restart it).

### 4. Connect Foundry

Open your world as a GM in the browser on the same computer. In **Configure Settings → JT Foundry MCP Bridge**, paste the same token. You should see "connected to the MCP server". If the browser asks whether the site may access apps on this device (local network access), allow it.

Chrome, Edge and Firefox allow a page served over HTTPS to connect to `ws://127.0.0.1`. Safari may block it.

## Development

```sh
git clone https://github.com/jukkaturunen/foundry-mcp
cd foundry-mcp
npm install
npm test               # unit tests (bridge + module handlers)
npm run typecheck
npm run build          # dist/index.js, to run from the clone: node dist/index.js
npm run release:build  # bundle/foundry-mcp.mjs, foundry-mcp.tgz and foundry-mcp.mcpb
node scripts/smoke.mjs # starts the bundle and checks that it lists its tools
```

To release, bump the version in `module/module.json`, `package.json` and `src/index.ts` (all three must match), then publish a GitHub release with a new tag `vX.Y.Z` in the GitHub web UI, or push such a tag. The release workflow attaches `module.json`, `jt-foundry-mcp-bridge.zip`, `foundry-mcp.mcpb` and `foundry-mcp.tgz` to the release.
