// Launch options (ADR 0002, "Launch and configuration"). Anything invalid
// aborts start-up: a typo must never silently change what the agent can do.
import { parseArgs } from "node:util";

export class ConfigError extends Error {
  override name = "ConfigError";
}

export interface Limits {
  /** Maximum size of a note after a write or append, in UTF-8 bytes. */
  maxNoteBytes: number;
  /** Maximum bytes notes_read returns; notes_search skips larger files. */
  maxReadBytes: number;
  /** Upper bound for notes_search `limit`. */
  maxSearchResults: number;
}

export interface Config {
  root: string;
  limits: Limits;
}

export const DEFAULT_LIMITS: Readonly<Limits> = {
  maxNoteBytes: 100_000,
  maxReadBytes: 100_000,
  maxSearchResults: 20,
};

const LIMIT_OPTIONS = {
  maxNoteBytes: {
    flag: "max-note-bytes",
    env: "MCP_WORKSPACE_MAX_NOTE_BYTES",
    min: 1_000,
    max: 5_000_000,
  },
  maxReadBytes: {
    flag: "max-read-bytes",
    env: "MCP_WORKSPACE_MAX_READ_BYTES",
    min: 1_000,
    max: 5_000_000,
  },
  maxSearchResults: {
    flag: "max-search-results",
    env: "MCP_WORKSPACE_MAX_SEARCH_RESULTS",
    min: 1,
    max: 200,
  },
} as const;

function parseLimit(name: keyof Limits, raw: string | undefined): number {
  const { flag, min, max } = LIMIT_OPTIONS[name];
  if (raw === undefined) return DEFAULT_LIMITS[name];
  if (!/^\d+$/.test(raw)) throw new ConfigError(`--${flag} must be a whole number, got "${raw}"`);
  const value = Number(raw);
  if (value < min || value > max) {
    throw new ConfigError(`--${flag} must be between ${min} and ${max}, got ${value}`);
  }
  return value;
}

/** Reads the configuration from arguments, falling back to environment variables. */
export function parseConfig(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): Config {
  let values: Record<string, string | undefined>;
  try {
    ({ values } = parseArgs({
      args: [...argv],
      options: {
        root: { type: "string" },
        "max-note-bytes": { type: "string" },
        "max-read-bytes": { type: "string" },
        "max-search-results": { type: "string" },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (error) {
    throw new ConfigError((error as Error).message);
  }

  const root = values.root ?? env.MCP_WORKSPACE_ROOT;
  if (!root) throw new ConfigError("--root (or MCP_WORKSPACE_ROOT) is required");

  const limit = (name: keyof Limits) => {
    const { flag, env: variable } = LIMIT_OPTIONS[name];
    return parseLimit(name, values[flag] ?? env[variable]);
  };
  return {
    root,
    limits: {
      maxNoteBytes: limit("maxNoteBytes"),
      maxReadBytes: limit("maxReadBytes"),
      maxSearchResults: limit("maxSearchResults"),
    },
  };
}
