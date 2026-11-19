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

/** All Folder documents, from a Foundry collection or a Map (tests). */
function allFolders(game) {
  const f = game.folders;
  if (!f) return [];
  return f.contents ?? [...f.values()];
}

function folderId(folder) {
  return folder.id ?? folder._id ?? sourceOf(folder)._id;
}

/** "Parent/Child" path of a folder, following parent ids. */
export function folderPath(game, folder) {
  const names = [];
  let current = folder;
  for (let i = 0; current && i < 10; i++) {
    const data = sourceOf(current);
    names.unshift(data.name ?? current.name);
    current = data.folder ? game.folders.get(data.folder) : null;
  }
  return names.join("/");
}

function folderInfo(game, id) {
  if (!id) return null;
  const folder = game.folders?.get(id);
  return { id, name: folder?.name ?? null, path: folder ? folderPath(game, folder) : null };
}

/**
 * Resolve a folder reference to an id. Accepts an id, a name, or a path like
 * "Maps/Dungeons". null/"" means "no folder"; undefined means "not given".
 */
export function resolveFolder(game, ref, type) {
  if (ref === undefined || ref === null || ref === "") return ref === undefined ? undefined : null;
  const byId = game.folders?.get(ref);
  if (byId) {
    const t = sourceOf(byId).type ?? byId.type;
    if (type && t && t !== type) throw new Error(`Folder "${byId.name}" holds ${t} documents, not ${type}`);
    return ref;
  }
  const want = String(ref).replace(/^\/+|\/+$/g, "");
  const candidates = allFolders(game).filter((f) => !type || (sourceOf(f).type ?? f.type) === type);
  let matches = candidates.filter((f) => folderPath(game, f) === want);
  if (!matches.length) matches = candidates.filter((f) => (sourceOf(f).name ?? f.name) === want);
  if (!matches.length) throw new Error(`Folder not found: ${ref}`);
  if (matches.length > 1) {
    throw new Error(`Several ${type ?? ""} folders match "${ref}": ${matches.map((f) => `${folderPath(game, f)} (${folderId(f)})`).join(", ")}. Use the id.`);
  }
  return folderId(matches[0]);
}

const FOLDER_TYPES = { Scene: "scenes", JournalEntry: "journal" };

function summarizeFolder(game, folder, { contents = false } = {}) {
  const data = sourceOf(folder);
  const id = folderId(folder);
  const type = data.type ?? folder.type;
  const children = allFolders(game).filter((f) => sourceOf(f).folder === id);
  const collection = game[FOLDER_TYPES[type]];
  const docs = collection ? collection.contents.filter((d) => sourceOf(d).folder === id) : [];
  const out = {
    id,
    name: data.name ?? folder.name,
    type,
    path: folderPath(game, folder),
    parent: data.folder ? folderInfo(game, data.folder) : null,
    color: data.color ?? null,
    subfolderCount: children.length,
    documentCount: docs.length,
  };
  if (contents) {
    out.subfolders = children.map((f) => ({ id: folderId(f), name: sourceOf(f).name ?? f.name }));
    out.documents = docs.map((d) => ({ id: sourceOf(d)._id, name: sourceOf(d).name }));
  }
  return out;
}

function getFolder(game, ref, type) {
  const id = resolveFolder(game, ref, type);
  const folder = id && game.folders.get(id);
  if (!folder) throw new Error(`Folder not found: ${ref}`);
  return folder;
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


// ---- Files ----

const normPath = (p) => decodeURIComponent(String(p)).replace(/^\/+|\/+$/g, "");

/** Create a directory in the "data" source, including missing parents. */
export async function ensureDir(FilePicker, dir) {
  const parts = normPath(dir).split("/").filter(Boolean);
  let parent = "";
  for (const part of parts) {
    const current = parent ? `${parent}/${part}` : part;
    const listing = await FilePicker.browse("data", parent);
    const exists = (listing?.dirs ?? []).some((d) => normPath(d) === current);
    if (!exists) await FilePicker.createDirectory("data", current, {});
    parent = current;
  }
  return parent;
}

/** Pick a file name that does not exist yet in the listing (image.png, image-1.png, ...). */
export function uniqueName(existingFiles, dir, fileName) {
  const taken = new Set((existingFiles ?? []).map(normPath));
  const dot = fileName.lastIndexOf(".");
  const stem = dot > 0 ? fileName.slice(0, dot) : fileName;
  const ext = dot > 0 ? fileName.slice(dot) : "";
  let name = fileName;
  for (let i = 1; taken.has(`${dir}/${name}`); i++) name = `${stem}-${i}${ext}`;
  return name;
}

async function base64ToFile(data, fileName, mime) {
  const bin = atob(data);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new File([bytes], fileName, { type: mime });
}

const SCENE_FIELDS = ["name", "folder", "width", "height", "navigation"];

/**
 * @param game  The Foundry `game` object.
 * @param docs  Classes from Foundry: { Scene, JournalEntry, Folder, FilePicker }.
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
      const data = pick({ ...params, folder: resolveFolder(game, params.folder, "Scene") }, SCENE_FIELDS);
      if (params.gridSize !== undefined) data.grid = { size: params.gridSize };
      const scene = await docs.Scene.create(data);
      if (params.background) await setSceneBackground(scene, params.background);
      return summarizeScene(game, scene);
    },

    async "scenes.update"(params) {
      const scene = getScene(game, params.id);
      const data = pick({ ...params, folder: resolveFolder(game, params.folder, "Scene") }, SCENE_FIELDS);
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
      const data = pick({ ...params, folder: resolveFolder(game, params.folder, "JournalEntry") }, ["name", "folder"]);
      data.pages = (params.pages ?? []).map((p) => pageData(p));
      const entry = await docs.JournalEntry.create(data);
      return summarizeJournal(game, entry, { full: true });
    },

    async "journals.update"(params) {
      const entry = getJournal(game, params.id);
      const data = pick({ ...params, folder: resolveFolder(game, params.folder, "JournalEntry") }, ["name", "folder"]);
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

    // ---- Folders ----

    "folders.list"({ type } = {}) {
      return allFolders(game)
        .filter((f) => (sourceOf(f).type ?? f.type) in FOLDER_TYPES && (!type || (sourceOf(f).type ?? f.type) === type))
        .map((f) => summarizeFolder(game, f))
        .sort((a, b) => a.type.localeCompare(b.type) || a.path.localeCompare(b.path));
    },

    "folders.get"({ id, type }) {
      return summarizeFolder(game, getFolder(game, id, type), { contents: true });
    },

    async "folders.create"({ name, type, parent, color }) {
      if (!(type in FOLDER_TYPES)) throw new Error(`Unsupported folder type: ${type}`);
      const data = { name, type };
      const parentId = resolveFolder(game, parent, type);
      if (parentId) data.folder = parentId;
      if (color) data.color = color;
      const folder = await docs.Folder.create(data);
      return summarizeFolder(game, folder);
    },

    async "folders.update"({ id, name, parent, color }) {
      const folder = getFolder(game, id);
      const type = sourceOf(folder).type ?? folder.type;
      const data = pick({ name, color, folder: resolveFolder(game, parent, type) }, ["name", "color", "folder"]);
      if (data.folder && data.folder === folderId(folder)) throw new Error("A folder cannot be its own parent");
      if (Object.keys(data).length) await folder.update(data);
      return summarizeFolder(game, folder);
    },

    async "folders.delete"({ id, deleteContents = false }) {
      const folder = getFolder(game, id);
      const summary = summarizeFolder(game, folder);
      await folder.delete({ deleteSubfolders: deleteContents, deleteContents });
      return { deleted: true, id: summary.id, path: summary.path, contentsDeleted: deleteContents };
    },

    // ---- Files ----

    /** Upload a base64-encoded file into the "data" source. Returns its path for use in scenes and journals. */
    async "files.upload"({ dir, fileName, mime, data, overwrite = false }) {
      const FilePicker = docs.FilePicker;
      const target = await ensureDir(FilePicker, dir);
      let name = fileName;
      if (!overwrite) {
        const listing = await FilePicker.browse("data", target);
        name = uniqueName(listing?.files, target, fileName);
      }
      const file = await base64ToFile(data, name, mime);
      const res = await FilePicker.upload("data", target, file, {}, { notify: false });
      if (!res || res.status === "error" || res === false) throw new Error(res?.message ?? "Upload failed");
      return { path: res.path ?? `${target}/${name}` };
    },
  };
}
