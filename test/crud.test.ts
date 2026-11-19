import { beforeEach, describe, expect, it } from "vitest";
// @ts-expect-error plain JS module without type declarations
import { createHandlers, pageData } from "../module/scripts/handlers.mjs";

type Data = Record<string, any>;

/** Minimal stand-in for a Foundry collection. */
class Coll<T extends { id: string }> {
  map = new Map<string, T>();
  get(id: string) {
    return this.map.get(id);
  }
  get contents() {
    return [...this.map.values()];
  }
  add(d: T) {
    this.map.set(d.id, d);
    return d;
  }
}

/** Apply a Foundry-style update (supports "a.b" keys and nested objects). */
function applyUpdate(target: Data, changes: Data) {
  for (const [key, value] of Object.entries(changes)) {
    const parts = key.split(".");
    let t = target;
    for (const p of parts.slice(0, -1)) t = t[p] ??= {};
    const last = parts.at(-1)!;
    if (value && typeof value === "object" && !Array.isArray(value) && t[last] && typeof t[last] === "object") applyUpdate(t[last], value);
    else t[last] = value;
  }
}

let n = 0;
const newId = () => `id${++n}`;

class FakeDoc {
  data: Data;
  constructor(data: Data, public parent?: Coll<FakeDoc>) {
    this.data = { _id: newId(), ...structuredClone(data) };
  }
  get id() {
    return this.data._id;
  }
  get name() {
    return this.data.name;
  }
  toObject() {
    return structuredClone(this.data);
  }
  async update(changes: Data) {
    applyUpdate(this.data, changes);
    return this;
  }
  async delete() {
    this.parent?.map.delete(this.id);
    return this;
  }
}

class FakeLevel extends FakeDoc {
  constructor(public scene: FakeScene, data: Data) {
    super(data);
  }
  async update(changes: Data) {
    await super.update(changes);
    const i = this.scene.data.levels.findIndex((l: Data) => l._id === this.id);
    this.scene.data.levels[i] = this.toObject();
    return this;
  }
}

class FakeScene extends FakeDoc {
  levelDocs: FakeLevel[] = [];
  get initialLevel() {
    return this.levelDocs[0];
  }
  async createEmbeddedDocuments(type: string, list: Data[]) {
    expect(type).toBe("Level");
    const created = list.map((d) => new FakeLevel(this, d));
    this.levelDocs.push(...created);
    this.data.levels = [...(this.data.levels ?? []), ...created.map((l) => l.toObject())];
    return created;
  }
}

class FakePage extends FakeDoc {
  constructor(public entry: FakeJournal, data: Data) {
    super(data);
  }
  sync() {
    this.entry.data.pages = this.entry.pages.contents.map((p) => p.toObject());
  }
  async update(changes: Data) {
    await super.update(changes);
    this.sync();
    return this;
  }
  async delete() {
    this.entry.pages.map.delete(this.id);
    this.sync();
    return this;
  }
}

class FakeJournal extends FakeDoc {
  pages = new Coll<FakePage>();
  constructor(data: Data, parent?: Coll<FakeDoc>) {
    const { pages = [], ...rest } = data;
    super({ ...rest, pages: [] }, parent);
    for (const p of pages) this.pages.add(new FakePage(this, p));
    this.data.pages = this.pages.contents.map((p) => p.toObject());
  }
  async createEmbeddedDocuments(type: string, list: Data[]) {
    expect(type).toBe("JournalEntryPage");
    const created = list.map((d) => this.pages.add(new FakePage(this, d)));
    this.data.pages = this.pages.contents.map((p) => p.toObject());
    return created;
  }
}

let game: any;
let h: any;

beforeEach(() => {
  const scenes = new Coll<FakeDoc>();
  const journal = new Coll<FakeDoc>();
  game = {
    folders: new Map<string, any>([
      ["fs", { name: "Maps", type: "Scene" }],
      ["fj", { name: "Lore", type: "JournalEntry" }],
    ]),
    scenes,
    journal,
  };
  h = createHandlers(game, {
    Scene: { create: async (d: Data) => scenes.add(new FakeScene(d, scenes)) },
    JournalEntry: { create: async (d: Data) => journal.add(new FakeJournal(d, journal)) },
  });
});

describe("scenes", () => {
  it("creates a scene with folder, grid and background", async () => {
    const s = await h["scenes.create"]({ name: "Crypt", folder: "fs", width: 3000, height: 2000, gridSize: 100, background: "maps/crypt.webp" });
    expect(s).toMatchObject({ name: "Crypt", folder: { id: "fs", name: "Maps" }, width: 3000, gridSize: 100, background: "maps/crypt.webp" });
    expect(s.levels).toHaveLength(1);
  });

  it("updates only given fields and replaces the background on the existing level", async () => {
    const s = await h["scenes.create"]({ name: "Crypt", background: "a.webp" });
    const u = await h["scenes.update"]({ id: s.id, name: "Crypt 2", background: "b.webp", gridSize: 50 });
    expect(u).toMatchObject({ name: "Crypt 2", background: "b.webp", gridSize: 50 });
    expect(u.levels).toHaveLength(1);
    const moved = await h["scenes.update"]({ id: s.id, folder: null });
    expect(moved.folder).toBeNull();
  });

  it("rejects a folder of the wrong type", async () => {
    await expect(h["scenes.create"]({ name: "X", folder: "fj" })).rejects.toThrow(/JournalEntry/);
    await expect(h["scenes.create"]({ name: "X", folder: "nope" })).rejects.toThrow(/Folder not found/);
  });

  it("gets and deletes a scene", async () => {
    const s = await h["scenes.create"]({ name: "Gone" });
    expect(h["scenes.get"]({ id: s.id }).name).toBe("Gone");
    await expect(h["scenes.delete"]({ id: s.id })).resolves.toEqual({ deleted: true, id: s.id, name: "Gone" });
    expect(() => h["scenes.get"]({ id: s.id })).toThrow(/not found/);
  });
});

describe("journals", () => {
  it("creates an entry with text and image pages", async () => {
    const j = await h["journals.create"]({
      name: "Lore",
      folder: "fj",
      pages: [{ name: "Intro", text: "<p>Hi</p>" }, { src: "img/map.webp", caption: "Map" }],
    });
    expect(j.folder).toEqual({ id: "fj", name: "Lore", path: "Lore" });
    expect(j.pages).toEqual([
      { id: expect.any(String), name: "Intro", type: "text", text: "<p>Hi</p>" },
      { id: expect.any(String), name: "Image", type: "image", src: "img/map.webp", caption: "Map" },
    ]);
  });

  it("adds, updates and deletes pages", async () => {
    const j = await h["journals.create"]({ name: "Notes" });
    const p = await h["pages.create"]({ journalId: j.id, name: "P", text: "<p>a</p>" });
    const u = await h["pages.update"]({ journalId: j.id, pageId: p.id, text: "<p>b</p>" });
    expect(u).toMatchObject({ name: "P", type: "text", text: "<p>b</p>" });
    expect(h["journals.get"]({ id: j.id }).pages).toHaveLength(1);
    await h["pages.delete"]({ journalId: j.id, pageId: p.id });
    expect(h["journals.get"]({ id: j.id }).pages).toHaveLength(0);
    await expect(h["pages.delete"]({ journalId: j.id, pageId: p.id })).rejects.toThrow(/not found/);
  });

  it("renames, moves and deletes an entry", async () => {
    const j = await h["journals.create"]({ name: "Old" });
    const u = await h["journals.update"]({ id: j.id, name: "New", folder: "fj" });
    expect(u).toMatchObject({ name: "New", folder: { id: "fj" } });
    await h["journals.delete"]({ id: j.id });
    expect(game.journal.contents).toHaveLength(0);
  });
});

describe("pageData", () => {
  it("builds full and partial page data", () => {
    expect(pageData({ text: "<p>x</p>" })).toEqual({ name: "Text", type: "text", text: { content: "<p>x</p>", format: 1 } });
    expect(pageData({ caption: "c" }, { partial: true })).toEqual({ image: { caption: "c" } });
  });
});
