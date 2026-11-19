/**
 * Request handlers for the MCP bridge. Each handler takes the request params
 * and returns plain JSON-serialisable data. They only depend on the `game`
 * object passed in, which keeps them testable outside Foundry.
 */

/** Plain source data of a document (works for live documents and test fakes). */
function sourceOf(doc) {
  return typeof doc.toObject === "function" ? doc.toObject() : doc;
}

function folderInfo(game, folderId) {
  if (!folderId) return null;
  const folder = game.folders?.get(folderId);
  return { id: folderId, name: folder?.name ?? null };
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

export function summarizeScene(game, scene) {
  const data = sourceOf(scene);
  return {
    id: data._id,
    name: data.name,
    active: !!data.active,
    folder: folderInfo(game, data.folder),
    width: data.width ?? null,
    height: data.height ?? null,
    background: sceneBackground(data),
    levels: (data.levels ?? []).map((l) => ({ id: l._id, name: l.name, background: l.background?.src ?? null })),
  };
}

export function summarizeJournal(game, entry) {
  const data = sourceOf(entry);
  return {
    id: data._id,
    name: data.name,
    folder: folderInfo(game, data.folder),
    pages: (data.pages ?? [])
      .slice()
      .sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0))
      .map((p) => ({ id: p._id, name: p.name, type: p.type })),
  };
}

export function createHandlers(game) {
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
    "scenes.list"() {
      return game.scenes.contents.map((s) => summarizeScene(game, s));
    },
    "journals.list"() {
      return game.journal.contents.map((j) => summarizeJournal(game, j));
    },
  };
}
