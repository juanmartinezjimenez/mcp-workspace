// The read tools through a real MCP client, as a host would call them.
import { afterEach, describe, expect, it } from "vitest";
import { connect, makeWorkspace, SAMPLE_TASKS } from "./helpers.js";

const READ_TOOLS = ["notes_list", "notes_read", "notes_search", "tasks_list"];

let done: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const step of done.reverse()) await step();
  done = [];
});

async function session(files: Record<string, string>, options: Parameters<typeof connect>[1] = {}) {
  const workspace = await makeWorkspace(files);
  done.push(workspace.cleanup);
  const { client, close } = await connect(workspace.root, options);
  done.push(close);
  return { client, ...workspace };
}

function text(result: { content?: unknown }): string {
  const [first] = (result.content ?? []) as Array<{ type: string; text?: string }>;
  return first?.text ?? "";
}

describe("tool list", () => {
  it("lists exactly the read tools, all marked read-only", async () => {
    const { client } = await session({});
    const { tools } = await client.listTools();

    expect(tools.map((t) => t.name).sort()).toEqual(READ_TOOLS);
    for (const tool of tools) {
      expect(tool.annotations?.readOnlyHint).toBe(true);
      expect(tool.outputSchema).toBeDefined();
    }
  });

  it("reads a note as structured content and text", async () => {
    const { client } = await session({ "projects/plan.md": "# Plan\nShip v0.1.0\n" });
    const result = await client.callTool({
      name: "notes_read",
      arguments: { path: "projects/plan.md" },
    });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({
      path: "projects/plan.md",
      content: "# Plan\nShip v0.1.0\n",
      totalBytes: Buffer.byteLength("# Plan\nShip v0.1.0\n"),
      truncated: false,
    });
    expect(text(result)).toBe("# Plan\nShip v0.1.0\n");
  });
});

describe("read tools", () => {
  it("lists notes and searches them", async () => {
    const { client } = await session({ "a.md": "# A\nworkshop\n", "b.md": "# B\n" });

    const list = await client.callTool({ name: "notes_list", arguments: {} });
    expect(
      (list.structuredContent as { notes: Array<{ path: string }> }).notes.map((n) => n.path),
    ).toEqual(["a.md", "b.md"]);

    const search = await client.callTool({
      name: "notes_search",
      arguments: { query: "workshop" },
    });
    expect(search.structuredContent).toEqual({
      matches: [{ path: "a.md", line: 2, text: "workshop" }],
      skippedFiles: 0,
    });
  });

  it("lists open tasks by default", async () => {
    const { client } = await session({ "tasks.json": JSON.stringify(SAMPLE_TASKS) });
    const result = await client.callTool({ name: "tasks_list", arguments: {} });
    const titles = (result.structuredContent as { tasks: Array<{ title: string }> }).tasks.map(
      (t) => t.title,
    );
    expect(titles).toEqual(["Write the sandbox tests", "Book the bike service"]);
  });

  it("returns sandbox rejections as tool errors without the absolute root", async () => {
    const { client, base } = await session({});
    for (const path of ["../outside.md", "C:/Windows/win.ini", "nul.md", "notes.txt"]) {
      const result = await client.callTool({ name: "notes_read", arguments: { path } });
      expect(result.isError).toBe(true);
      expect(text(result)).not.toContain(base);
    }
    const missing = await client.callTool({
      name: "notes_read",
      arguments: { path: "missing.md" },
    });
    expect(text(missing)).toBe("note not found: missing.md");
  });

  it("enforces the configured search limit in the schema", async () => {
    const { client } = await session({ "a.md": "x\n" }, { limits: { maxSearchResults: 5 } });
    const result = await client.callTool({
      name: "notes_search",
      arguments: { query: "xx", limit: 6 },
    });
    expect(result.isError).toBe(true);
  });

  it("tells the model when a note was truncated", async () => {
    const { client } = await session(
      { "long.md": "z".repeat(1_500) },
      { limits: { maxReadBytes: 1_000 } },
    );
    const result = await client.callTool({ name: "notes_read", arguments: { path: "long.md" } });
    expect(result.structuredContent).toMatchObject({ truncated: true, totalBytes: 1_500 });
    expect(text(result)).toContain("[truncated: showing 1000 of 1500 bytes]");
  });
});
