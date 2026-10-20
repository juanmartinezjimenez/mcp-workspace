import { afterEach, describe, expect, it } from "vitest";
import { ToolError } from "../src/errors.js";
import { Sandbox } from "../src/sandbox.js";
import { filterTasks, loadTasks } from "../src/tasks.js";
import { makeWorkspace, SAMPLE_TASKS } from "./helpers.js";

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

async function sandboxWith(files: Record<string, string>) {
  const made = await makeWorkspace(files);
  cleanup = made.cleanup;
  return Sandbox.open(made.root);
}

describe("tasks", () => {
  it("treats a missing tasks.json as no tasks", async () => {
    expect(await loadTasks(await sandboxWith({}))).toEqual([]);
  });

  it("loads and filters by status and tag", async () => {
    const tasks = await loadTasks(
      await sandboxWith({ "tasks.json": JSON.stringify(SAMPLE_TASKS) }),
    );
    expect(tasks).toHaveLength(3);
    expect(filterTasks(tasks, "open").map((t) => t.title)).toEqual([
      "Write the sandbox tests",
      "Book the bike service",
    ]);
    expect(filterTasks(tasks, "done").map((t) => t.title)).toEqual(["Release agent-evals v0.4.0"]);
    expect(filterTasks(tasks, "all", "personal").map((t) => t.title)).toEqual([
      "Book the bike service",
    ]);
    expect(filterTasks(tasks, "open", "agent-evals")).toEqual([]);
  });

  it.each([
    ["{ not json", "not valid JSON"],
    [JSON.stringify({ version: 2, tasks: [] }), "not valid at version"],
    [JSON.stringify({ version: 1, tasks: [{ id: "x", title: "t" }] }), "not valid at tasks.0"],
  ])("refuses an invalid tasks.json (%s)", async (content, message) => {
    const sandbox = await sandboxWith({ "tasks.json": content });
    await expect(loadTasks(sandbox)).rejects.toThrow(ToolError);
    await expect(loadTasks(sandbox)).rejects.toThrow(message);
  });
});
