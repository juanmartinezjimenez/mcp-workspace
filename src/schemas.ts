// Zod v4 schemas for tool inputs and outputs (ADR 0002, "Tools and schemas").
// Path shape only; the sandbox applies the full path rules.
import * as z from "zod/v4";
import type { Limits } from "./config.js";

export const RelativePath = z
  .string()
  .min(1)
  .max(240)
  .describe("Path relative to the workspace root, with forward slashes, e.g. projects/ideas.md");

export const NotePath = RelativePath.describe("A .md note, e.g. projects/ideas.md");
export const Tag = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,31}$/, "tags are lowercase words with dashes");

export const Task = z.object({
  id: z.uuid(),
  title: z.string().min(1).max(200),
  status: z.enum(["open", "done"]),
  due: z.iso.date().optional(),
  tags: z.array(Tag).max(10),
  created: z.iso.datetime(),
  completed: z.iso.datetime().optional(),
});
export type Task = z.infer<typeof Task>;

export const TasksFile = z.object({ version: z.literal(1), tasks: z.array(Task) });

export function readInputs(limits: Limits) {
  return {
    notes_list: z.object({
      folder: RelativePath.optional().describe("Only notes under this folder"),
    }),
    notes_read: z.object({ path: NotePath }),
    notes_search: z.object({
      query: z.string().min(2).max(200),
      limit: z
        .int()
        .min(1)
        .max(limits.maxSearchResults)
        .default(Math.min(10, limits.maxSearchResults)),
    }),
    tasks_list: z.object({
      status: z.enum(["open", "done", "all"]).default("open"),
      tag: Tag.optional(),
    }),
  };
}

export const readOutputs = {
  notes_list: z.object({
    notes: z.array(
      z.object({ path: z.string(), title: z.string(), bytes: z.int(), modified: z.iso.datetime() }),
    ),
    truncated: z.boolean(),
  }),
  notes_read: z.object({
    path: z.string(),
    content: z.string(),
    totalBytes: z.int(),
    truncated: z.boolean(),
  }),
  notes_search: z.object({
    matches: z.array(z.object({ path: z.string(), line: z.int(), text: z.string() })),
    skippedFiles: z.int(),
  }),
  tasks_list: z.object({ tasks: z.array(Task) }),
};

export function writeInputs(limits: Limits) {
  return {
    notes_write: z.object({
      path: NotePath,
      content: z.string().max(limits.maxNoteBytes).describe("The whole note, in Markdown"),
      overwrite: z.boolean().default(false).describe("Required to replace an existing note"),
    }),
    notes_append: z.object({
      path: NotePath,
      text: z.string().min(1).max(limits.maxNoteBytes).describe("Markdown to add at the end"),
    }),
    tasks_add: z.object({
      title: z.string().min(1).max(200),
      due: z.iso.date().optional().describe("Due date, YYYY-MM-DD"),
      tags: z.array(Tag).max(10).default([]),
    }),
    tasks_complete: z.object({ id: z.uuid().describe("The task id from tasks_list") }),
  };
}

export const writeOutputs = {
  notes_write: z.object({ path: z.string(), created: z.boolean(), bytes: z.int() }),
  notes_append: z.object({ path: z.string(), bytes: z.int() }),
  tasks_add: z.object({ task: Task }),
  tasks_complete: z.object({ task: Task }),
};
