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

Uploads go to `worlds/<world>/mcp-uploads/{images,scenes,journal}` unless you give `targetDir`. Existing files are not overwritten: a `-1`, `-2`, … suffix is added unless `overwrite` is set. Max image size is 50 MB.

Folders are given by id for now. Coming next: folder tools.

## Setup

### 1. Install the Foundry module

On your Foundry server, in **Add-on Modules → Install Module**, paste this manifest URL:

```
https://github.com/jukkaturunen/foundry-mcp/releases/latest/download/module.json
```

Enable **JT Foundry MCP Bridge** in your world.

The module id is `jt-foundry-mcp-bridge`. It is deliberately different from the unrelated *Foundry MCP Bridge* (`foundry-mcp-bridge`) on foundryvtt.com: Foundry updates packages by id from its own registry, so sharing that id would replace this module with the other one.

### 2. Build the MCP server

```sh
git clone https://github.com/jukkaturunen/foundry-mcp
cd foundry-mcp
npm install
npm run build
```

### 3. Choose a token

Make a random secret, for example with `openssl rand -hex 24`.

### 4. Add the server to your MCP client

Claude Desktop (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "foundry": {
      "command": "node",
      "args": ["/path/to/foundry-mcp/dist/index.js"],
      "env": { "FOUNDRY_MCP_TOKEN": "your-secret" }
    }
  }
}
```

Claude Code:

```sh
claude mcp add foundry --env FOUNDRY_MCP_TOKEN=your-secret -- node /path/to/foundry-mcp/dist/index.js
```

Optional environment variables: `FOUNDRY_MCP_PORT` (default `37777`) and `FOUNDRY_MCP_HOST` (default `127.0.0.1`).

### 5. Connect Foundry

Open your world as a GM in the browser on the same computer. In **Configure Settings → JT Foundry MCP Bridge**, paste the same token. You should see "connected to the MCP server". If the browser asks whether the site may access apps on this device (local network access), allow it.

Chrome, Edge and Firefox allow a page served over HTTPS to connect to `ws://127.0.0.1`. Safari may block it.

## Development

```sh
npm test          # unit tests (bridge + module handlers)
npm run typecheck
```

To release the module, bump `version` in `module/module.json`, then either publish a GitHub release with a new tag `vX.Y.Z` (same version) in the GitHub web UI, or push such a tag. The release workflow attaches `module.json` and `jt-foundry-mcp-bridge.zip` to the release.
