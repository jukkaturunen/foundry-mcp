import { describe, expect, it } from "vitest";
// @ts-expect-error plain JS module without type declarations
import { createHandlers, sceneBackground } from "../module/scripts/handlers.mjs";

const doc = (data: object) => ({ toObject: () => structuredClone(data) });

const game = {
  world: { id: "w1", title: "My World" },
  system: { id: "dnd5e" },
  version: "14.360",
  user: { name: "GM" },
  folders: new Map([["f1", { name: "Dungeons" }]]),
  scenes: {
    contents: [
      doc({
        _id: "s1",
        name: "Crypt",
        active: true,
        folder: "f1",
        width: 4000,
        height: 3000,
        initialLevel: "l2",
        levels: [
          { _id: "l1", name: "Upper", background: { src: "up.webp" } },
          { _id: "l2", name: "Lower", background: { src: "down.webp" } },
        ],
      }),
      doc({ _id: "s2", name: "Empty", folder: null, levels: [] }),
    ],
  },
  journal: {
    contents: [
      doc({
        _id: "j1",
        name: "Lore",
        folder: "f1",
        pages: [
          { _id: "p2", name: "Second", type: "image", sort: 200 },
          { _id: "p1", name: "First", type: "text", sort: 100 },
        ],
      }),
    ],
  },
};

describe("handlers", () => {
  const h = createHandlers(game);

  it("reports status", () => {
    expect(h.status()).toEqual({ world: "w1", worldTitle: "My World", system: "dnd5e", foundryVersion: "14.360", user: "GM" });
  });

  it("lists scenes with the initial level background", () => {
    const [crypt, empty] = h["scenes.list"]();
    expect(crypt).toMatchObject({
      id: "s1",
      name: "Crypt",
      active: true,
      folder: { id: "f1", name: "Dungeons" },
      background: "down.webp",
    });
    expect(crypt.levels).toHaveLength(2);
    expect(empty).toMatchObject({ id: "s2", folder: null, background: null, levels: [] });
  });

  it("lists journals with pages in order", () => {
    const [lore] = h["journals.list"]();
    expect(lore.folder).toEqual({ id: "f1", name: "Dungeons" });
    expect(lore.pages.map((p: { id: string }) => p.id)).toEqual(["p1", "p2"]);
  });

  it("falls back to the first level, then to the pre-v14 background", () => {
    expect(sceneBackground({ levels: [{ _id: "a", background: { src: "a.png" } }] })).toBe("a.png");
    expect(sceneBackground({ background: { src: "old.png" } })).toBe("old.png");
  });
});
