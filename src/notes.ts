// Read operations on notes (ADR 0002). Paths in and out are relative, with "/".
import { open, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { ToolError } from "./errors.js";
import { checkNotePath, type Sandbox } from "./sandbox.js";
import { truncateUtf8 } from "./text.js";

export const LIST_LIMIT = 500;
const TITLE_PROBE_BYTES = 4_096;
const MATCH_TEXT_LIMIT = 200;

export interface NoteSummary {
  path: string;
  title: string;
  bytes: number;
  modified: string;
}

interface NoteFile {
  path: string;
  absolute: string;
  bytes: number;
  modified: Date;
}

function toRelative(root: string, absolute: string): string {
  return path.relative(root, absolute).split(path.sep).join("/");
}

/**
 * Every note under `start`, sorted by path. Hidden entries, names the sandbox
 * would reject, non-.md files and links are skipped: links are only followed
 * when a tool names them explicitly and the sandbox accepts them.
 */
async function walkNotes(sandbox: Sandbox, start: string): Promise<NoteFile[]> {
  const found: NoteFile[] = [];
  const pending = [start];
  while (pending.length > 0) {
    const directory = pending.pop() as string;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const relative = toRelative(sandbox.root, absolute);
      if (entry.isDirectory()) {
        if (!entry.name.startsWith(".")) pending.push(absolute);
        continue;
      }
      if (!entry.isFile()) continue; // links, sockets, devices
      try {
        checkNotePath(relative);
      } catch {
        continue;
      }
      const info = await stat(absolute);
      found.push({ path: relative, absolute, bytes: info.size, modified: info.mtime });
    }
  }
  return found.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

async function readPrefix(absolute: string, bytes: number): Promise<string> {
  const handle = await open(absolute, "r");
  try {
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

function titleOf(text: string, file: string): string {
  const heading = text.split(/\r?\n/).find((line) => line.startsWith("# "));
  return heading ? heading.slice(2).trim() : path.posix.basename(file, path.posix.extname(file));
}

async function resolveFolder(sandbox: Sandbox, folder: string | undefined): Promise<string> {
  if (folder === undefined) return sandbox.root;
  const absolute = await sandbox.resolve(folder, "path");
  const info = await stat(absolute).catch(() => undefined);
  if (!info?.isDirectory()) throw new ToolError(`folder not found: ${folder}`);
  return absolute;
}

async function noteFile(
  sandbox: Sandbox,
  notePath: string,
): Promise<{ absolute: string; bytes: number }> {
  const absolute = await sandbox.resolve(notePath, "note");
  const info = await stat(absolute).catch(() => undefined);
  if (!info?.isFile()) throw new ToolError(`note not found: ${notePath}`);
  return { absolute, bytes: info.size };
}

export async function listNotes(
  sandbox: Sandbox,
  folder?: string,
): Promise<{ notes: NoteSummary[]; truncated: boolean }> {
  const files = await walkNotes(sandbox, await resolveFolder(sandbox, folder));
  const shown = files.slice(0, LIST_LIMIT);
  const notes = await Promise.all(
    shown.map(async (file) => ({
      path: file.path,
      title: titleOf(await readPrefix(file.absolute, TITLE_PROBE_BYTES), file.path),
      bytes: file.bytes,
      modified: file.modified.toISOString(),
    })),
  );
  return { notes, truncated: files.length > shown.length };
}

export async function readNote(
  sandbox: Sandbox,
  notePath: string,
  maxReadBytes: number,
): Promise<{ path: string; content: string; totalBytes: number; truncated: boolean }> {
  const { absolute, bytes } = await noteFile(sandbox, notePath);
  // A few extra bytes so the character that straddles the limit is decoded whole.
  const text = await readPrefix(absolute, Math.min(bytes, maxReadBytes + 4));
  const truncated = bytes > maxReadBytes;
  return {
    path: notePath,
    content: truncated ? truncateUtf8(text, maxReadBytes) : text,
    totalBytes: bytes,
    truncated,
  };
}

export interface SearchMatch {
  path: string;
  line: number;
  text: string;
}

export async function searchNotes(
  sandbox: Sandbox,
  query: string,
  limit: number,
  maxReadBytes: number,
): Promise<{ matches: SearchMatch[]; skippedFiles: number }> {
  const needle = query.toLowerCase();
  const matches: SearchMatch[] = [];
  let skippedFiles = 0;
  for (const file of await walkNotes(sandbox, sandbox.root)) {
    if (file.bytes > maxReadBytes) {
      skippedFiles += 1;
      continue;
    }
    const lines = (await readPrefix(file.absolute, file.bytes)).split(/\r?\n/);
    for (const [index, line] of lines.entries()) {
      if (!line.toLowerCase().includes(needle)) continue;
      matches.push({
        path: file.path,
        line: index + 1,
        text: line.trim().slice(0, MATCH_TEXT_LIMIT),
      });
      if (matches.length >= limit) return { matches, skippedFiles };
    }
  }
  return { matches, skippedFiles };
}
