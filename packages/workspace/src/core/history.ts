import { lookup } from "mrmime"
import { hasRuntimeType, isRuntimeObject } from "@vite-hub/runtime/internal/runtime-type"

import { workspaceConflict, workspaceError } from "./errors.ts"
import { copyJsonFileMetadata, copyJsonWorkspaceMetadata } from "./file-metadata.ts"
import { isWorkspaceBytes, normalizeSafeWorkspacePath, sha256 } from "./path.ts"
import { createWorkspaceWritePolicy } from "./rules.ts"
import { workspaceErrorDiagnostics } from "../error-diagnostics.ts"

import type { WorkspaceSourceView, WorkspaceSourceWriteGrant } from "../sources/view.ts"
import type { Workspace, WorkspaceDefinition, WorkspaceEntry, WorkspaceFile, WorkspaceHistoryCommitOptions, WorkspaceHistoryFile, WorkspaceHistoryFileInput, WorkspaceHistoryReader, WorkspaceRetainedHistory, WorkspaceRevision, WorkspaceStore, WorkspaceStoreHistoryCommitOptions, WorkspaceWriteInput } from "./types.ts"

/** The ref used when a history call omits `ref`. A Store's working tree follows this ref. */
export const defaultWorkspaceHistoryRef = "main"

const historyRefPattern = /^[\w-]+(?:[./][\w-]+)*$/

// A resolved facade forwards its checked commit to the base facade.
// The base facade checks its rules and Source grants without repeating callbacks.
const forwardedHistoryCommits = new WeakSet<WorkspaceHistoryCommitOptions>()

export function forwardWorkspaceHistoryFiles(options: WorkspaceStoreHistoryCommitOptions): WorkspaceHistoryCommitOptions {
  const forwardFiles = (files: Record<string, WorkspaceFile> = {}) => Object.fromEntries(Object.entries(files).map(([path, file]) => [path, { content: file.content, mediaType: file.mediaType, metadata: file.metadata }]))
  const base = { ref: options.ref, ifHead: options.ifHead, ifHeads: options.ifHeads, message: options.message, metadata: options.metadata }
  const forwarded: WorkspaceHistoryCommitOptions = options.changes
    ? { ...base, changes: { put: forwardFiles(options.changes.put), delete: [...options.changes.delete ?? []] } }
    : { ...base, files: forwardFiles(options.files) }
  forwardedHistoryCommits.add(forwarded)
  return forwarded
}

export function requireWorkspaceHistory(workspace: Pick<Workspace, "history">): WorkspaceRetainedHistory {
  if (!workspace.history) throw historyUnavailable()
  return workspace.history
}

function historyUnavailable() {
  return workspaceErrorDiagnostics.WORKSPACE_R0069({ message: "[vitehub] This Workspace Store does not support retained history. Configure a Store with the history capability." })
}

/** Forward history only when the caller can inspect the complete folder. */
export function createWorkspaceHistoryReader(history: WorkspaceHistoryReader, complete: boolean): WorkspaceHistoryReader {
  function requireHistory() {
    if (!complete) throw workspaceErrorDiagnostics.WORKSPACE_R0069({ message: "[vitehub] Retained folder history requires access to the complete Workspace." })
    return history
  }
  return {
    head: async options => await requireHistory().head(options),
    list: async options => await requireHistory().list(options),
    refs: async () => await requireHistory().refs(),
    open: async id => await requireHistory().open(id),
    usage: async () => await requireHistory().usage(),
  }
}

export function validateHistoryMessage(message: unknown): asserts message is string | undefined {
  if (message !== undefined && !hasRuntimeType(message, "string")) throw workspaceError("[vitehub] History revision message must be a string.")
}

/** Resolve an optional ref name. Names use letters, numbers, `_` and `-`, joined by single `.` or `/`. */
export function normalizeHistoryRef(ref: unknown): string {
  if (ref === undefined) return defaultWorkspaceHistoryRef
  if (!hasRuntimeType(ref, "string") || ref.length > 128 || !historyRefPattern.test(ref)) {
    throw workspaceErrorDiagnostics.WORKSPACE_R0071({ message: `[vitehub] Invalid history ref${hasRuntimeType(ref, "string") ? ` ${JSON.stringify(ref.slice(0, 128))}` : ""}. Use up to 128 letters, numbers, underscores, and dashes, separated by single dots or slashes.` })
  }
  return ref
}

export function normalizeHistoryPath(path: string): string {
  return normalizeSafeWorkspacePath(path).split("/").filter(Boolean).join("/")
}

export function historyConflict(ref: string, expected: string | null, actual: string | null, details: Record<string, unknown> = {}) {
  return workspaceConflict(`[vitehub] History ref "${ref}" changed before the commit.`, { details: { ...details, ref, expected, actual } })
}

interface HistoryFileInput {
  file: WorkspaceFile
  explicitMediaType: boolean
  explicitMetadata: boolean
}

interface HistoryCommitShape {
  mode: "files" | "changes"
  puts: Map<string, HistoryFileInput>
  deletes: Set<string>
}

function readHistoryFiles(files: unknown, label: string): Map<string, HistoryFileInput> {
  if (!isRuntimeObject(files) || Array.isArray(files)) throw workspaceError(`[vitehub] History ${label} must be an object keyed by file path.`)
  const result = new Map<string, HistoryFileInput>()
  // SAFETY: The object check above admits only records; each value is validated below.
  for (const [path, value] of Object.entries(files as Record<string, WorkspaceHistoryFile>)) {
    const normalized = normalizeHistoryPath(path)
    if (result.has(normalized)) throw workspaceError(`[vitehub] Duplicate history file path: ${normalized}.`)
    // SAFETY: Non-byte objects are file inputs; their content and attributes are validated below.
    const input = !hasRuntimeType(value, "string") && !isWorkspaceBytes(value) && isRuntimeObject(value) ? value as WorkspaceHistoryFileInput : undefined
    const content: unknown = input ? input.content : value
    if (!hasRuntimeType(content, "string") && !isWorkspaceBytes(content)) throw workspaceError(`[vitehub] Invalid history file content: ${normalized}.`)
    if (input?.mediaType !== undefined && (!hasRuntimeType(input.mediaType, "string") || !input.mediaType)) throw workspaceError(`[vitehub] Invalid history file media type: ${normalized}.`)
    result.set(normalized, {
      file: {
        path: normalized,
        content: isWorkspaceBytes(content) ? new Uint8Array(content) : content,
        mediaType: input?.mediaType ?? (lookup(normalized) || "application/octet-stream"),
        metadata: copyJsonFileMetadata(normalized, input?.metadata),
      },
      explicitMediaType: Boolean(input && Object.hasOwn(input, "mediaType")),
      explicitMetadata: Boolean(input && Object.hasOwn(input, "metadata")),
    })
  }
  return result
}

function readHistoryCommit(options: WorkspaceHistoryCommitOptions): HistoryCommitShape {
  if ((options.files === undefined) === (options.changes === undefined)) throw workspaceError("[vitehub] History commit requires exactly one of files or changes.")
  if (options.files !== undefined) return { mode: "files", puts: readHistoryFiles(options.files, "files"), deletes: new Set() }
  const changes: unknown = options.changes
  if (!isRuntimeObject(changes) || Array.isArray(changes)) throw workspaceError("[vitehub] History changes must be an object with put and delete.")
  // SAFETY: The object check above admits the record; put and delete are validated as unknown values.
  const { put, delete: remove } = changes as { put?: unknown, delete?: unknown }
  const puts = readHistoryFiles(put ?? {}, "changes.put")
  if (remove !== undefined && !Array.isArray(remove)) throw workspaceError("[vitehub] History changes.delete must be an array of file paths.")
  const deletes = new Set<string>()
  for (const path of remove ?? []) {
    if (!hasRuntimeType(path, "string")) throw workspaceError("[vitehub] History changes.delete must be an array of file paths.")
    const normalized = normalizeHistoryPath(path)
    if (deletes.has(normalized) || puts.has(normalized)) throw workspaceError(`[vitehub] Duplicate history file path: ${normalized}.`)
    deletes.add(normalized)
  }
  return { mode: "changes", puts, deletes }
}

export function createWorkspaceHistory(definition: WorkspaceDefinition, store: WorkspaceStore, files: WorkspaceSourceView): WorkspaceRetainedHistory {
  const policy = createWorkspaceWritePolicy(definition)
  const history = () => {
    if (!store.history) throw historyUnavailable()
    return store.history
  }

  return {
    head: async options => await history().head(options),
    list: async options => await history().list(options),
    refs: async () => await history().refs(),
    open: async id => await history().open(id),
    usage: async () => await history().usage(),
    async commit(options) {
      const retained = history()
      validateHistoryMessage(options.message)
      const ref = normalizeHistoryRef(options.ref)
      if (options.ifHead !== null && (!hasRuntimeType(options.ifHead, "string") || !options.ifHead)) {
        throw workspaceError("[vitehub] History commit requires ifHead to be a revision id or null.")
      }
      const forwarded = forwardedHistoryCommits.has(options)
      const beforeWrite = forwarded ? policy.check : policy.before
      const commit = readHistoryCommit(options)
      const metadata = copyJsonWorkspaceMetadata("history revision", options.metadata)
      const current = await retained.head({ ref })
      if ((current?.id ?? null) !== options.ifHead) throw historyConflict(ref, options.ifHead, current?.id ?? null)
      const previous = current ? await retained.open(current.id) : undefined
      const previousEntries = new Map<string, WorkspaceEntry>()
      for (const entry of previous ? await previous.list("", { recursive: true }) : []) {
        if (entry.type === "file") previousEntries.set(entry.path, entry)
      }
      for (const path of commit.deletes) {
        if (!previousEntries.has(path)) throw workspaceError(`[vitehub] Workspace file does not exist: ${path}.`)
      }
      const candidates = commit.mode === "files"
        ? new Set([...commit.puts.keys(), ...previousEntries.keys()])
        : new Set([...commit.puts.keys(), ...commit.deletes])
      const desired: Record<string, WorkspaceFile> = Object.create(null)
      const changed = new Set<string>()
      const deleted: string[] = []
      const inputs: WorkspaceWriteInput[] = []
      const grants: WorkspaceSourceWriteGrant[] = []
      for (const path of [...candidates].sort()) {
        const put = commit.puts.get(path)
        const file = put?.file
        const before = previousEntries.get(path)
        const digest = before?.digest ?? (before && previous ? await sha256(await previous.readFile(path, { encoding: "binary" })) : undefined)
        if (put && file && before && digest === await sha256(file.content)
          && (!put.explicitMediaType || file.mediaType === before.mediaType)
          && (!put.explicitMetadata || JSON.stringify(file.metadata) === JSON.stringify(before.metadata))) {
          desired[path] = { ...file, mediaType: before.mediaType, metadata: before.metadata }
          continue
        }
        const requested = await files.assertWritable(path)
        const input = await beforeWrite({
          content: file?.content,
          mediaType: file?.mediaType,
          metadata: file?.metadata,
          operation: file ? "writeFile" : "rm",
          path: requested.path,
          previous: before,
          workspace: definition.name,
        })
        if (!forwarded) inputs.push(input)
        try {
          if (input.path !== requested.path || input.operation !== (file ? "writeFile" : "rm")) throw workspaceError(`[vitehub] History validators cannot rewrite file paths or operations: ${path}.`)
          grants.push(await files.assertWritable(input.path))
          if (file) {
            if (input.metadata && Object.hasOwn(input.metadata, "source")) throw workspaceError("[vitehub] metadata.source is reserved for Source materialization.")
            desired[path] = { ...file, content: input.content ?? file.content, mediaType: input.mediaType, metadata: copyJsonFileMetadata(path, input.metadata) }
            changed.add(path)
          }
          else deleted.push(path)
        }
        catch (error) {
          if (!forwarded) await policy.error(input, error)
          throw error
        }
      }
      const base = { ref, ifHead: options.ifHead, ifHeads: options.ifHeads, message: options.message, metadata }
      const storeOptions: WorkspaceStoreHistoryCommitOptions = commit.mode === "files"
        ? { ...base, files: desired }
        : { ...base, changes: { put: Object.fromEntries([...changed].map(path => [path, desired[path]!])), delete: deleted } }
      let revision: WorkspaceRevision
      try {
        revision = await files.requireHistoryGrants(retained)(grants, storeOptions)
      }
      catch (error) {
        for (const input of inputs) await policy.error(input, error)
        throw error
      }
      for (const input of inputs) await policy.after(input)
      return revision
    },
  }
}
