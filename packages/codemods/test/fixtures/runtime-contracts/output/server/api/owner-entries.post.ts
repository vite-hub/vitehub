import { defineForm } from "@vite-hub/forms"
import { guardRequest /* request checks */, type GuardRequestOptions } from "@vite-hub/forms/guard"
import { encodeRouteSegment, getRuntimeContext, toResponse } from "vite-hub/runtime"
import { refreshRealtimeDocument } from "vite-hub/realtime/server"
import { RealtimeDocumentConflict // conflict handling
 } from "vite-hub/realtime"
import { useWorkspace } from "vite-hub/workspace"
import { normalizeSafeWorkspacePath } from "vite-hub/workspace/files"
import { resolveRegisteredWorkspaceDefinition } from "vite-hub/workspace/runtime"
import { invalidateWorkspaceStore } from "@vite-hub/workspace/runtime"
import { type WorkspaceStoreTarget } from "@vite-hub/workspace/files"
import { commentsErrorDiagnostics } from "vite-hub/comments/client"
import { defineComments } from "@vite-hub/comments"
import { commentsErrorDiagnostics as ownerDiagnostics } from "@vite-hub/comments/client"

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
