// Write operations (ADR 0002). Each one is atomic (temporary file + rename)
// and all writes to one workspace run one at a time, so concurrent calls can
// neither interleave nor lose an append.
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Limits } from "./config.js";
import { ToolError } from "./errors.js";
import type { Sandbox } from "./sandbox.js";
import type { Task } from "./schemas.js";
import { loadTasks, TASKS_FILE } from "./tasks.js";
import { utf8Bytes } from "./text.js";

const queues = new WeakMap<Sandbox, Promise<unknown>>();

/** Runs `work` after every earlier write to the same workspace has finished. */
function serialized<T>(sandbox: Sandbox, work: () => Promise<T>): Promise<T> {
  const previous = queues.get(sandbox) ?? Promise.resolve();
  const next = previous.then(work, work);
  queues.set(
    sandbox,
    next.catch(() => undefined),
  );
  return next;
}

/** Writes through a hidden temporary file in the same folder, then renames it into place. */
async function writeAtomic(target: string, content: string): Promise<void> {
  const folder = path.dirname(target);
  await mkdir(folder, { recursive: true });
  const temporary = path.join(folder, `.${path.basename(target)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, content, { flag: "wx" });
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function existingSize(file: string): Promise<number | undefined> {
  const info = await stat(file).catch(() => undefined);
  if (info === undefined) return undefined;
  if (!info.isFile()) throw new ToolError("a folder already uses that name");
  return info.size;
}

function checkNoteSize(notePath: string, bytes: number, limits: Limits): void {
  if (bytes > limits.maxNoteBytes) {
    throw new ToolError(
      `${notePath} would be ${bytes} bytes; notes can be at most ${limits.maxNoteBytes} bytes`,
    );
  }
}

export function writeNote(
  sandbox: Sandbox,
  notePath: string,
  content: string,
  overwrite: boolean,
  limits: Limits,
): Promise<{ path: string; created: boolean; bytes: number }> {
  return serialized(sandbox, async () => {
    const file = await sandbox.resolve(notePath, "note");
    const bytes = utf8Bytes(content);
    checkNoteSize(notePath, bytes, limits);
    const current = await existingSize(file);
    if (current !== undefined && !overwrite) {
      throw new ToolError(`${notePath} already exists; pass overwrite: true to replace it`);
    }
    if (current !== undefined && current > limits.maxReadBytes) {
      // notes_read only ever showed part of it: replacing it would destroy the rest unseen.
      throw new ToolError(
        `${notePath} is ${current} bytes, more than notes_read returns (${limits.maxReadBytes}); ` +
          "it cannot be overwritten, use notes_append",
      );
    }
    await writeAtomic(file, content);
    return { path: notePath, created: current === undefined, bytes };
  });
}

export function appendNote(
  sandbox: Sandbox,
  notePath: string,
  text: string,
  limits: Limits,
): Promise<{ path: string; bytes: number }> {
  return serialized(sandbox, async () => {
    const file = await sandbox.resolve(notePath, "note");
    const current = await existingSize(file);
    if (current !== undefined) checkNoteSize(notePath, current + utf8Bytes(text), limits);
    const before = current === undefined ? "" : await readFile(file, "utf8");
    // The added text starts on its own line and the note always ends with a
    // newline, so the next append can never join the last line.
    const separator = before === "" || before.endsWith("\n") ? "" : "\n";
    const ending = text.endsWith("\n") ? "" : "\n";
    const content = before + separator + text + ending;
    const bytes = utf8Bytes(content);
    checkNoteSize(notePath, bytes, limits);
    await writeAtomic(file, content);
    return { path: notePath, bytes };
  });
}

async function saveTasks(sandbox: Sandbox, tasks: Task[]): Promise<void> {
  const file = await sandbox.resolve(TASKS_FILE, "path");
  await writeAtomic(file, `${JSON.stringify({ version: 1, tasks }, null, 2)}\n`);
}

export function addTask(
  sandbox: Sandbox,
  input: { title: string; due?: string | undefined; tags: string[] },
  now: () => Date = () => new Date(),
): Promise<{ task: Task }> {
  return serialized(sandbox, async () => {
    const tasks = await loadTasks(sandbox); // an invalid file throws and stays untouched
    const task: Task = {
      id: randomUUID(),
      title: input.title,
      status: "open",
      ...(input.due === undefined ? {} : { due: input.due }),
      tags: input.tags,
      created: now().toISOString(),
    };
    await saveTasks(sandbox, [...tasks, task]);
    return { task };
  });
}

export function completeTask(
  sandbox: Sandbox,
  id: string,
  now: () => Date = () => new Date(),
): Promise<{ task: Task }> {
  return serialized(sandbox, async () => {
    const tasks = await loadTasks(sandbox);
    const index = tasks.findIndex((task) => task.id === id);
    const found = tasks[index];
    if (found === undefined) throw new ToolError(`no task with id ${id}`);
    if (found.status === "done") return { task: found }; // idempotent
    const task: Task = { ...found, status: "done", completed: now().toISOString() };
    tasks[index] = task;
    await saveTasks(sandbox, tasks);
    return { task };
  });
}
