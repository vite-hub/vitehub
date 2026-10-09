import { lookup } from "mrmime"
import { hasRuntimeType } from "@vite-hub/runtime/internal/runtime-type"

import { workspaceConflict, workspaceError } from "./errors.ts"
import { copyJsonFileMetadata, copyJsonWorkspaceMetadata } from "./file-metadata.ts"
import { isWorkspaceBytes, normalizeSafeWorkspacePath, sha256 } from "./path.ts"
import { createWorkspaceWritePolicy } from "./rules.ts"
import { workspaceErrorDiagnostics } from "../error-diagnostics.ts"

import type { WorkspaceSourceView, WorkspaceSourceWriteGrant } from "../sources/view.ts"
import type { Workspace, WorkspaceDefinition, WorkspaceFile, WorkspaceHistoryCommitOptions, WorkspaceHistoryReader, WorkspaceRetainedHistory, WorkspaceRevision, WorkspaceStore, WorkspaceStoreHistory, WorkspaceWriteInput } from "./types.ts"

// Keep per-file hook output when a resolved facade forwards the public file set.
// The base facade checks its rules and Source grants without repeating callbacks.
const forwardedHistoryFiles = new WeakMap<WorkspaceHistoryCommitOptions, Record<string, WorkspaceFile>>()

export function forwardWorkspaceHistoryFiles(options: Parameters<WorkspaceStoreHistory["commit"]>[0]): WorkspaceHistoryCommitOptions {
  const forwarded = { ...options, files: Object.fromEntries(Object.entries(options.files).map(([path, file]) => [path, file.content])) }
  forwardedHistoryFiles.set(forwarded, options.files)
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
    head: async () => await requireHistory().head(),
    list: async options => await requireHistory().list(options),
    open: async id => await requireHistory().open(id),
    usage: async () => await requireHistory().usage(),
  }
}

export function validateHistoryMessage(message: unknown): asserts message is string | undefined {
  if (message !== undefined && !hasRuntimeType(message, "string")) throw workspaceError("[vitehub] History revision message must be a string.")
}

export function normalizeHistoryPath(path: string): string {
  return normalizeSafeWorkspacePath(path).split("/").filter(Boolean).join("/")
}

export function createWorkspaceHistory(definition: WorkspaceDefinition, store: WorkspaceStore, files: WorkspaceSourceView): WorkspaceRetainedHistory {
  const policy = createWorkspaceWritePolicy(definition)
  const history = () => {
    if (!store.history) throw historyUnavailable()
    return store.history
  }

  return {
    head: async () => await history().head(),
    list: async options => await history().list(options),
    open: async id => await history().open(id),
    usage: async () => await history().usage(),
    async commit(options) {
      const retained = history()
      validateHistoryMessage(options.message)
      if (options.ifHead !== null && (!hasRuntimeType(options.ifHead, "string") || !options.ifHead)) {
        throw workspaceError("[vitehub] History commit requires ifHead to be a revision id or null.")
      }
      const forwardedFiles = forwardedHistoryFiles.get(options)
      const beforeWrite = forwardedFiles ? policy.check : policy.before
      const desired: Record<string, WorkspaceFile> = Object.create(null)
      for (const [path, content] of Object.entries(options.files)) {
        const normalized = normalizeHistoryPath(path)
        if (Object.hasOwn(desired, normalized)) throw workspaceError(`[vitehub] Duplicate history file path: ${normalized}.`)
        if (!hasRuntimeType(content, "string") && !isWorkspaceBytes(content)) throw workspaceError(`[vitehub] Invalid history file content: ${normalized}.`)
        const forwarded = forwardedFiles?.[path]
        desired[normalized] = {
          path: normalized,
          content: isWorkspaceBytes(content) ? new Uint8Array(content) : content,
          mediaType: forwarded?.mediaType ?? (lookup(normalized) || "application/octet-stream"),
          metadata: copyJsonFileMetadata(normalized, forwarded?.metadata),
        }
      }
      const metadata = copyJsonWorkspaceMetadata("history revision", options.metadata)
      const current = await retained.head()
      if ((current?.id ?? null) !== options.ifHead) {
        throw workspaceConflict("[vitehub] Workspace head changed before the history commit.", { details: { expected: options.ifHead, actual: current?.id ?? null } })
      }
      const previous = current ? await retained.open(current.id) : undefined
      const previousEntries = previous ? (await previous.list("", { recursive: true })).filter(entry => entry.type === "file") : []
      const inputs: WorkspaceWriteInput[] = []
      const grants: WorkspaceSourceWriteGrant[] = []
      for (const path of [...new Set([...Object.keys(desired), ...previousEntries.map(entry => entry.path)])].sort()) {
        const file = desired[path]
        const before = previousEntries.find(entry => entry.path === path)
        const digest = before?.digest ?? (before && previous ? await sha256(await previous.readFile(path, { encoding: "binary" })) : undefined)
        if (file && before && digest === await sha256(file.content)
          && (!forwardedFiles || file.mediaType === before.mediaType && JSON.stringify(file.metadata) === JSON.stringify(before.metadata))) {
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
        if (!forwardedFiles) inputs.push(input)
        try {
          if (input.path !== requested.path || input.operation !== (file ? "writeFile" : "rm")) throw workspaceError(`[vitehub] History validators cannot rewrite file paths or operations: ${path}.`)
          grants.push(await files.assertWritable(input.path))
          if (file) {
            if (input.metadata && Object.hasOwn(input.metadata, "source")) throw workspaceError("[vitehub] metadata.source is reserved for Source materialization.")
            desired[path] = { ...file, content: input.content ?? file.content, mediaType: input.mediaType, metadata: copyJsonFileMetadata(path, input.metadata) }
          }
        }
        catch (error) {
          if (!forwardedFiles) await policy.error(input, error)
          throw error
        }
      }
      let revision: WorkspaceRevision
      try {
        revision = await files.requireHistoryGrants(retained)(grants, { ...options, metadata, files: desired })
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
