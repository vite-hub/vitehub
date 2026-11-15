import { agentHostWorkspaceRoute, getAgentHostWorkspaceInspector } from "@vite-hub/agent/server"
import { useWorkspaceFiles } from "@vite-hub/workspace/files"
import * as v from "valibot"
import { getConsoleAgentDefinition } from "./agents.ts"
import { getConsoleInvocations } from "./invocations.ts"
import { withConsoleAccess, type ConsoleAccessRoute } from "./access.ts"
import { assertConsoleRequest, consoleRequestURL } from "./request.ts"
import {
  failure,
  historyMetadata,
  historyReader,
  readMountedWorkspace,
  readWorkspaceRevision,
  stringValue,
  type WorkspaceDescriptor,
  type WorkspaceFileResponse,
} from "./workspace-history.ts"
import type { ConsoleRequestEvent } from "./request.ts"

const configurationSchema = v.object({
  workspace: v.object({ name: v.string(), ref: v.optional(v.string()), revision: v.optional(v.string()) }),
})
const sourceLabelSchema = v.pipe(v.string(), v.minLength(1), v.check(value => !/\p{Cc}/u.test(value)))
const hostWorkspaceSchema = v.union([
  v.object({ paths: v.array(v.string()), repository: v.string(), revision: v.string() }),
  v.object({ content: v.string(), path: v.string(), provenance: v.optional(v.object({ source: sourceLabelSchema })), revision: v.string(), size: v.number() }),
])
/** The ref that a session's files are compared with. */
const baseRef = "main"

async function consoleInvocationWorkspaceHandler(event: ConsoleRequestEvent): Promise<WorkspaceDescriptor | WorkspaceFileResponse> {
  assertConsoleRequest(event)
  const id = event.context?.params?.id ?? ""
  const url = consoleRequestURL(event)
  const path = url.searchParams.get("path")
  const requestedRef = stringValue(url.searchParams.get("ref"))
  const requestedRevision = stringValue(url.searchParams.get("revision"))
  const historyRequested = url.searchParams.get("history") === "1"
  // A host that inspects Workspaces itself owns the snapshot of each invocation.
  const inspect = getAgentHostWorkspaceInspector(agentHostWorkspaceRoute)
  if (inspect && !requestedRevision && !historyRequested) {
    const response = await inspect(id, path ?? undefined)
    if (!response.ok) throw failure(response.status, await response.text())
    return v.parse(hostWorkspaceSchema, await response.json())
  }
  const invocation = await getConsoleInvocations().get(id)
  if (!invocation) throw failure(404, "Invocation not found.")
  const configuration = invocation.observations
    .slice().reverse()
    .map(entry => v.safeParse(configurationSchema, entry.attributes?.["vitehub.agent.configuration"]))
    .find(result => result.success)
  const recorded = configuration?.success ? configuration.output.workspace : undefined
  // A run that recorded the revision of its files opens that revision. The mounted files are only a fallback.
  const revisionId = requestedRevision ?? recorded?.revision
  if (!recorded) throw failure(404, "This run did not record its Workspace. Open a newer run to inspect its mounted files.")
  const name = recorded.name
  if (!revisionId) {
    const agent = invocation.agentName && getConsoleAgentDefinition(invocation.agentName, "inspect")
    if (!agent || !agent.workspace) throw failure(404, "This Agent has no mounted Workspace available on this host.")
  }
  const workspace = useWorkspaceFiles(name, { mode: "read", refresh: false })
  const history = historyReader(workspace)
  const ref = requestedRef ?? recorded.ref
  const cursor = url.searchParams.get("cursor") ?? undefined

  if (revisionId) {
    if (!history) throw failure(404, "This Workspace has no retained history.")
    return await readWorkspaceRevision(history, {
      base: baseRef,
      cursor,
      path,
      ...(ref ? { ref } : {}),
      repository: name,
      revision: revisionId,
    })
  }

  const historyPageValue = history && (path === null || historyRequested)
    ? await historyMetadata(history, ref, cursor, historyRequested)
    : undefined
  return await readMountedWorkspace(workspace, name, path, historyPageValue)
}


const guardedHandler: ConsoleAccessRoute<typeof consoleInvocationWorkspaceHandler> = withConsoleAccess(consoleInvocationWorkspaceHandler, { section: "agents" })
export default guardedHandler
