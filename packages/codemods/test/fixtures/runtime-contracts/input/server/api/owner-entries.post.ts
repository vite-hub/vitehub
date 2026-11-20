import { guardRequest, type GuardRequestOptions } from "@vite-hub/forms"
import { defineForm } from "@vite-hub/forms"
import { encodeRouteSegment, getRuntimeContext } from "vite-hub/runtime"
import { RealtimeDocumentConflict, refreshRealtimeDocument } from "vite-hub/realtime/server"
import { normalizeSafeWorkspacePath, resolveRegisteredWorkspaceDefinition, useWorkspace } from "vite-hub/workspace"

const options: GuardRequestOptions = { key: "votes" }

export default {
  async fetch(request: Request) {
    const [stopped] = await guardRequest(request, options)
    if (stopped) return stopped
    const path = normalizeSafeWorkspacePath("posts/a.md")
    await resolveRegisteredWorkspaceDefinition("docs")
    await useWorkspace("docs").readFile(path)
    await refreshRealtimeDocument("docs", encodeRouteSegment(path))
    void defineForm, getRuntimeContext, RealtimeDocumentConflict
    return new Response("ok")
  },
}
