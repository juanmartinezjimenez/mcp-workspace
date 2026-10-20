import { mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ToolError } from "../src/errors.js";
import { LIST_LIMIT, listNotes, readNote, searchNotes } from "../src/notes.js";
import { Sandbox, SandboxError } from "../src/sandbox.js";
import { makeWorkspace } from "./helpers.js";

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

async function workspace(files: Record<string, string>) {
  const made = await makeWorkspace(files);
  cleanup = made.cleanup;
  return { ...made, sandbox: await Sandbox.open(made.root) };
}

describe("listNotes", () => {
  it("lists .md notes sorted by path, with title, size and date", async () => {
    const { sandbox } = await workspace({
      "inbox.md": "# Inbox\n\n- call the workshop\n",
      "projects/agent-evals.md": "Intro line\n# Agent evals\n",
      "projects/no-heading.MD": "just text\n",
      "tasks.json": "{}",
      "projects/diagram.png": "png",
      "projects/readme.txt": "text",
      ".obsidian/workspace.md": "# hidden\n",
      "projects/.draft.md": "# hidden too\n",
    });

    const { notes, truncated } = await listNotes(sandbox);

    expect(truncated).toBe(false);
    expect(notes.map((n) => [n.path, n.title])).toEqual([
      ["inbox.md", "Inbox"],
      ["projects/agent-evals.md", "Agent evals"],
      ["projects/no-heading.MD", "no-heading"],
    ]);
    expect(notes[0]?.bytes).toBe(Buffer.byteLength("# Inbox\n\n- call the workshop\n"));
    expect(Date.parse(notes[0]?.modified ?? "")).not.toBeNaN();
  });

  it("filters by folder and reports a missing one", async () => {
    const { sandbox } = await workspace({ "a.md": "a", "projects/b.md": "b" });
    expect((await listNotes(sandbox, "projects")).notes.map((n) => n.path)).toEqual([
      "projects/b.md",
    ]);
    await expect(listNotes(sandbox, "missing")).rejects.toThrow(ToolError);
    await expect(listNotes(sandbox, "a.md")).rejects.toThrow("folder not found: a.md");
    await expect(listNotes(sandbox, "../")).rejects.toThrow(SandboxError);
  });

  // Creates and lists 503 files: well over Vitest's 5 s default on Windows runners.
  it(`stops at ${LIST_LIMIT} notes and says so`, { timeout: 30_000 }, async () => {
    const files = Object.fromEntries(
      Array.from({ length: LIST_LIMIT + 3 }, (_, i) => [`n${String(i).padStart(4, "0")}.md`, "x"]),
    );
    const { sandbox } = await workspace(files);
    const { notes, truncated } = await listNotes(sandbox);
    expect(notes).toHaveLength(LIST_LIMIT);
    expect(truncated).toBe(true);
  });

  it("does not follow links while listing", async () => {
    const { sandbox, base } = await workspace({ "a.md": "a" });
    await mkdir(path.join(base, "outside"));
    await writeFile(path.join(base, "outside", "secret.md"), "# Secret\n");
    await symlink(
      path.join(base, "outside"),
      path.join(sandbox.root, "linked"),
      process.platform === "win32" ? "junction" : "dir",
    );
    expect((await listNotes(sandbox)).notes.map((n) => n.path)).toEqual(["a.md"]);
  });
});

describe("readNote", () => {
  it("returns the whole note when it fits", async () => {
    const { sandbox } = await workspace({ "projects/plan.md": "# Plan\n\nÁrbol → hecho\n" });
    expect(await readNote(sandbox, "projects/plan.md", 1_000)).toEqual({
      path: "projects/plan.md",
      content: "# Plan\n\nÁrbol → hecho\n",
      totalBytes: Buffer.byteLength("# Plan\n\nÁrbol → hecho\n"),
      truncated: false,
    });
  });

  it("cuts long notes at a character boundary and says how big they are", async () => {
    const text = `${"a".repeat(999)}ñ${"b".repeat(500)}`; // "ñ" straddles byte 1000
    const { sandbox } = await workspace({ "long.md": text });

    const note = await readNote(sandbox, "long.md", 1_000);

    expect(note.truncated).toBe(true);
    expect(note.totalBytes).toBe(Buffer.byteLength(text));
    expect(note.content).toBe("a".repeat(999));
    expect(Buffer.byteLength(note.content)).toBeLessThanOrEqual(1_000);
  });

  it("refuses paths the sandbox rejects and notes that do not exist", async () => {
    const { sandbox } = await workspace({ "notes.txt": "x" });
    await expect(readNote(sandbox, "missing.md", 1_000)).rejects.toThrow(
      "note not found: missing.md",
    );
    await expect(readNote(sandbox, "notes.txt", 1_000)).rejects.toThrow("notes must be .md files");
    await expect(readNote(sandbox, "../escape.md", 1_000)).rejects.toThrow(SandboxError);
    await expect(readNote(sandbox, "con.md", 1_000)).rejects.toThrow("reserved device name");
  });
});

describe("searchNotes", () => {
  it("finds lines without case, with path and line number, up to the limit", async () => {
    const { sandbox } = await workspace({
      "a.md": "# Bikes\nThe WORKSHOP opens at 9\nnothing here\n",
      "b/c.md": "first\nCall the workshop on Monday\n",
      "d.md": "workshop again\n",
    });

    const all = await searchNotes(sandbox, "workshop", 10, 1_000);
    expect(all.matches).toEqual([
      { path: "a.md", line: 2, text: "The WORKSHOP opens at 9" },
      { path: "b/c.md", line: 2, text: "Call the workshop on Monday" },
      { path: "d.md", line: 1, text: "workshop again" },
    ]);
    expect((await searchNotes(sandbox, "workshop", 2, 1_000)).matches).toHaveLength(2);
  });

  it("skips files above the read limit and counts them", async () => {
    const { sandbox } = await workspace({
      "small.md": "needle\n",
      "big.md": `needle\n${"x".repeat(2_000)}`,
    });
    expect(await searchNotes(sandbox, "needle", 10, 1_000)).toEqual({
      matches: [{ path: "small.md", line: 1, text: "needle" }],
      skippedFiles: 1,
    });
  });
});
