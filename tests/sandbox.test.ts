import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  checkNotePath,
  checkRelativePath,
  isNoteName,
  isWithin,
  Sandbox,
  SandboxError,
} from "../src/sandbox.js";

const isWindows = process.platform === "win32";

describe("checkRelativePath (same rules on every platform)", () => {
  it.each([
    ["", "empty"],
    ["notes/\u0000.md", "control character"],
    ["notes/\u001f.md", "control character"],
    ["notes\\ideas.md", "forward slashes"],
    ["a\\..\\..\\b.md", "forward slashes"],
    ["C:notes.md", "':' is not allowed"],
    ["C:/Windows/win.ini", "':' is not allowed"],
    ["note.md:hidden", "':' is not allowed"],
    ["notes/ideas.md::$DATA", "':' is not allowed"],
    ["/etc/passwd", "relative to the workspace root"],
    ["//server/share/a.md", "relative to the workspace root"],
    ["..", "'.' and '..'"],
    ["../outside.md", "'.' and '..'"],
    ["notes/../../outside.md", "'.' and '..'"],
    ["notes/./ideas.md", "'.' and '..'"],
    ["notes//ideas.md", "empty path segment"],
    ["notes/", "empty path segment"],
    [".env", "hidden"],
    [".git/config", "hidden"],
    ["notes/.obsidian/app.json", "hidden"],
    ["ideas.md.", "end with a dot or a space"],
    ["ideas.md ", "end with a dot or a space"],
    ["notes./ideas.md", "end with a dot or a space"],
    ["notes /ideas.md", "end with a dot or a space"],
    ["CON", "reserved device name"],
    ["nul.md", "reserved device name"],
    ["Prn.txt", "reserved device name"],
    ["aux.tar.gz", "reserved device name"],
    ["projects/COM1/ideas.md", "reserved device name"],
    ["com9.md", "reserved device name"],
    ["LPT1", "reserved device name"],
    ["lpt9.md", "reserved device name"],
    ["COM¹.md", "reserved device name"],
    ["lpt³", "reserved device name"],
    ["NUL .md", "reserved device name"],
    ["what?.md", "are not allowed"],
    ["a*b.md", "are not allowed"],
    ["<x>.md", "are not allowed"],
    ['say"hi".md', "are not allowed"],
    ["a|b.md", "are not allowed"],
  ])("rejects %j (%s)", (input, reason) => {
    expect(() => checkRelativePath(input)).toThrow(SandboxError);
    expect(() => checkRelativePath(input)).toThrow(reason);
  });

  it.each([
    ["ideas.md", ["ideas.md"]],
    ["projects/agent-evals.md", ["projects", "agent-evals.md"]],
    ["projects/2026/q4 plan.md", ["projects", "2026", "q4 plan.md"]],
    ["console.md", ["console.md"]], // starts with "con" but is not CON
    ["com10.md", ["com10.md"]], // only COM1-COM9 are reserved
    ["nullable.md", ["nullable.md"]],
    ["notas/reunión-lucía.md", ["notas", "reunión-lucía.md"]],
  ])("accepts %j", (input, segments) => {
    expect(checkRelativePath(input)).toEqual(segments);
  });
});

describe("note paths", () => {
  it.each(["ideas.md", "Ideas.MD", "projects/plan.Md"])("accepts %j", (input) => {
    expect(() => checkNotePath(input)).not.toThrow();
  });

  it.each(["ideas.markdown", "ideas.txt", "ideas", "ideas.md.txt", "projects/plan.mdx"])(
    "rejects %j",
    (input) => {
      expect(() => checkNotePath(input)).toThrow("notes must be .md files");
    },
  );

  it("needs a name before the extension", () => {
    expect(isNoteName(".md")).toBe(false);
    expect(isNoteName("a.md")).toBe(true);
  });
});

describe("isWithin", () => {
  it("compares Windows paths without case, on any runner", () => {
    const flavor = path.win32;
    expect(isWithin("C:\\Work", "c:\\work\\notes\\a.md", { flavor })).toBe(true);
    expect(isWithin("C:\\Work", "C:\\WORK\\A.MD", { flavor })).toBe(true);
    expect(isWithin("C:\\Work", "C:\\Work2\\a.md", { flavor })).toBe(false);
    expect(isWithin("C:\\Work", "C:\\a.md", { flavor })).toBe(false);
    expect(isWithin("C:\\Work", "D:\\Work\\a.md", { flavor })).toBe(false);
    expect(isWithin("C:\\Work", "\\\\server\\share\\a.md", { flavor })).toBe(false);
  });

  it("compares POSIX paths exactly, on any runner", () => {
    const flavor = path.posix;
    expect(isWithin("/home/u/work", "/home/u/work/notes/a.md", { flavor })).toBe(true);
    expect(isWithin("/home/u/work", "/home/u/Work/a.md", { flavor })).toBe(false);
    expect(isWithin("/home/u/work", "/home/u/work-other/a.md", { flavor })).toBe(false);
    expect(isWithin("/home/u/work", "/home/u/a.md", { flavor })).toBe(false);
  });

  it("counts the root itself only when asked", () => {
    const flavor = path.posix;
    expect(isWithin("/w", "/w", { flavor })).toBe(false);
    expect(isWithin("/w", "/w", { flavor, allowRoot: true })).toBe(true);
    expect(isWithin("/w", "/w/..x", { flavor })).toBe(true); // a name, not a parent step
  });
});

describe("Sandbox on the real file system", () => {
  let base: string;
  let root: string;
  let outside: string;

  beforeEach(async () => {
    base = await mkdtemp(path.join(tmpdir(), "mcp-workspace-"));
    root = path.join(base, "root");
    outside = path.join(base, "outside");
    await mkdir(path.join(root, "projects"), { recursive: true });
    await mkdir(outside);
    await writeFile(path.join(root, "projects", "plan.md"), "# Plan\n");
    await writeFile(path.join(outside, "secret.md"), "not yours\n");
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it("refuses a root that does not exist or is a file", async () => {
    await expect(Sandbox.open(path.join(base, "missing"))).rejects.toThrow("does not exist");
    await expect(Sandbox.open(path.join(root, "projects", "plan.md"))).rejects.toThrow(
      "not a directory",
    );
  });

  it("resolves existing and new paths inside the root", async () => {
    const sandbox = await Sandbox.open(root);
    expect(await sandbox.resolve("projects/plan.md", "note")).toBe(
      path.join(sandbox.root, "projects", "plan.md"),
    );
    expect(await sandbox.resolve("inbox/2026/new.md", "note")).toBe(
      path.join(sandbox.root, "inbox", "2026", "new.md"),
    );
    expect(await sandbox.resolve("projects", "folder")).toBe(path.join(sandbox.root, "projects"));
  });

  it("refuses a directory link that leads outside the root", async () => {
    // A junction needs no privileges on Windows; elsewhere this is a plain symlink.
    await symlink(outside, path.join(root, "escape"), isWindows ? "junction" : "dir");
    const sandbox = await Sandbox.open(root);

    await expect(sandbox.resolve("escape/secret.md", "note")).rejects.toThrow(
      "leads outside the workspace through a link",
    );
    await expect(sandbox.resolve("escape/new.md", "note")).rejects.toThrow(SandboxError);
    await expect(sandbox.resolve("escape", "folder")).rejects.toThrow(SandboxError);
  });

  it("allows a link that stays inside the root", async () => {
    await symlink(
      path.join(root, "projects"),
      path.join(root, "alias"),
      isWindows ? "junction" : "dir",
    );
    const sandbox = await Sandbox.open(root);
    await expect(sandbox.resolve("alias/plan.md", "note")).resolves.toBe(
      path.join(sandbox.root, "alias", "plan.md"),
    );
  });

  it.skipIf(isWindows)("refuses a file symlink that leads outside the root", async () => {
    // File symlinks need extra privileges on Windows; the junction case covers links there.
    await symlink(path.join(outside, "secret.md"), path.join(root, "secret.md"));
    const sandbox = await Sandbox.open(root);
    await expect(sandbox.resolve("secret.md", "note")).rejects.toThrow("through a link");
  });

  it("never puts the root's absolute path in an error", async () => {
    await symlink(outside, path.join(root, "escape"), isWindows ? "junction" : "dir");
    const sandbox = await Sandbox.open(root);
    const error = await sandbox.resolve("escape/secret.md", "note").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SandboxError);
    expect(String((error as Error).message)).not.toContain(base);
  });

  it.runIf(isWindows)("treats paths without case on Windows", async () => {
    const sandbox = await Sandbox.open(root.toUpperCase());
    await expect(sandbox.resolve("PROJECTS/PLAN.MD", "note")).resolves.toBeTruthy();
  });
});
