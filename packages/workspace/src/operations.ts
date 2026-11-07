import { defineOperation } from "@vite-hub/internal/operations"
import * as v from "valibot"

import { workspaceHistoryDefaultLimit, workspaceHistoryMaximumLimit } from "./results.ts"

import type { AnyOperation, OperationDefinition } from "@vite-hub/internal/operations"
import type { WorkspaceChanges, WorkspaceCommitResult, WorkspaceHistoryDetails, WorkspaceHistoryFile, WorkspaceHistoryList, WorkspaceHistoryRefs, WorkspaceHistoryRevision } from "./results.ts"

// The runtime module reads the Workspace registry of the app, which only exists in the Nitro runtime. The operations
// load it when they run, so the CLI and `vitehub inspect` can list them without it.
const runtime = () => import("./runtime/operations.ts")

const name = v.pipe(v.string(), v.check(value => value.trim() !== "", "Name a Workspace."))
const nonEmpty = (message: string) => v.pipe(v.string(), v.check(value => value !== "", message))

function defineWorkspaceOperation<Input, Output>(definition: Omit<OperationDefinition<Input, Output>, "kind" | "section" | "user">, kind: "read" | "write" = "read"): OperationDefinition<Input, Output> {
  // Console section `workspaces` grants these. None reads the signed-in user.
  return defineOperation({ ...definition, kind, section: "workspaces", user: false })
}

function table(rows: readonly (readonly string[])[]): string {
  const widths = rows[0]!.map((_, column) => Math.max(...rows.map(row => row[column]!.length)))
  return rows.map(row => row.map((cell, column) => column === row.length - 1 ? cell : cell.padEnd(widths[column]!)).join("  ")).join("\n")
}

function oneLine(value: string | undefined): string {
  return value?.split(/\r?\n/, 1)[0]?.trim() || "-"
}

function formatHistory(result: WorkspaceHistoryList): string {
  if (!result.revisions.length) return result.ref ? `No revisions on ref ${result.ref}.\n` : "No revisions.\n"
  const lines = [table([
    ["REVISION", "REF", "CREATED AT", "AUTHOR", "FILES", "MESSAGE"],
    ...result.revisions.map(revision => [revision.id, revision.ref, revision.createdAt, revision.author ?? "-", String(revision.files), oneLine(revision.message)]),
  ])]
  if (result.cursor && result.ref) lines.push(`More revisions: vitehub workspace history ${result.workspace} --ref ${result.ref} --cursor ${result.cursor}`)
  else if (result.more) lines.push("More revisions exist. Use --ref <ref> to page through one ref.")
  return `${lines.join("\n")}\n`
}

function formatRefs(result: WorkspaceHistoryRefs): string {
  if (!result.refs.length) return "No refs. The Workspace has no retained revisions yet.\n"
  return `${table([
    ["REF", "HEAD", "CREATED AT", "AUTHOR", "MESSAGE"],
    ...result.refs.map(ref => [ref.name, ref.head.id, ref.head.createdAt, ref.head.author ?? "-", oneLine(ref.head.message)]),
  ])}\n`
}

function formatFiles(files: readonly WorkspaceHistoryFile[]): string {
  if (!files.length) return "No files."
  return table([
    ["PATH", "SIZE", "MEDIA TYPE", "DIGEST"],
    ...files.map(file => [file.path, file.size === undefined ? "-" : String(file.size), file.mediaType ?? "-", file.digest ?? "-"]),
  ])
}

function formatRevision(revision: WorkspaceHistoryRevision): string[] {
  return [
    `Revision: ${revision.id}`,
    `Ref: ${revision.ref}`,
    `Parent: ${revision.parentId ?? "-"}`,
    `Created at: ${revision.createdAt}`,
    `Author: ${revision.author ?? "-"}`,
    `Message: ${revision.message ?? "-"}`,
    `Files: ${revision.files} (${revision.bytes} bytes)`,
  ]
}

function formatShow(result: WorkspaceHistoryDetails): string {
  if (result.file) {
    if (result.file.encoding === "utf8") return result.file.content
    return `${result.file.path} is binary (${result.file.size ?? "unknown"} bytes). Run the command with --json to read its content as base64.\n`
  }
  return `${[...formatRevision(result.revision), ...(result.path ? [`Path: ${result.path}`] : []), "", formatFiles(result.files ?? [])].join("\n")}\n`
}

const history = defineWorkspaceOperation<{ cursor?: string, limit?: number, ref?: string, workspace: string }, WorkspaceHistoryList>({
  cli: { command: "history", format: formatHistory, namespace: "workspace", positional: ["workspace"] },
  description: `List the retained revisions of a Workspace, newest first. Without \`ref\`, the list merges every ref. \`limit\` defaults to ${workspaceHistoryDefaultLimit}.`,
  input: v.object({
    cursor: v.optional(nonEmpty("The cursor cannot be empty.")),
    limit: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(workspaceHistoryMaximumLimit))),
    ref: v.optional(nonEmpty("The ref cannot be empty.")),
    workspace: name,
  }),
  name: "workspace.history",
  run: async input => await (await runtime()).runWorkspaceOperation("history", input),
})

const refs = defineWorkspaceOperation<{ workspace: string }, WorkspaceHistoryRefs>({
  cli: { command: "refs", format: formatRefs, namespace: "workspace", positional: ["workspace"] },
  description: "List the history refs of a Workspace and the head revision of each ref.",
  input: v.object({ workspace: name }),
  name: "workspace.refs",
  run: async input => await (await runtime()).runWorkspaceOperation("refs", input),
})

const show = defineWorkspaceOperation<{ path?: string, target: string, workspace: string }, WorkspaceHistoryDetails>({
  cli: { command: "show", format: formatShow, namespace: "workspace", positional: ["workspace", "target", "path"] },
  description: "Show one revision of a Workspace by ref or revision id, with its files. With `path`, return that file as it was in the revision.",
  input: v.object({
    path: v.optional(nonEmpty("The path cannot be empty.")),
    target: nonEmpty("Name a ref or revision."),
    workspace: name,
  }),
  name: "workspace.show",
  run: async input => await (await runtime()).runWorkspaceOperation("show", input),
})

function formatChanges(result: WorkspaceChanges): string {
  if (!result.head) return `Ref ${result.ref} has no revisions.\n`
  if (!result.files.length) return `No changes. Ref ${result.ref} is at ${result.head.id}.\n`
  return `${table([["PATH", "CHANGE"], ...result.files.map(file => [file.path, file.deleted ? "deleted" : file.base ? "changed" : "added"])])}\nHead: ${result.head.id}\n`
}

const encodedFile = v.object({ content: v.string(), encoding: v.picklist(["base64", "utf8"]) })

const changes = defineWorkspaceOperation<{ content?: boolean, ref?: string, since?: string | null, workspace: string }, WorkspaceChanges>({
  cli: { command: "changes", format: formatChanges, namespace: "workspace", positional: ["workspace"] },
  description: "List the files of a ref that changed since a revision, with their content at the head and at that revision. Without `since`, list every file of the head. `vitehub workspace pull` reads it.",
  input: v.object({
    content: v.optional(v.boolean()),
    ref: v.optional(nonEmpty("The ref cannot be empty.")),
    since: v.optional(v.nullable(nonEmpty("The revision cannot be empty."))),
    workspace: name,
  }),
  name: "workspace.changes",
  run: async input => await (await runtime()).runWorkspaceChanges(input),
})

const commit = defineWorkspaceOperation<{ delete?: string[], ifHead: string | null, message?: string, put?: Record<string, { content: string, encoding: "base64" | "utf8" }>, ref?: string, workspace: string }, WorkspaceCommitResult>({
  cli: { command: "commit", namespace: "workspace", positional: ["workspace"] },
  description: "Commit files to a ref when its head is still `ifHead`, else fail with WORKSPACE_CONFLICT. `put` writes files and `delete` removes paths; other files keep their content. Workspace write rules and validators run. `vitehub workspace push` calls it.",
  input: v.object({
    delete: v.optional(v.array(nonEmpty("A path cannot be empty."))),
    ifHead: v.nullable(nonEmpty("The head cannot be empty.")),
    message: v.optional(v.string()),
    put: v.optional(v.record(nonEmpty("A path cannot be empty."), encodedFile)),
    ref: v.optional(nonEmpty("The ref cannot be empty.")),
    workspace: name,
  }),
  name: "workspace.commit",
  run: async input => await (await runtime()).runWorkspaceCommit(input),
}, "write")

/** The `workspace.*` operations: history, refs, show, changes, and commit. The Console, `vitehub workspace`, and agents run them. */
export const workspaceOperations: readonly AnyOperation[] = [history, refs, show, changes, commit]

export type { WorkspaceChangedFile, WorkspaceChanges, WorkspaceCommitResult, WorkspaceHistoryContent, WorkspaceHistoryDetails, WorkspaceHistoryFile, WorkspaceHistoryList, WorkspaceHistoryRefs, WorkspaceHistoryRevision } from "./results.ts"
