import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, extname, resolve } from "node:path";
import { imageSize } from "image-size";

export const MAX_IMAGE_BYTES = 50 * 1024 * 1024;

const MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".avif": "image/avif",
  ".svg": "image/svg+xml",
  ".bmp": "image/bmp",
};

export interface LocalImage {
  fileName: string;
  mime: string;
  /** Base64-encoded file content. */
  data: string;
  bytes: number;
  width: number | null;
  height: number | null;
}

/** Expand a leading ~ and make the path absolute. */
export function expandPath(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return resolve(homedir(), p.slice(2));
  return resolve(p);
}

/** Make a file name safe for Foundry's data folder: letters, digits, dot, dash and underscore. */
export function safeFileName(name: string): string {
  const ext = extname(name).toLowerCase();
  const stem = basename(name, extname(name))
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${stem || "image"}${ext}`;
}

/** Read a local image file and get what the bridge needs to upload it. */
export async function readLocalImage(localPath: string, fileName?: string): Promise<LocalImage> {
  const path = expandPath(localPath);
  const info = await stat(path).catch(() => {
    throw new Error(`File not found: ${path}`);
  });
  if (!info.isFile()) throw new Error(`Not a file: ${path}`);
  if (info.size > MAX_IMAGE_BYTES) throw new Error(`Image is too large (${info.size} bytes, max ${MAX_IMAGE_BYTES})`);

  const ext = extname(path).toLowerCase();
  const mime = MIME[ext];
  if (!mime) throw new Error(`Unsupported image type "${ext}". Supported: ${Object.keys(MIME).join(", ")}`);

  const buf = await readFile(path);
  let width: number | null = null;
  let height: number | null = null;
  try {
    const size = imageSize(buf);
    width = size.width ?? null;
    height = size.height ?? null;
  } catch {
    // Size is only used to size scenes; uploading still works without it.
  }

  let name = safeFileName(fileName ?? basename(path));
  if (!extname(name)) name += ext;
  return { fileName: name, mime, data: buf.toString("base64"), bytes: buf.length, width, height };
}
