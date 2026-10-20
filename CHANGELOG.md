# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.0] - 2026-10-20

### Added

- MCP server over stdio on the TypeScript SDK v2 (`@modelcontextprotocol/server` 2.3.1), serving both the `2026-07-28` protocol era and the earlier `initialize` era ([ADR 0002](docs/adr/0002-sandboxed-notes-and-tasks-server.md)).
- Read tools, always registered: `notes_list`, `notes_read`, `notes_search`, `tasks_list`, with Zod input and output schemas and read-only annotations.
- Write tools, registered only when named in `--allow-write`: `notes_write`, `notes_append`, `tasks_add`, `tasks_complete`. Writes are atomic and serialized per workspace.
- Path sandbox with the same rules on every platform: no traversal, absolute, UNC or drive paths, `:`, backslashes, hidden names, trailing dots or spaces, Windows device names or invalid characters; links resolved with `realpath` and refused outside the root; case-insensitive containment on Windows.
- Notes are `.md` files only; tasks live in a versioned `tasks.json` that is never overwritten when invalid.
- Configurable limits: `--max-note-bytes`, `--max-read-bytes` (with truncation and `totalBytes`), `--max-search-results`; `notes_write` refuses to replace a note larger than the read limit.
- `examples/workspace/`, a synthetic workspace that includes a prompt injection example.
- CI on Ubuntu and Windows: Biome, `tsc` (TypeScript 7) and Vitest.
