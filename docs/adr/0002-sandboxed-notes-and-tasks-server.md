# 0002. A sandboxed, read-only-by-default MCP server for notes and tasks over stdio

- Status: proposed
- Date: 2026-10-20

## Context

An AI agent becomes useful when it can read and update the user's own notes
and to-do list, and dangerous for the same reason: a tool that writes files is
arbitrary code execution with a nicer name. The MCP specification puts the
burden on implementors: tools "must be treated with appropriate caution", and
tool annotations "should be considered untrusted" by clients. So the safety of
this server cannot depend on the client honouring hints or on the model
behaving; it has to be enforced in the server.

Checked on 2026-10-20 against the official sources:

| What | Value | Where |
| --- | --- | --- |
| Protocol version | `2026-07-28` (stateless: no `initialize`, metadata in `_meta` on every request) | modelcontextprotocol.io/specification/latest |
| Standard transports | stdio and Streamable HTTP; HTTP+SSE (2024-11-05) deprecated | …/2026-07-28/basic/transports |
| TypeScript SDK | v2, `@modelcontextprotocol/server` and `@modelcontextprotocol/client` 2.3.1 (Node ≥ 20, Zod v4 / Standard Schema). v1 (`@modelcontextprotocol/sdk` 1.32.1) is maintenance only | npm registry, github.com/modelcontextprotocol/typescript-sdk README |
| Era compatibility | The v2 SDK serves both the `2026-07-28` era and the earlier `initialize` era from the same entry points | SDK docs, `docs/protocol-versions.md` |

## Decision

A Node.js server on the v2 TypeScript SDK that exposes **tools** for Markdown
notes and a task list kept under **one root folder**. It talks **stdio** only.
Every tool is **read-only unless the user enables that specific write tool** at
launch; disabled tools are not registered at all. Every path is resolved and
checked against the root, including symlinks, before any file is touched.
Storage is plain files: `.md` notes anywhere under the root and one
`tasks.json`.

### Launch and configuration

```bash
mcp-workspace --root ~/workspace                                   # read-only
mcp-workspace --root ~/workspace --allow-write notes_write,tasks_add,tasks_complete
```

- `--root` is required, must exist and be a directory. It is resolved with
  `realpath` once at start-up; everything else is relative to that canonical
  path.
- `--allow-write` takes a comma-separated list of write tool names. Unknown
  names abort start-up (a typo must not silently leave a tool disabled or
  enable something else). There is no wildcard: each write capability is named.
- Options can also come from `MCP_WORKSPACE_ROOT` and
  `MCP_WORKSPACE_ALLOW_WRITE`, because some hosts make environment variables
  easier to set than arguments. Command-line options win.

### Tools and schemas

Paths are POSIX-style, relative to the root (`projects/agent-evals.md`), on
every platform. Schemas are Zod v4; the SDK derives the JSON Schema that clients
see. Every tool also declares an `outputSchema` and returns `structuredContent`
next to a short text summary.

```ts
import * as z from "zod/v4";

const RelativePath = z
  .string()
  .min(1)
  .max(240)
  .regex(/^[^\\:*?"<>|\x00-\x1f]+$/, "use a relative path with forward slashes")
  .describe("Path relative to the workspace root, e.g. projects/ideas.md");

const NotePath = RelativePath.regex(/\.md$/, "notes are .md files");
const Tag = z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/);
const TaskId = z.uuid();

// Read tools (always registered)
const notesList = z.object({
  folder: RelativePath.optional().describe("Only notes under this folder"),
});
const notesRead = z.object({ path: NotePath });
const notesSearch = z.object({
  query: z.string().min(2).max(200),
  limit: z.int().min(1).max(50).default(10),
});
const tasksList = z.object({
  status: z.enum(["open", "done", "all"]).default("open"),
  tag: Tag.optional(),
});

// Write tools (registered only when named in --allow-write)
const notesWrite = z.object({
  path: NotePath,
  content: z.string().max(100_000),
  overwrite: z.boolean().default(false).describe("Required to replace an existing note"),
});
const notesAppend = z.object({ path: NotePath, text: z.string().min(1).max(20_000) });
const tasksAdd = z.object({
  title: z.string().min(1).max(200),
  due: z.iso.date().optional(),
  tags: z.array(Tag).max(10).default([]),
});
const tasksComplete = z.object({ id: TaskId });
```

| Tool | Kind | Annotations | Result |
| --- | --- | --- | --- |
| `notes_list` | read | `readOnlyHint: true` | `{ notes: [{ path, title, bytes, modified }] }`, up to 500, sorted by path |
| `notes_read` | read | `readOnlyHint: true` | `{ path, content }`; files over 1 MB are refused |
| `notes_search` | read | `readOnlyHint: true` | `{ matches: [{ path, line, text }] }`, case-insensitive substring search |
| `tasks_list` | read | `readOnlyHint: true` | `{ tasks: [{ id, title, status, due?, tags, created, completed? }] }` |
| `notes_write` | write | `readOnlyHint: false`, `destructiveHint: true` (can overwrite), `idempotentHint: true` | `{ path, created: boolean }` |
| `notes_append` | write | `readOnlyHint: false`, `destructiveHint: false` | `{ path, bytes }` |
| `tasks_add` | write | `readOnlyHint: false`, `destructiveHint: false` | `{ task }` with a new UUID |
| `tasks_complete` | write | `readOnlyHint: false`, `idempotentHint: true` | `{ task }`; completing a done task is a no-op |

There is **no delete tool** in this version. Deleting is the most damaging
write and the easiest to ask for by mistake; it can be added later behind its
own `--allow-write` name if a real need appears.

### Permission model

1. **Read-only by default.** Without `--allow-write`, only the four read tools
   exist.
2. **Writes are enabled per tool, by name.** A write tool that is not enabled
   is **not registered**, so it does not appear in `tools/list`: the model
   cannot call it, cannot waste turns on it, and the host does not offer it.
3. **Annotations are hints, enforcement is in the server.** `readOnlyHint` and
   `destructiveHint` help hosts decide what to ask the user before a call, but
   the server never relies on them: what is not registered cannot run.
4. **Errors are tool results.** Schema failures, sandbox rejections and size
   limits come back as `isError: true` results with a reason the model can act
   on (for example, "note exists; pass overwrite: true to replace it"). The
   server never echoes absolute paths in errors, so the root's location on disk
   does not leak to the model.
5. **Every write is logged to stderr** (tool, relative path or task id, bytes),
   never to stdout, which belongs to the protocol.

### Sandbox and path traversal

Every path argument goes through one function, `resolveInside(root, input)`,
before any file system call. It rejects, with a reason:

- empty paths, NUL and control characters, and backslashes (one separator on
  every platform; `a\..\b` cannot sneak past a POSIX check on Windows);
- absolute paths, drive letters (`C:`), UNC paths (`//server/share`) and
  anything `path.isAbsolute` accepts on either platform;
- any `..` segment, and any segment that starts with `.` (`.git`, `.env`,
  `.obsidian` stay out of reach);
- after `path.resolve(root, input)`, any result where
  `path.relative(root, resolved)` is empty, starts with `..` or is absolute;
- **symlinks that leave the root:** the deepest existing ancestor of the target
  (the file itself when it exists) is passed through `fs.realpath`, and the real
  path must still be inside the real root. This also covers junctions and
  case-insensitive file systems on Windows, because the comparison is between
  canonical paths.

Writes go to a temporary file in the same directory followed by a rename, so a
crash never leaves a half-written note or a truncated `tasks.json`. Writes to
`tasks.json` are serialized inside the process. The remaining gap is a
time-of-check/time-of-use race: a process outside the server that swaps a
directory for a symlink between the check and the write. Closing it needs
`O_NOFOLLOW`-style APIs that Node does not offer portably; the threat model is
a model making mistakes or being prompt-injected through note content, not a
second local process attacking the user, so this is documented and accepted.

### Transport: stdio only

The host launches the server as a subprocess and talks to it over stdin and
stdout, as every desktop host does (VS Code, Claude Code, Cursor). With stdio:

- there is **no listening socket**, so there is nothing for another program or
  a website to reach;
- the spec's Streamable HTTP requirements (validate `Origin` against DNS
  rebinding, bind to localhost, authenticate every connection) do not apply,
  because there is no HTTP endpoint to protect;
- the process lives and dies with the host session, and runs with exactly the
  user's permissions and nothing more.

Streamable HTTP would only pay for itself for a remote or shared server with
several clients, which this is not. The v2 SDK supports both transports from
the same server factory, so adding HTTP later does not change the tools; it
would need its own ADR for authentication.

### Storage

```text
<root>/
├── tasks.json              # { "version": 1, "tasks": [ ... ] }
├── inbox.md
└── projects/
    └── agent-evals.md
```

- Notes are the `.md` files under the root, so the folder can be an existing
  Markdown vault and stays readable and editable without the server. A note's
  title is its first `# ` heading, or the file name.
- Tasks live in one `tasks.json`, validated with the same Zod schemas on every
  read. A missing file means no tasks; an invalid file is an error, never
  overwritten. `version` lets the format change later without guessing.
- No database, no index: search reads the files. That is fast enough for a
  personal vault of a few thousand notes, and the limit (`notes_list` returns at
  most 500, search reads files under 1 MB) keeps a huge folder from stalling the
  server.

### How it is tested

- **Vitest**, with every test working on a fresh temporary root and only
  synthetic notes and tasks.
- **Sandbox tests** for `resolveInside`, table-driven: `..`, `foo/../../x`,
  absolute POSIX and Windows paths, `C:x`, UNC, backslashes, NUL, dot segments,
  and a symlink (and on Windows a junction) pointing outside the root. CI runs
  the suite on **Ubuntu and Windows**, because path rules differ between them.
- **Tool tests through a real MCP client**: `InMemoryTransport.createLinkedPair()`
  links a `Client` from `@modelcontextprotocol/client` to the server in one
  process, so tests go through `tools/list` and `tools/call` exactly as a host
  would: read-only mode lists only read tools, `--allow-write` registers only
  the named ones, and each tool's success and error results.
- **One end-to-end test over stdio**: `StdioClientTransport` spawns the built
  server, lists the tools and calls one, proving that nothing but protocol
  messages reaches stdout.
- **Usage example** in the README: the launch command and the configuration
  for Claude Code (`claude mcp add`) and VS Code (`.vscode/mcp.json`), with a
  sample root folder of synthetic notes.

## Alternatives considered

| Option | Why not |
| --- | --- |
| SDK v1 (`@modelcontextprotocol/sdk`) | Maintenance only since v2 shipped; v2 serves old and new clients anyway |
| Streamable HTTP first | Opens a network endpoint that then needs `Origin` checks, localhost binding and authentication, for a single local user who does not need it |
| All tools registered, writes rejected at call time | The model sees and tries tools it cannot use, and a bug in the check becomes a write; not registering is the stronger guarantee |
| A global `--read-only` switch or a wildcard `--allow-write all` | Too coarse: enabling notes for an agent should not also let it complete or add tasks |
| Trust annotations or the host's approval prompt | The spec calls annotations untrusted and hosts differ; enforcement has to live in the server |
| Expose the files as MCP resources instead of tools | Resources are read-only and application-driven; the agent needs to search and write, and tools keep one permission model for both |
| SQLite (or any database) | Adds a native dependency and hides the data from the user's editor; plain files are enough at this size |
| One JSON file per task, or tasks as Markdown checkboxes | Per-file tasks make listing slower and ids clumsier; checkboxes inside notes are hard to update safely by line |
| A delete tool | Highest damage, lowest need for a first version |
| Path checks with `startsWith(root)` on strings | Misses `/root-other`, symlinks and case differences; canonical `realpath` comparison does not |

## Consequences

An agent gets useful access to a notes folder with the smallest blast radius
that still allows writing: what is not enabled does not exist, and nothing
outside the root is reachable through paths or symlinks. Tests run against a
real MCP client on both operating systems. The server is local-only by design;
a shared or remote deployment would need a new ADR covering Streamable HTTP and
authentication. Search is linear in the number of files, which is the trade for
having no index to keep in sync.
