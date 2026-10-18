import { getViteHubErrorShape } from "@vite-hub/runtime"
import { isWorkspaceConflict, resolveWorkspaceStoreTarget, useWorkspace } from "@vite-hub/workspace"
import { HTTPError } from "h3"

import type { ReadonlyWorkspaceFacade, WorkspaceSnapshot, WritableWorkspaceFacade } from "@vite-hub/workspace"
import type { RealtimeDocumentAdapter } from "./types.ts"
import { RealtimeDocumentConflict } from "./conflict.ts"
import { realtimeErrorDiagnostics } from "./error-diagnostics.ts"

export interface RealtimeWorkspaceDocumentAdapter extends RealtimeDocumentAdapter {
  kind: "workspace"
  workspace: string
}

export async function readRealtimeWorkspaceDocument(
  readable: ReadonlyWorkspaceFacade,
  writable: WritableWorkspaceFacade,
  documentId: string,
): Promise<{ baselineDigest: string | undefined, markdown: string }> {
  const stat = async () => {
    try {
      return await writable.fs.stat(documentId)
    }
    catch (error) {
      const shape = getViteHubErrorShape(error)
      // Registry failures name the missing Workspace; absent document paths do not.
      if (shape?.code === "WORKSPACE_NOT_FOUND" && shape.details?.name === undefined) return undefined
      throw error
    }
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    const before = await stat()
    let markdown = ""
    const source = await readable.fs.exists(documentId)
      ? readable.fs
      : before
        ? writable.fs
        : undefined
    if (source) {
      try {
        markdown = await source.readFile(documentId, { encoding: "utf8" })
      }
      catch (error) {
        if (!(await stat())) continue
        throw error
      }
    }
    const after = await stat()
    if (before?.digest === after?.digest) return { baselineDigest: after?.digest, markdown }
  }
  throw new HTTPError({ status: 409, message: "The Workspace document changed while opening its realtime room." })
}

const checkpointQueues = new Map<string, Promise<void>>()

async function serializeWorkspace<T>(workspaceName: string, operation: () => Promise<T>): Promise<T> {
  const previous = checkpointQueues.get(workspaceName) || Promise.resolve()
  let release!: () => void
  const current = new Promise<void>((resolve) => { release = resolve })
  checkpointQueues.set(workspaceName, current)
  await previous
  try {
    return await operation()
  }
  finally {
    release()
    if (checkpointQueues.get(workspaceName) === current) checkpointQueues.delete(workspaceName)
  }
}

/**
 * Stores each Realtime document as the Markdown file at its path in a Workspace working tree.
 * `history.checkpoint()` commits the working tree to Workspace history. `document: { workspace }`
 * in a Realtime Definition uses this adapter.
 */
export function workspaceDocument(workspaceName: string): RealtimeWorkspaceDocumentAdapter {
  return {
    kind: "workspace",
    workspace: workspaceName,
    async load({ documentId }) {
      const current = await readRealtimeWorkspaceDocument(
        useWorkspace(workspaceName),
        useWorkspace(workspaceName, { mode: "write" }),
        documentId,
      )
      return { body: current.markdown, digest: current.baselineDigest ?? null }
    },
    async save(context, document, { ifDigest }) {
      const { documentId } = context
      const workspace = useWorkspace(workspaceName, { mode: "write" })
      if (!(await workspace.capabilities()).conditionalWrites) {
        throw new HTTPError({ status: 501, message: "Realtime saves require a Workspace Store with conditional writes." })
      }
      if (context.authority === "cloudflare" && (await resolveWorkspaceStoreTarget(workspace))?.provider === "memory") {
        throw new HTTPError({ status: 501, message: "Durable realtime rooms require a durable Workspace Store." })
      }
      const current = ifDigest ? await workspace.fs.stat(documentId) : undefined
      try {
        await workspace.fs.writeFile(documentId, document.body, {
          ifDigest,
          mediaType: current?.mediaType,
          metadata: current?.metadata,
          preservePath: true,
        })
      }
      catch (error) {
        if (isWorkspaceConflict(error)) throw new RealtimeDocumentConflict("The document changed in Workspace after this realtime room loaded it.")
        throw error
      }
      // Workspace hooks may normalize the file; the room merges the stored form.
      const written = await readRealtimeWorkspaceDocument(workspace, workspace, documentId)
      if (!written.baselineDigest) throw realtimeErrorDiagnostics.REALTIME_MISSING_DIGEST({ operation: "save" })
      return { digest: written.baselineDigest, stored: { body: written.markdown } }
    },
    async checkpoint({ documentId }, { digest, message }): Promise<WorkspaceSnapshot> {
      return await serializeWorkspace(workspaceName, async () => {
        const workspace = useWorkspace(workspaceName, { mode: "write" })
        const options = { message: message || `docs: checkpoint ${documentId}` }
        let snapshot: WorkspaceSnapshot
        try {
          try {
            snapshot = await workspace.history.checkpoint(options)
          }
          catch (error) {
            if (!isWorkspaceConflict(error)) throw error
            await workspace.history.rebase({ takeRemote: [documentId] })
            snapshot = await workspace.history.checkpoint(options)
          }
        }
        catch (error) {
          if (isWorkspaceConflict(error)) throw new RealtimeDocumentConflict("The Workspace changed while checkpointing this realtime document.")
          throw error
        }
        if (snapshot.entries[documentId]?.digest !== digest) {
          throw new RealtimeDocumentConflict("The Workspace document changed while creating its realtime checkpoint.")
        }
        return snapshot
      })
    },
  }
}

export function isRealtimeWorkspaceDocument(adapter: RealtimeDocumentAdapter): adapter is RealtimeWorkspaceDocumentAdapter {
  return adapter.kind === "workspace" && "workspace" in adapter && typeof adapter.workspace === "string"
}
