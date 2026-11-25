// The folders System Bridge clients browse for media, such as Music and Videos in the home folder: their files
// listed, kept inside the folder even through links, and handed out by links signed for a while.

// ── Imports ──────────────────────────────────────────────────────────────────

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, realpathSync, statSync, type Stats } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";

// ── Folders ──────────────────────────────────────────────────────────────────

export interface MediaFolder {
  key: string;
  path: string;
}

// The usual folders of a home folder that exist, and the folder files from devices land in.
export function media_folders(home: string | undefined, downloads: string): MediaFolder[] {
  const wanted: MediaFolder[] = home
    ? [
        { key: "home", path: home },
        { key: "documents", path: join(home, "Documents") },
        { key: "downloads", path: downloads },
        { key: "music", path: join(home, "Music") },
        { key: "pictures", path: join(home, "Pictures") },
        { key: "videos", path: join(home, "Videos") },
      ]
    : [{ key: "downloads", path: downloads }];
  return wanted.filter((folder) => existsSync(folder.path) && statSync(folder.path).isDirectory());
}

// A path inside a folder, followed through links, or null when it leads outside or does not exist.
export function inside(folder: string, relative: string | null | undefined): string | null {
  try {
    const root = realpathSync(folder);
    const target = realpathSync(resolve(root, (relative ?? "").replace(/^\/+/, "")));
    return target === root || target.startsWith(root + sep) ? target : null;
  } catch {
    return null;
  }
}

// ── Files ────────────────────────────────────────────────────────────────────

const content_types: Record<string, string> = {
  ".mp3": "audio/mpeg", ".flac": "audio/flac", ".ogg": "audio/ogg", ".oga": "audio/ogg", ".opus": "audio/opus", ".wav": "audio/wav", ".m4a": "audio/mp4", ".aac": "audio/aac",
  ".mp4": "video/mp4", ".m4v": "video/mp4", ".mkv": "video/x-matroska", ".webm": "video/webm", ".mov": "video/quicktime", ".avi": "video/x-msvideo",
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml",
  ".pdf": "application/pdf", ".txt": "text/plain",
};

export function content_type_of(name: string): string | null {
  return content_types[extname(name).toLowerCase()] ?? null;
}

// A file's mode as ls writes it, such as "-rw-r--r--".
export function mode_text(stats: Pick<Stats, "mode" | "isDirectory">): string {
  const letters = "rwxrwxrwx";
  return (stats.isDirectory() ? "d" : "-") + [...letters].map((letter, index) => (stats.mode & (1 << (8 - index)) ? letter : "-")).join("");
}

// A folder's entries as GET_FILES answers them, hidden files left out.
export async function list_files(folder: string): Promise<Record<string, unknown>[]> {
  const names = (await readdir(folder)).filter((name) => !name.startsWith(".")).sort((first, second) => first.localeCompare(second));
  const entries = await Promise.all(
    names.map(async (name) => {
      const path = join(folder, name);
      try {
        const stats = await stat(path);
        const type = stats.isDirectory() ? null : content_type_of(name);
        return [{ name, path, size: stats.size, isDirectory: stats.isDirectory(), modTime: stats.mtime.toISOString(), permissions: mode_text(stats), ...(type ? { contentType: type } : {}), ...(extname(name) && !stats.isDirectory() ? { extension: extname(name) } : {}) }];
      } catch {
        return [];
      }
    }),
  );
  return entries.flat();
}

// ── Signed links ─────────────────────────────────────────────────────────────

// Links to a file that work without a key until they expire, for players such as a cast device.
export function create_signer(secret = randomBytes(32)) {
  const signature = (base: string, path: string, expires: number): string => createHmac("sha256", secret).update(`${base}\n${path}\n${expires}`).digest("hex");
  return {
    // The link's path and query, and when it expires in Unix seconds; a day at most.
    url(base: string, path: string, seconds: number, now = Date.now()): { url: string; expires: number } {
      const expires = Math.floor(now / 1000) + Math.max(1, Math.min(seconds || 3600, 86_400));
      const query = new URLSearchParams({ base, path, expires: String(expires), sig: signature(base, path, expires) });
      return { url: `/api/media/file/data?${query.toString()}`, expires };
    },
    check(base: string, path: string, expires: number, sig: string, now = Date.now()): boolean {
      if (!Number.isFinite(expires) || expires < now / 1000) return false;
      const wanted = Buffer.from(signature(base, path, expires), "hex");
      const given = Buffer.from(sig, "hex");
      return given.length === wanted.length && timingSafeEqual(given, wanted);
    },
  };
}
