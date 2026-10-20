// Tasks live in one versioned tasks.json at the root (ADR 0002, "Storage").
import { readFile } from "node:fs/promises";
import { ToolError } from "./errors.js";
import type { Sandbox } from "./sandbox.js";
import { type Task, TasksFile } from "./schemas.js";

export const TASKS_FILE = "tasks.json";

/** All tasks; a missing file means none. An invalid file is an error and is never overwritten. */
export async function loadTasks(sandbox: Sandbox): Promise<Task[]> {
  const file = await sandbox.resolve(TASKS_FILE, "path");
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new ToolError(
      `${TASKS_FILE} is not valid JSON; fix it by hand, it will not be overwritten`,
    );
  }
  const parsed = TasksFile.safeParse(data);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path.join(".") || "(root)";
    throw new ToolError(`${TASKS_FILE} is not valid at ${where}: ${issue?.message ?? "invalid"}`);
  }
  return parsed.data.tasks;
}

export function filterTasks(
  tasks: readonly Task[],
  status: "open" | "done" | "all",
  tag?: string,
): Task[] {
  return tasks.filter(
    (task) =>
      (status === "all" || task.status === status) &&
      (tag === undefined || task.tags.includes(tag)),
  );
}
