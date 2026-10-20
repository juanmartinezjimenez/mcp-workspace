// The example workspace in the README must stay valid for the server.
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { listNotes } from "../src/notes.js";
import { Sandbox } from "../src/sandbox.js";
import { loadTasks } from "../src/tasks.js";

const EXAMPLE = fileURLToPath(new URL("../examples/workspace", import.meta.url));

describe("examples/workspace", () => {
  it("has the notes and the valid tasks.json the README describes", async () => {
    const sandbox = await Sandbox.open(EXAMPLE);
    const { notes } = await listNotes(sandbox);
    expect(notes.map((n) => n.path)).toEqual([
      "clippings/pasted-recipe.md",
      "inbox.md",
      "projects/garden-planner.md",
      "projects/reading-list.md",
    ]);
    expect((await loadTasks(sandbox)).map((t) => t.status)).toEqual(["open", "done"]);
  });
});
