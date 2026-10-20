import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_LIMITS, type Limits } from "../src/config.js";
import { ToolError } from "../src/errors.js";
import { Sandbox, SandboxError } from "../src/sandbox.js";
import { loadTasks } from "../src/tasks.js";
import { addTask, appendNote, completeTask, writeNote } from "../src/writes.js";
import { makeWorkspace, SAMPLE_TASKS } from "./helpers.js";

const LIMITS: Limits = { ...DEFAULT_LIMITS, maxNoteBytes: 1_000, maxReadBytes: 1_000 };

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

async function workspace(files: Record<string, string> = {}) {
  const made = await makeWorkspace(files);
  cleanup = made.cleanup;
  const sandbox = await Sandbox.open(made.root);
  const read = (relative: string) =>
    readFile(path.join(sandbox.root, ...relative.split("/")), "utf8");
  return { sandbox, read };
}

async function leftovers(folder: string): Promise<string[]> {
  return (await readdir(folder)).filter((name) => name.endsWith(".tmp"));
}

describe("writeNote", () => {
  it("creates a note and its folders", async () => {
    const { sandbox, read } = await workspace();
    expect(await writeNote(sandbox, "inbox/2026/idea.md", "# Idea\n", false, LIMITS)).toEqual({
      path: "inbox/2026/idea.md",
      created: true,
      bytes: 7,
    });
    expect(await read("inbox/2026/idea.md")).toBe("# Idea\n");
    expect(await leftovers(path.join(sandbox.root, "inbox", "2026"))).toEqual([]);
  });

  it("only replaces an existing note with overwrite", async () => {
    const { sandbox, read } = await workspace({ "plan.md": "old" });
    await expect(writeNote(sandbox, "plan.md", "new", false, LIMITS)).rejects.toThrow(
      "already exists; pass overwrite: true",
    );
    expect(await read("plan.md")).toBe("old");
    expect(await writeNote(sandbox, "plan.md", "new", true, LIMITS)).toMatchObject({
      created: false,
    });
    expect(await read("plan.md")).toBe("new");
  });

  it("refuses to overwrite a note larger than notes_read returns", async () => {
    const { sandbox, read } = await workspace({ "long.md": "x".repeat(1_200) });
    const limits = { ...LIMITS, maxNoteBytes: 5_000 };
    await expect(writeNote(sandbox, "long.md", "short", true, limits)).rejects.toThrow(
      "cannot be overwritten, use notes_append",
    );
    expect(await read("long.md")).toHaveLength(1_200);
  });

  it("counts the size limit in bytes and writes nothing above it", async () => {
    const { sandbox } = await workspace();
    await expect(writeNote(sandbox, "a.md", "ñ".repeat(500), false, LIMITS)).resolves.toMatchObject(
      {
        bytes: 1_000,
      },
    );
    await expect(writeNote(sandbox, "b.md", "ñ".repeat(501), false, LIMITS)).rejects.toThrow(
      "would be 1002 bytes; notes can be at most 1000 bytes",
    );
    expect((await readdir(sandbox.root)).sort()).toEqual(["a.md"]);
  });

  it("goes through the sandbox", async () => {
    const { sandbox } = await workspace();
    await expect(writeNote(sandbox, "../escape.md", "x", false, LIMITS)).rejects.toThrow(
      SandboxError,
    );
    await expect(writeNote(sandbox, "tasks.json", "{}", true, LIMITS)).rejects.toThrow(
      "notes must be .md files",
    );
    await expect(writeNote(sandbox, "aux.md", "x", false, LIMITS)).rejects.toThrow("reserved");
  });
});

describe("appendNote", () => {
  it("creates a missing note and appends on a new line", async () => {
    const { sandbox, read } = await workspace({ "log.md": "# Log\n- one" });
    await appendNote(sandbox, "new.md", "- first", LIMITS);
    expect(await read("new.md")).toBe("- first");
    expect(await appendNote(sandbox, "log.md", "- two\n", LIMITS)).toEqual({
      path: "log.md",
      bytes: Buffer.byteLength("# Log\n- one\n- two\n"),
    });
    await appendNote(sandbox, "log.md", "- three\n", LIMITS);
    expect(await read("log.md")).toBe("# Log\n- one\n- two\n- three\n");
  });

  it("refuses an append that would pass the size limit", async () => {
    const { sandbox, read } = await workspace({ "full.md": "x".repeat(995) });
    await expect(appendNote(sandbox, "full.md", "123456", LIMITS)).rejects.toThrow(
      "notes can be at most 1000 bytes",
    );
    expect(await read("full.md")).toHaveLength(995);
  });

  it("never loses an append when calls run at the same time", async () => {
    const { sandbox, read } = await workspace({ "log.md": "" });
    const lines = Array.from({ length: 25 }, (_, i) => `- line ${i}\n`);
    await Promise.all(lines.map((line) => appendNote(sandbox, "log.md", line, LIMITS)));
    expect((await read("log.md")).split("\n").filter(Boolean)).toHaveLength(25);
  });
});

describe("tasks", () => {
  const now = () => new Date("2026-10-20T12:00:00.000Z");

  it("adds a task with a new id and keeps the file versioned", async () => {
    const { sandbox, read } = await workspace();
    const { task } = await addTask(sandbox, { title: "Water the plants", tags: ["home"] }, now);

    expect(task).toMatchObject({
      title: "Water the plants",
      status: "open",
      tags: ["home"],
      created: "2026-10-20T12:00:00.000Z",
    });
    expect(task.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.parse(await read("tasks.json"))).toEqual({ version: 1, tasks: [task] });
  });

  it("completes a task once, idempotently", async () => {
    const { sandbox } = await workspace({ "tasks.json": JSON.stringify(SAMPLE_TASKS) });
    const id = SAMPLE_TASKS.tasks[0]?.id ?? "";

    const first = await completeTask(sandbox, id, now);
    const again = await completeTask(sandbox, id, () => new Date("2027-01-01T00:00:00.000Z"));

    expect(first.task).toMatchObject({ status: "done", completed: "2026-10-20T12:00:00.000Z" });
    expect(again.task.completed).toBe("2026-10-20T12:00:00.000Z");
    expect((await loadTasks(sandbox)).filter((t) => t.status === "done")).toHaveLength(2);
  });

  it("reports an unknown id", async () => {
    const { sandbox } = await workspace({ "tasks.json": JSON.stringify(SAMPLE_TASKS) });
    await expect(completeTask(sandbox, "00000000-0000-4000-8000-000000000000")).rejects.toThrow(
      ToolError,
    );
  });

  it("never rewrites an invalid tasks.json", async () => {
    const { sandbox, read } = await workspace({ "tasks.json": "{ broken" });
    await expect(addTask(sandbox, { title: "x", tags: [] })).rejects.toThrow("not valid JSON");
    expect(await read("tasks.json")).toBe("{ broken");
  });

  it("keeps every task when adds run at the same time", async () => {
    const { sandbox } = await workspace();
    await Promise.all(
      Array.from({ length: 20 }, (_, i) => addTask(sandbox, { title: `task ${i}`, tags: [] })),
    );
    expect(await loadTasks(sandbox)).toHaveLength(20);
    expect(await leftovers(sandbox.root)).toEqual([]);
  });
});
