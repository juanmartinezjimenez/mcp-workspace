// Write tools through a real MCP client: they exist only when enabled by name.
import { afterEach, describe, expect, it } from "vitest";
import type { WriteTool } from "../src/config.js";
import { connect, makeWorkspace } from "./helpers.js";

let done: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const step of done.reverse()) await step();
  done = [];
});

async function session(files: Record<string, string>, allowWrite: WriteTool[]) {
  const workspace = await makeWorkspace(files);
  done.push(workspace.cleanup);
  const { client, close } = await connect(workspace.root, { allowWrite });
  done.push(close);
  return client;
}

async function toolNames(allowWrite: WriteTool[]): Promise<string[]> {
  const client = await session({}, allowWrite);
  return (await client.listTools()).tools.map((t) => t.name).sort();
}

describe("write tools", () => {
  it("do not exist in read-only mode", async () => {
    expect(await toolNames([])).toEqual(["notes_list", "notes_read", "notes_search", "tasks_list"]);
  });

  it("are registered exactly as named", async () => {
    expect(await toolNames(["notes_append"])).toContain("notes_append");
    expect(await toolNames(["notes_append"])).not.toContain("notes_write");
    expect(await toolNames(["notes_write", "notes_append", "tasks_add", "tasks_complete"])).toEqual(
      [
        "notes_append",
        "notes_list",
        "notes_read",
        "notes_search",
        "notes_write",
        "tasks_add",
        "tasks_complete",
        "tasks_list",
      ],
    );
  });

  it("carry the annotations of ADR 0002", async () => {
    const client = await session({}, [
      "notes_write",
      "notes_append",
      "tasks_add",
      "tasks_complete",
    ]);
    const annotations = Object.fromEntries(
      (await client.listTools()).tools.map((t) => [t.name, t.annotations]),
    );
    expect(annotations.notes_write).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
    });
    expect(annotations.notes_append).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    expect(annotations.tasks_add).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    expect(annotations.tasks_complete).toMatchObject({ readOnlyHint: false, idempotentHint: true });
  });

  it("cannot be called when not enabled", async () => {
    const client = await session({}, ["notes_append"]);
    const refused = await client
      .callTool({ name: "notes_write", arguments: { path: "x.md", content: "x" } })
      .then(
        (result) => result.isError === true,
        () => true,
      );
    expect(refused).toBe(true);
  });

  it("write a note that the read tools then see", async () => {
    const client = await session({}, ["notes_write"]);
    const written = await client.callTool({
      name: "notes_write",
      arguments: { path: "inbox/idea.md", content: "# Idea\nShip it\n" },
    });
    expect(written.structuredContent).toEqual({ path: "inbox/idea.md", created: true, bytes: 15 });

    const read = await client.callTool({
      name: "notes_read",
      arguments: { path: "inbox/idea.md" },
    });
    expect(read.structuredContent).toMatchObject({ content: "# Idea\nShip it\n" });
  });

  it("add and complete a task", async () => {
    const client = await session({}, ["tasks_add", "tasks_complete"]);
    const added = await client.callTool({
      name: "tasks_add",
      arguments: { title: "Book the bike service", due: "2026-10-23", tags: ["personal"] },
    });
    const { task } = added.structuredContent as { task: { id: string } };

    const completed = await client.callTool({ name: "tasks_complete", arguments: { id: task.id } });
    expect(completed.structuredContent).toMatchObject({ task: { id: task.id, status: "done" } });

    const open = await client.callTool({ name: "tasks_list", arguments: {} });
    expect(open.structuredContent).toEqual({ tasks: [] });
  });

  it("report refusals as tool errors", async () => {
    const client = await session({ "plan.md": "old" }, ["notes_write"]);
    const result = await client.callTool({
      name: "notes_write",
      arguments: { path: "plan.md", content: "new" },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("pass overwrite: true");
  });
});
