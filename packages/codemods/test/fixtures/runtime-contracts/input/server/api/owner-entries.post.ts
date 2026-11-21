import { guardRequest /* request checks */, defineForm, type GuardRequestOptions } from "@vite-hub/forms"
import { encodeRouteSegment, getRuntimeContext, toResponse } from "vite-hub/runtime"
import { RealtimeDocumentConflict // conflict handling
  , refreshRealtimeDocument } from "vite-hub/realtime/server"
import { normalizeSafeWorkspacePath, resolveRegisteredWorkspaceDefinition, useWorkspace } from "vite-hub/workspace"
import { invalidateWorkspaceStore, type WorkspaceStoreTarget } from "@vite-hub/workspace"
import { commentsErrorDiagnostics } from "vite-hub/comments"
import { commentsErrorDiagnostics as ownerDiagnostics, defineComments } from "@vite-hub/comments"

const options: GuardRequestOptions = { key: "votes" }
export type Target = WorkspaceStoreTarget

export default {
  async fetch(request: Request) {
    const [stopped] = await guardRequest(request, options)
    if (stopped) return stopped
    const path = normalizeSafeWorkspacePath("posts/a.md")
    await resolveRegisteredWorkspaceDefinition("docs")
    void invalidateWorkspaceStore
    await useWorkspace("docs").readFile(path)
    await refreshRealtimeDocument("docs", encodeRouteSegment(path))
    void defineForm, getRuntimeContext, RealtimeDocumentConflict, toResponse
    void commentsErrorDiagnostics, ownerDiagnostics, defineComments
    return new Response("ok")
  },
}
