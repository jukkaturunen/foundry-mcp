import { beforeEach, describe, expect, it } from "vitest";
// @ts-expect-error plain JS module without type declarations
import { createHandlers, resolveFolder } from "../module/scripts/handlers.mjs";

type Data = Record<string, any>;
let n = 0;

class Coll {
  map = new Map<string, any>();
  get(id: string) {
    return this.map.get(id);
  }
  get contents() {
    return [...this.map.values()];
  }
}

function fakeDoc(coll: Coll, data: Data) {
  const doc: any = {
    data: { _id: data._id ?? `id${++n}`, folder: null, ...data },
    get id() {
      return doc.data._id;
    },
    get name() {
      return doc.data.name;
    },
    get type() {
      return doc.data.type;
    },
    toObject: () => structuredClone(doc.data),
    update: async (c: Data) => Object.assign(doc.data, c),
    delete: async (opts: Data) => {
      doc.deletedWith = opts;
      coll.map.delete(doc.id);
    },
  };
  coll.map.set(doc.id, doc);
  return doc;
}

let game: any;
let h: any;

beforeEach(() => {
  game = { folders: new Coll(), scenes: new Coll(), journal: new Coll() };
  fakeDoc(game.folders, { _id: "maps", name: "Maps", type: "Scene" });
  fakeDoc(game.folders, { _id: "dung", name: "Dungeons", type: "Scene", folder: "maps" });
  fakeDoc(game.folders, { _id: "jdung", name: "Dungeons", type: "JournalEntry" });
  fakeDoc(game.scenes, { _id: "s1", name: "Crypt", folder: "dung" });
  fakeDoc(game.journal, { _id: "j1", name: "Lore", folder: "jdung" });
  h = createHandlers(game, { Folder: { create: async (d: Data) => fakeDoc(game.folders, d) } });
});

describe("resolveFolder", () => {
  it("accepts ids, paths and unique names", () => {
    expect(resolveFolder(game, "dung", "Scene")).toBe("dung");
    expect(resolveFolder(game, "Maps/Dungeons", "Scene")).toBe("dung");
    expect(resolveFolder(game, "Dungeons", "JournalEntry")).toBe("jdung");
    expect(resolveFolder(game, null, "Scene")).toBeNull();
    expect(resolveFolder(game, undefined, "Scene")).toBeUndefined();
  });

  it("rejects unknown, ambiguous and wrong-type folders", () => {
    expect(() => resolveFolder(game, "Nope", "Scene")).toThrow(/not found/);
    expect(resolveFolder(game, "Dungeons", "Scene")).toBe("dung"); // unique by name
    fakeDoc(game.folders, { _id: "old", name: "Old", type: "Scene" });
    fakeDoc(game.folders, { _id: "dung2", name: "Dungeons", type: "Scene", folder: "old" });
    expect(() => resolveFolder(game, "Dungeons", "Scene")).toThrow(/Several/);
    expect(() => resolveFolder(game, "jdung", "Scene")).toThrow(/JournalEntry/);
  });
});

describe("folder handlers", () => {
  it("lists folders with paths and counts", () => {
    const list = h["folders.list"]({ type: "Scene" });
    expect(list.map((f: Data) => [f.path, f.documentCount, f.subfolderCount])).toEqual([
      ["Maps", 0, 1],
      ["Maps/Dungeons", 1, 0],
    ]);
  });

  it("gets a folder with its contents", () => {
    const f = h["folders.get"]({ id: "Maps/Dungeons", type: "Scene" });
    expect(f).toMatchObject({ id: "dung", parent: { id: "maps", path: "Maps" }, documents: [{ id: "s1", name: "Crypt" }] });
  });

  it("creates a subfolder by parent path", async () => {
    const f = await h["folders.create"]({ name: "Caves", type: "Scene", parent: "Maps", color: "#336699" });
    expect(f).toMatchObject({ name: "Caves", type: "Scene", path: "Maps/Caves", color: "#336699" });
    await expect(h["folders.create"]({ name: "X", type: "Actor" })).rejects.toThrow(/Unsupported/);
  });

  it("renames, moves and refuses self-parenting", async () => {
    const f = await h["folders.update"]({ id: "dung", name: "Crypts", parent: null });
    expect(f).toMatchObject({ name: "Crypts", path: "Crypts", parent: null });
    await expect(h["folders.update"]({ id: "maps", parent: "maps" })).rejects.toThrow(/own parent/);
  });

  it("deletes, keeping contents unless asked", async () => {
    const folder = game.folders.get("dung");
    await expect(h["folders.delete"]({ id: "dung" })).resolves.toMatchObject({ deleted: true, path: "Maps/Dungeons", contentsDeleted: false });
    expect(folder.deletedWith).toEqual({ deleteSubfolders: false, deleteContents: false });
  });

  it("scene tools accept a folder path", async () => {
    const scenes = new Coll();
    game.scenes = scenes;
    const hh = createHandlers(game, { Scene: { create: async (d: Data) => fakeDoc(scenes, d) } });
    const s = await hh["scenes.create"]({ name: "Cave", folder: "Maps/Dungeons" });
    expect(s.folder).toEqual({ id: "dung", name: "Dungeons", path: "Maps/Dungeons" });
  });
});
