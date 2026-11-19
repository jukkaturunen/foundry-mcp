import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { readLocalImage, safeFileName } from "../src/images.js";
// @ts-expect-error plain JS module without type declarations
import { createHandlers, ensureDir, uniqueName } from "../module/scripts/handlers.mjs";
import { makePng } from "./png.js";

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "foundry-mcp-test-"));
});

describe("readLocalImage", () => {
  it("reads size, type and content", async () => {
    const png = makePng(300, 200);
    const path = join(dir, "Ääni Kartta (1).PNG");
    await writeFile(path, png);
    const img = await readLocalImage(path);
    expect(img).toMatchObject({ fileName: "Aani-Kartta-1.png", mime: "image/png", width: 300, height: 200, bytes: png.length });
    expect(Buffer.from(img.data, "base64").equals(png)).toBe(true);
  });

  it("uses a given file name and keeps the extension", async () => {
    const path = join(dir, "a.png");
    await writeFile(path, makePng(2, 2));
    expect((await readLocalImage(path, "crypt map")).fileName).toBe("crypt-map.png");
  });

  it("rejects missing files and unsupported types", async () => {
    await expect(readLocalImage(join(dir, "nope.png"))).rejects.toThrow(/not found/);
    const txt = join(dir, "notes.txt");
    await writeFile(txt, "hi");
    await expect(readLocalImage(txt)).rejects.toThrow(/Unsupported/);
  });

  it("makes safe file names", () => {
    expect(safeFileName("../../etc/passwd.png")).toBe("passwd.png");
    expect(safeFileName("???.webp")).toBe("image.webp");
  });
});

/** Fake FilePicker over an in-memory set of directories and files. */
function fakeFilePicker(dirs: string[] = ["worlds", "worlds/w1"], files: string[] = []) {
  const d = new Set(dirs);
  const f = new Set(files);
  const uploads: { dir: string; name: string; type: string; size: number }[] = [];
  return {
    uploads,
    dirs: d,
    async browse(_src: string, target: string) {
      const prefix = target ? `${target}/` : "";
      const direct = (p: string) => p.startsWith(prefix) && !p.slice(prefix.length).includes("/");
      return { target, dirs: [...d].filter(direct), files: [...f].filter(direct) };
    },
    async createDirectory(_src: string, target: string) {
      if (d.has(target)) throw new Error("exists");
      d.add(target);
    },
    async upload(_src: string, target: string, file: File) {
      uploads.push({ dir: target, name: file.name, type: file.type, size: file.size });
      f.add(`${target}/${file.name}`);
      return { status: "success", path: `${target}/${file.name}` };
    },
  };
}

describe("files.upload handler", () => {
  it("creates missing folders and uploads", async () => {
    const FP = fakeFilePicker();
    expect(await ensureDir(FP, "worlds/w1/mcp-uploads/scenes")).toBe("worlds/w1/mcp-uploads/scenes");
    expect(FP.dirs.has("worlds/w1/mcp-uploads")).toBe(true);
    // Second call is a no-op (would throw if it tried to create again).
    await ensureDir(FP, "worlds/w1/mcp-uploads/scenes");
  });

  it("does not overwrite unless asked", async () => {
    const FP = fakeFilePicker(["worlds", "worlds/w1", "worlds/w1/up"], ["worlds/w1/up/map.png"]);
    const h = createHandlers({}, { FilePicker: FP });
    const data = makePng(4, 4).toString("base64");
    const a = await h["files.upload"]({ dir: "worlds/w1/up", fileName: "map.png", mime: "image/png", data });
    expect(a.path).toBe("worlds/w1/up/map-1.png");
    const b = await h["files.upload"]({ dir: "worlds/w1/up", fileName: "map.png", mime: "image/png", data, overwrite: true });
    expect(b.path).toBe("worlds/w1/up/map.png");
    expect(FP.uploads[0]).toMatchObject({ type: "image/png", size: makePng(4, 4).length });
  });

  it("picks unique names", () => {
    expect(uniqueName(["d/a.png", "d/a-1.png"], "d", "a.png")).toBe("a-2.png");
    expect(uniqueName([], "d", "a.png")).toBe("a.png");
  });
});
