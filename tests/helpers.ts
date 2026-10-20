import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { type Config, DEFAULT_LIMITS, type Limits } from "../src/config.js";
import { Sandbox } from "../src/sandbox.js";
import { createServer } from "../src/server.js";

/** A temporary workspace with synthetic files; `cleanup` removes it. */
export async function makeWorkspace(files: Record<string, string> = {}) {
  const base = await mkdtemp(path.join(tmpdir(), "mcp-workspace-"));
  const root = path.join(base, "root");
  await mkdir(root);
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(root, ...relative.split("/"));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  return { base, root, cleanup: () => rm(base, { recursive: true, force: true }) };
}

/**
 * A real MCP client connected in-process to a server for `root`. The SDK's
 * in-memory pair speaks the 2025 (initialize) era only; the 2026-07-28 era is
 * covered end to end over stdio, through the same entry point hosts use.
 */
export async function connect(root: string, { limits = {} }: { limits?: Partial<Limits> } = {}) {
  const config: Config = { root, limits: { ...DEFAULT_LIMITS, ...limits } };
  const sandbox = await Sandbox.open(root);
  const server = createServer(config, sandbox);
  const [clientEnd, serverEnd] = InMemoryTransport.createLinkedPair();
  await server.connect(serverEnd);
  const client = new Client({ name: "mcp-workspace-tests", version: "0.0.0" });
  await client.connect(clientEnd);
  return { client, close: () => client.close() };
}

export const SAMPLE_TASKS = {
  version: 1,
  tasks: [
    {
      id: "0b7e8a4e-2f1c-4c55-9a9e-3d0f6f1b2c11",
      title: "Write the sandbox tests",
      status: "open",
      tags: ["mcp"],
      created: "2026-10-20T09:00:00.000Z",
    },
    {
      id: "6f1d2c3b-4a5e-4f60-8b7c-9d0e1f2a3b44",
      title: "Release agent-evals v0.4.0",
      status: "done",
      tags: ["agent-evals"],
      created: "2026-10-19T09:00:00.000Z",
      completed: "2026-10-20T10:25:00.000Z",
    },
    {
      id: "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c55",
      title: "Book the bike service",
      status: "open",
      due: "2026-10-23",
      tags: ["personal"],
      created: "2026-10-20T11:00:00.000Z",
    },
  ],
};
