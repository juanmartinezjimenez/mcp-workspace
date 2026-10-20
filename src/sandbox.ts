// Path sandbox (ADR 0002): every path from a tool argument goes through here
// before any file system call. Error messages only ever contain the relative
// input, never the root's absolute location.
import { realpath, stat } from "node:fs/promises";
import path from "node:path";

export class SandboxError extends Error {
  override name = "SandboxError";
}

const RESERVED_DEVICE_NAMES = new Set([
  "con",
  "prn",
  "aux",
  "nul",
  ...Array.from({ length: 9 }, (_, i) => `com${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `lpt${i + 1}`),
  "com¹",
  "com²",
  "com³",
  "lpt¹",
  "lpt²",
  "lpt³",
]);

const WINDOWS_INVALID_CHARACTERS = new Set(["<", ">", '"', "|", "?", "*"]);

function hasControlCharacter(text: string): boolean {
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function checkSegment(segment: string): void {
  if (segment === "") throw new SandboxError("empty path segment (double or trailing slash)");
  if (segment.startsWith(".")) {
    throw new SandboxError(`hidden files and folders are not allowed: "${segment}"`);
  }
  if (segment.endsWith(".") || segment.endsWith(" ")) {
    throw new SandboxError(`names cannot end with a dot or a space: "${segment}"`);
  }
  // Windows treats CON, NUL.md, Con.tar.gz... as devices: the part before the
  // first dot, without trailing spaces, decides.
  const stem = (segment.split(".")[0] ?? "").trimEnd().toLowerCase();
  if (RESERVED_DEVICE_NAMES.has(stem)) {
    throw new SandboxError(`"${segment}" is a reserved device name on Windows`);
  }
}

/**
 * Validates a path relative to the workspace root and returns its segments.
 * The rules are the same on every platform, so a workspace stays portable.
 */
export function checkRelativePath(input: string): string[] {
  if (input === "") throw new SandboxError("path is empty");
  if (hasControlCharacter(input)) throw new SandboxError("path contains a control character");
  if (input.includes("\\")) throw new SandboxError("use forward slashes, not backslashes");
  if (input.includes(":")) {
    throw new SandboxError("':' is not allowed (drive letters and alternate data streams)");
  }
  for (const char of input) {
    if (WINDOWS_INVALID_CHARACTERS.has(char)) {
      throw new SandboxError(`the characters < > " | ? * are not allowed`);
    }
  }
  if (path.posix.isAbsolute(input) || path.win32.isAbsolute(input)) {
    throw new SandboxError("path must be relative to the workspace root");
  }
  const segments = input.split("/");
  // "." and ".." get their own messages, saying how to write the path instead.
  if (segments.includes("..")) {
    throw new SandboxError(
      "'..' is not allowed: paths cannot leave the workspace root; " +
        "use a path relative to the workspace root, like 'inbox.md'",
    );
  }
  if (segments.includes(".")) {
    const suggestion = segments.filter((segment) => segment !== ".").join("/") || "inbox.md";
    throw new SandboxError(
      `'.' segments are not needed: use a path relative to the workspace root, like '${suggestion}'`,
    );
  }
  for (const segment of segments) checkSegment(segment);
  return segments;
}

/** True for note file names: a `.md` extension, compared without case. */
export function isNoteName(name: string): boolean {
  return name.length > ".md".length && name.toLowerCase().endsWith(".md");
}

/** Validates a note path: a relative path whose last segment is a `.md` file. */
export function checkNotePath(input: string): string[] {
  const segments = checkRelativePath(input);
  if (!isNoteName(segments.at(-1) ?? "")) throw new SandboxError("notes must be .md files");
  return segments;
}

/**
 * Whether `target` is inside `root` (or is `root`, when `allowRoot`), for the
 * given path flavour. Windows paths compare without case, as NTFS does.
 */
export function isWithin(
  root: string,
  target: string,
  { flavor = path, allowRoot = false }: { flavor?: path.PlatformPath; allowRoot?: boolean } = {},
): boolean {
  const ignoreCase = flavor.sep === "\\";
  const from = ignoreCase ? root.toLowerCase() : root;
  const to = ignoreCase ? target.toLowerCase() : target;
  const relative = flavor.relative(from, to);
  if (relative === "") return allowRoot;
  return (
    relative !== ".." && !relative.startsWith(`..${flavor.sep}`) && !flavor.isAbsolute(relative)
  );
}

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR";
}

export type PathKind = "note" | "path";

/** The workspace root, canonicalized once, and the only way to turn tool input into paths. */
export class Sandbox {
  private constructor(readonly root: string) {}

  static async open(root: string): Promise<Sandbox> {
    let real: string;
    try {
      real = await realpath(root);
    } catch {
      throw new SandboxError("the workspace root does not exist");
    }
    if (!(await stat(real)).isDirectory()) {
      throw new SandboxError("the workspace root is not a directory");
    }
    return new Sandbox(real);
  }

  /**
   * Resolves a tool's relative path to an absolute path inside the root, or
   * throws a SandboxError. Symlinks and junctions are followed with realpath
   * on the deepest existing ancestor, so a link cannot lead outside the root.
   */
  async resolve(input: string, kind: PathKind): Promise<string> {
    const segments = kind === "note" ? checkNotePath(input) : checkRelativePath(input);
    const target = path.resolve(this.root, ...segments);
    if (!isWithin(this.root, target)) throw new SandboxError("path leads outside the workspace");

    let probe = target;
    for (;;) {
      try {
        const real = await realpath(probe);
        if (!isWithin(this.root, real, { allowRoot: true })) {
          throw new SandboxError(`"${input}" leads outside the workspace through a link`);
        }
        return target;
      } catch (error) {
        if (error instanceof SandboxError || !isMissing(error)) throw error;
        probe = path.dirname(probe); // not created yet: check the closest existing parent
      }
    }
  }
}
