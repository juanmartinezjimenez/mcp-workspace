// End to end: the built server as a host launches it, over stdio, in both
// protocol eras. If anything but protocol messages reached stdout, the client
// would fail to parse it.
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { afterEach, describe, expect, it } from "vitest";
import { makeWorkspace } from "./helpers.js";

const SERVER = fileURLToPath(new URL("../dist/index.js", import.meta.url));

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

const ERAS = {
  "2025 (initialize)": {},
  "2026-07-28": { versionNegotiation: { mode: { pin: "2026-07-28" } } },
} as const;

describe.each(Object.entries(ERAS))("stdio, %s era", (_era, options) => {
  it("serves the read tools from the built entry point", async () => {
    const workspace = await makeWorkspace({ "inbox.md": "# Inbox\n" });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [SERVER, "--root", workspace.root],
      stderr: "pipe",
    });
    const client = new Client({ name: "stdio-test", version: "0.0.0" }, options);
    cleanup = async () => {
      await client.close();
      await workspace.cleanup();
    };

    await client.connect(transport);
    const { tools } = await client.listTools();
    const list = await client.callTool({ name: "notes_list", arguments: {} });

    expect(tools.map((t) => t.name).sort()).toEqual([
      "notes_list",
      "notes_read",
      "notes_search",
      "tasks_list",
    ]);
    expect(list.structuredContent).toMatchObject({ notes: [{ path: "inbox.md", title: "Inbox" }] });
  });
});

describe("stdio with --allow-write", () => {
  it("registers only the named write tools and writes through them", async () => {
    const workspace = await makeWorkspace({});
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [SERVER, "--root", workspace.root, "--allow-write", "notes_append"],
      stderr: "pipe",
    });
    const client = new Client({ name: "stdio-test", version: "0.0.0" });
    cleanup = async () => {
      await client.close();
      await workspace.cleanup();
    };

    await client.connect(transport);
    const names = (await client.listTools()).tools.map((t) => t.name);
    const appended = await client.callTool({
      name: "notes_append",
      arguments: { path: "inbox.md", text: "- from stdio\n" },
    });

    expect(names).toContain("notes_append");
    expect(names).not.toContain("notes_write");
    expect(appended.structuredContent).toEqual({ path: "inbox.md", bytes: 13 });
  });
});
