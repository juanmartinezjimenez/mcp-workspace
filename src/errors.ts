/**
 * An expected failure the model can act on ("note not found", a limit). It
 * becomes an `isError: true` tool result. Messages only mention relative paths.
 */
export class ToolError extends Error {
  override name = "ToolError";
}
