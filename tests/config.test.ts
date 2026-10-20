import { describe, expect, it } from "vitest";
import { ConfigError, DEFAULT_LIMITS, parseConfig } from "../src/config.js";

describe("parseConfig", () => {
  it("needs a root, is read-only by default and uses default limits", () => {
    expect(parseConfig(["--root", "work"], {})).toEqual({
      root: "work",
      allowWrite: new Set(),
      limits: DEFAULT_LIMITS,
    });
    expect(() => parseConfig([], {})).toThrow("--root (or MCP_WORKSPACE_ROOT) is required");
  });

  it("enables write tools only by name", () => {
    const config = parseConfig(["--root", "w", "--allow-write", "notes_append, tasks_add"], {});
    expect([...config.allowWrite].sort()).toEqual(["notes_append", "tasks_add"]);
    expect(parseConfig(["--root", "w", "--allow-write", ""], {}).allowWrite.size).toBe(0);
    expect([
      ...parseConfig([], { MCP_WORKSPACE_ROOT: "w", MCP_WORKSPACE_ALLOW_WRITE: "tasks_complete" })
        .allowWrite,
    ]).toEqual(["tasks_complete"]);
    const cliWins = parseConfig(["--root", "w", "--allow-write", "notes_write"], {
      MCP_WORKSPACE_ALLOW_WRITE: "tasks_add",
    });
    expect([...cliWins.allowWrite]).toEqual(["notes_write"]);
  });

  it.each(["all", "*", "notes_read", "notes_writes", "notes_write,delete"])(
    "refuses --allow-write %j",
    (value) => {
      expect(() => parseConfig(["--root", "w", "--allow-write", value], {})).toThrow(
        "--allow-write: unknown write tool",
      );
    },
  );

  it("reads environment variables, and options win over them", () => {
    const env = {
      MCP_WORKSPACE_ROOT: "from-env",
      MCP_WORKSPACE_MAX_NOTE_BYTES: "2000",
      MCP_WORKSPACE_MAX_READ_BYTES: "3000",
      MCP_WORKSPACE_MAX_SEARCH_RESULTS: "5",
    };
    expect(parseConfig([], env)).toEqual({
      root: "from-env",
      allowWrite: new Set(),
      limits: { maxNoteBytes: 2000, maxReadBytes: 3000, maxSearchResults: 5 },
    });
    const config = parseConfig(["--root", "cli", "--max-search-results", "50"], env);
    expect(config.root).toBe("cli");
    expect(config.limits.maxSearchResults).toBe(50);
  });

  it.each([
    [["--max-note-bytes", "999"], "between 1000 and 5000000"],
    [["--max-read-bytes", "5000001"], "between 1000 and 5000000"],
    [["--max-search-results", "0"], "between 1 and 200"],
    [["--max-search-results", "201"], "between 1 and 200"],
    [["--max-note-bytes", "1e5"], "whole number"],
    [["--max-read-bytes=-5"], "whole number"],
    [["--max-search-results", "ten"], "whole number"],
  ])("rejects %j", (args, message) => {
    expect(() => parseConfig(["--root", "work", ...args], {})).toThrow(message);
  });

  it("rejects unknown options and stray arguments", () => {
    expect(() => parseConfig(["--root", "work", "--allow-everything"], {})).toThrow(ConfigError);
    expect(() => parseConfig(["--root", "work", "extra"], {})).toThrow(ConfigError);
  });
});
