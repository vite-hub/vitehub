import { agentHostWorkspaceRoute, getAgentHostWorkspaceInspector } from "@vite-hub/agent/server"
import { useWorkspace } from "@vite-hub/workspace/runtime"
import * as v from "valibot"
import { getConsoleAgentDefinition } from "./agents.ts"
import { getConsoleInvocations } from "./invocations.ts"
import { assertConsoleRequest, consoleRequestURL } from "./request.ts"
import { viteHubErrorDiagnostics } from "../../../error-diagnostics.ts"
import type { ConsoleRequestEvent } from "./request.ts"

const configurationSchema = v.object({ workspace: v.object({ name: v.string() }) })
const hostWorkspaceSchema = v.union([
  v.object({ paths: v.array(v.string()), repository: v.string(), revision: v.string() }),
  v.object({ content: v.string(), path: v.string(), provenance: v.optional(v.object({ source: v.string() })), revision: v.string(), size: v.number() }),
])
const maxFileBytes = 512 * 1024

function failure(statusCode: number, message: string): Error {
  return Object.assign(viteHubErrorDiagnostics.VITE_HUB_C0001({ message }), { statusCode, statusMessage: message })
}

function visiblePath(path: string): boolean {
  return Boolean(path) && !path.startsWith("/") && !path.includes("\\")
    && !path.split("/").some(part => !part || part === ".." || part === "." || /^(?:\.git|\.ssh|\.env(?:\..*)?|auth\.json|credentials(?:\..*)?)$/i.test(part))
}

export default async function consoleInvocationWorkspaceHandler(event: ConsoleRequestEvent): Promise<{ paths: string[], repository: string, revision: string } | { content: string, path: string, provenance?: { source: string }, revision: string, size: number }> {
  assertConsoleRequest(event)
  const id = event.context?.params?.id ?? ""
  const path = consoleRequestURL(event).searchParams.get("path")
  const inspect = getAgentHostWorkspaceInspector(agentHostWorkspaceRoute)
  if (inspect) {
    const response = await inspect(id, path ?? undefined)
    if (!response.ok) throw failure(response.status, await response.text())
    return v.parse(hostWorkspaceSchema, await response.json())
  }
  const invocation = await getConsoleInvocations().get(id)
  if (!invocation) throw failure(404, "Invocation not found.")
  const agent = invocation.agentName && getConsoleAgentDefinition(invocation.agentName, "inspect")
  if (!agent || !agent.workspace) throw failure(404, "This Agent has no mounted Workspace available on this host.")
  const configuration = invocation.observations.map(entry => v.safeParse(configurationSchema, entry.attributes?.["vitehub.agent.configuration"]))
    .find(result => result.success)
  if (!configuration?.success) throw failure(404, "This run did not record its Workspace. Open a newer run to inspect its mounted files.")
  const name = configuration.output.workspace.name
  const workspace = useWorkspace(name, { mode: "read", refresh: false })
  // These are the mounted files now, not a retained snapshot of the invocation.
  const revision = "current"
  if (path !== null) {
    if (!visiblePath(path)) throw failure(400, "Choose a visible file inside this Workspace.")
    const stat = await workspace.fs.stat(path)
    if (!stat) throw failure(404, "This file is not in the mounted Workspace.")
    if (stat.type !== "file") throw failure(400, "Choose a file to preview.")
    if (stat.size !== undefined && stat.size > maxFileBytes) throw failure(413, "This file is too large to preview. The Console limit is 512 KiB.")
    const content = await workspace.fs.readFile(path, { encoding: "utf8" })
    const size = new TextEncoder().encode(content).byteLength
    if (size > maxFileBytes) throw failure(413, "This file is too large to preview. The Console limit is 512 KiB.")
    if (content.includes("\0")) throw failure(415, "Binary files cannot be previewed as text.")
    const promoted = stat.metadata?.promotedSourceSkill
    const source = promoted && typeof promoted === "object" && "source" in promoted && typeof promoted.source === "string"
      && /^[A-Za-z0-9._-]{1,100}$/.test(promoted.source) ? promoted.source : undefined
    return { content, path, ...(source ? { provenance: { source } } : {}), revision, size }
  }
  const entries = await workspace.fs.glob("**/*")
  const paths = entries.filter(entry => entry.type === "file" && visiblePath(entry.path)).map(entry => entry.path).sort()
  return { paths, repository: name, revision }
}
