/**
 * Request handlers for the MCP bridge. Each handler takes the request params
 * and returns plain JSON-serialisable data. They only depend on the `game`
 * object and document classes passed in, which keeps them testable outside
 * Foundry.
 */

/** Plain source data of a document (works for live documents and test fakes). */
function sourceOf(doc) {
  return typeof doc.toObject === "function" ? doc.toObject() : doc;
}

/** Copy only the keys that were actually given (undefined means "leave as is"). */
function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (obj[k] !== undefined) out[k] = obj[k];
  return out;
}

function folderInfo(game, folderId) {
  if (!folderId) return null;
  const folder = game.folders?.get(folderId);
  return { id: folderId, name: folder?.name ?? null };
}

function checkFolder(game, folderId, type) {
  if (!folderId) return;
  const folder = game.folders?.get(folderId);
  if (!folder) throw new Error(`Folder not found: ${folderId}`);
  if (folder.type && folder.type !== type) throw new Error(`Folder ${folderId} holds ${folder.type} documents, not ${type}`);
}

function getScene(game, id) {
  const scene = game.scenes.get(id);
  if (!scene) throw new Error(`Scene not found: ${id}`);
  return scene;
}

function getJournal(game, id) {
  const entry = game.journal.get(id);
  if (!entry) throw new Error(`Journal entry not found: ${id}`);
  return entry;
}

function getPage(entry, pageId) {
  const page = entry.pages.get(pageId);
  if (!page) throw new Error(`Page ${pageId} not found in journal entry ${entry.id}`);
  return page;
}

/**
 * In v14 a scene's images live on its levels. Report the background of the
 * initial level (or the first level), falling back to the pre-v14 field.
 */
export function sceneBackground(data) {
  const levels = Array.isArray(data.levels) ? data.levels : [];
  const level = levels.find((l) => l._id === data.initialLevel) ?? levels[0];
  return level?.background?.src ?? data.background?.src ?? null;
}

/** Set the background image of a scene's initial level, creating a level if the scene has none. */
export async function setSceneBackground(scene, src) {
  const level = scene.initialLevel ?? scene.firstLevel ?? scene.levels?.contents?.[0];
  if (level) {
    await level.update({ "background.src": src });
  } else {
    await scene.createEmbeddedDocuments("Level", [{ name: scene.name, background: { src } }]);
  }
}

export function summarizeScene(game, scene) {
  const data = sourceOf(scene);
  return {
    id: data._id,
    name: data.name,
    active: !!data.active,
    navigation: data.navigation ?? null,
    folder: folderInfo(game, data.folder),
    width: data.width ?? null,
    height: data.height ?? null,
    gridSize: data.grid?.size ?? null,
    background: sceneBackground(data),
    levels: (data.levels ?? []).map((l) => ({ id: l._id, name: l.name, background: l.background?.src ?? null })),
  };
}

function summarizePage(page, { full = false } = {}) {
  const p = sourceOf(page);
  const out = { id: p._id, name: p.name, type: p.type };
  if (p.type === "image" || p.type === "video" || p.type === "pdf") out.src = p.src ?? null;
  if (p.type === "image" && p.image?.caption) out.caption = p.image.caption;
  if (full && p.type === "text") out.text = p.text?.content ?? "";
  return out;
}

export function summarizeJournal(game, entry, { full = false } = {}) {
  const data = sourceOf(entry);
  return {
    id: data._id,
    name: data.name,
    folder: folderInfo(game, data.folder),
    pages: (data.pages ?? [])
      .slice()
      .sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0))
      .map((p) => summarizePage(p, { full })),
  };
}

/** Turn the bridge's simple page description into JournalEntryPage data. */
export function pageData(params, { partial = false } = {}) {
  const type = params.type ?? (partial ? undefined : params.src ? "image" : "text");
  const data = pick(params, ["name"]);
  if (type) data.type = type;
  if (params.text !== undefined) data.text = { content: params.text, format: 1 };
  if (params.src !== undefined) data.src = params.src;
  if (params.caption !== undefined) data["image.caption"] = params.caption;
  if (!partial && !data.name) data.name = type === "image" ? "Image" : "Text";
  return expand(data);
}

/** Expand "a.b" keys into nested objects (like foundry.utils.expandObject, without needing Foundry). */
function expand(obj) {
  const out = {};
  for (const [key, value] of Object.entries(obj)) {
    const parts = key.split(".");
    let target = out;
    for (const part of parts.slice(0, -1)) target = target[part] ??= {};
    target[parts.at(-1)] = value;
  }
  return out;
}

const SCENE_FIELDS = ["name", "folder", "width", "height", "navigation"];

/**
 * @param game  The Foundry `game` object.
 * @param docs  Document classes: { Scene, JournalEntry }.
 */
export function createHandlers(game, docs = {}) {
  return {
    status() {
      return {
        world: game.world.id,
        worldTitle: game.world.title,
        system: game.system.id,
        foundryVersion: game.version,
        user: game.user.name,
      };
    },

    // ---- Scenes ----

    "scenes.list"() {
      return game.scenes.contents.map((s) => summarizeScene(game, s));
    },

    "scenes.get"({ id }) {
      return summarizeScene(game, getScene(game, id));
    },

    async "scenes.create"(params) {
      checkFolder(game, params.folder, "Scene");
      const data = pick(params, SCENE_FIELDS);
      if (params.gridSize !== undefined) data.grid = { size: params.gridSize };
      const scene = await docs.Scene.create(data);
      if (params.background) await setSceneBackground(scene, params.background);
      return summarizeScene(game, scene);
    },

    async "scenes.update"(params) {
      const scene = getScene(game, params.id);
      checkFolder(game, params.folder, "Scene");
      const data = pick(params, SCENE_FIELDS);
      if (params.gridSize !== undefined) data["grid.size"] = params.gridSize;
      if (Object.keys(data).length) await scene.update(data);
      if (params.background !== undefined) await setSceneBackground(scene, params.background);
      return summarizeScene(game, scene);
    },

    async "scenes.delete"({ id }) {
      const scene = getScene(game, id);
      const name = scene.name;
      await scene.delete();
      return { deleted: true, id, name };
    },

    // ---- Journal entries ----

    "journals.list"() {
      return game.journal.contents.map((j) => summarizeJournal(game, j));
    },

    "journals.get"({ id }) {
      return summarizeJournal(game, getJournal(game, id), { full: true });
    },

    async "journals.create"(params) {
      checkFolder(game, params.folder, "JournalEntry");
      const data = pick(params, ["name", "folder"]);
      data.pages = (params.pages ?? []).map((p) => pageData(p));
      const entry = await docs.JournalEntry.create(data);
      return summarizeJournal(game, entry, { full: true });
    },

    async "journals.update"(params) {
      const entry = getJournal(game, params.id);
      checkFolder(game, params.folder, "JournalEntry");
      const data = pick(params, ["name", "folder"]);
      if (Object.keys(data).length) await entry.update(data);
      return summarizeJournal(game, entry);
    },

    async "journals.delete"({ id }) {
      const entry = getJournal(game, id);
      const name = entry.name;
      await entry.delete();
      return { deleted: true, id, name };
    },

    // ---- Journal pages ----

    async "pages.create"(params) {
      const entry = getJournal(game, params.journalId);
      const [page] = await entry.createEmbeddedDocuments("JournalEntryPage", [pageData(params)]);
      return summarizePage(page, { full: true });
    },

    async "pages.update"(params) {
      const entry = getJournal(game, params.journalId);
      const page = getPage(entry, params.pageId);
      const data = pageData(params, { partial: true });
      if (Object.keys(data).length) await page.update(data);
      return summarizePage(page, { full: true });
    },

    async "pages.delete"({ journalId, pageId }) {
      const entry = getJournal(game, journalId);
      const page = getPage(entry, pageId);
      const name = page.name;
      await page.delete();
      return { deleted: true, journalId, pageId, name };
    },
  };
}
