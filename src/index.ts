#!/usr/bin/env node
// Entry point: parse options, open the sandbox, serve MCP over stdio.
// stdout carries the protocol; everything else goes to stderr.
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { ConfigError, parseConfig } from "./config.js";
import { Sandbox, SandboxError } from "./sandbox.js";
import { createServer } from "./server.js";
import { SERVER_VERSION } from "./server-info.js";

async function main(): Promise<void> {
  try {
    const config = parseConfig(process.argv.slice(2), process.env);
    const sandbox = await Sandbox.open(config.root);
    const { maxNoteBytes, maxReadBytes, maxSearchResults } = config.limits;
    console.error(
      `mcp-workspace ${SERVER_VERSION}: root ${sandbox.root}; read-only; ` +
        `limits: note ${maxNoteBytes} B, read ${maxReadBytes} B, search ${maxSearchResults} results`,
    );
    serveStdio(() => createServer(config, sandbox));
  } catch (error) {
    if (error instanceof ConfigError || error instanceof SandboxError) {
      console.error(`mcp-workspace: ${error.message}`);
      process.exit(2);
    }
    throw error;
  }
}

await main();
