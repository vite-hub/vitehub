import { useWorkspace } from "@vite-hub/workspace"
import { getConsoleInvocations } from "./invocations.ts"
import { assertConsoleRequest, consoleRequestURL } from "./request.ts"
import type { ConsoleRequestEvent } from "./request.ts"

type WorkspaceListing = { paths: string[], repository: string, revision: string, live: true }
type WorkspaceFile = { content: string, path: string, revision: string, size: number }

function httpError(message: string, statusCode: number, cause?: unknown): Error & { statusCode: number } {
  return Object.assign(new Error(message, cause === undefined ? undefined : { cause }), { statusCode })
}

function isSafeWorkspacePath(path: string): boolean {
  return !path.startsWith("/")
    && !path.includes("\\")
    && !path.includes("\0")
    && path.split("/").every(part => part !== "" && part !== "." && part !== "..")
}

// Persistent sources are live, not an immutable snapshot of an old invocation.
export default async function workspaceHandler(event: ConsoleRequestEvent): Promise<WorkspaceListing | WorkspaceFile> {
  assertConsoleRequest(event)
  const id = event.context?.params?.id
  const invocation = id ? await getConsoleInvocations().get(id) : undefined
  if (!invocation) throw httpError("Invocation not found", 404)
  if (!invocation.agentName) throw httpError("Invocation has no agent workspace", 404)
  const path = consoleRequestURL(event).searchParams.get("path")
  if (path && !isSafeWorkspacePath(path)) throw httpError("Invalid workspace path", 400)

  const workspace = useWorkspace(invocation.agentName, { mode: "read", refresh: false })
  let entries: Awaited<ReturnType<typeof workspace.fs.list>>
  try {
    entries = await workspace.fs.list("", { recursive: true })
  }
  catch (error) {
    throw httpError(`Workspace is unavailable for agent "${invocation.agentName}"`, 503, error)
  }
  const paths = entries
    .filter(entry => entry.type === "file" && isSafeWorkspacePath(entry.path))
    .map(entry => entry.path)
    .sort()
  if (!path) return { paths, repository: invocation.agentName, revision: "live", live: true }
  if (!paths.includes(path)) throw httpError("Workspace file not found", 404)
  const entry = entries.find(entry => entry.path === path)
  if ((entry?.size ?? 0) > 2 * 1024 * 1024) throw httpError("File is too large to preview", 413)
  let content: string
  try {
    content = await workspace.fs.readFile(path)
  }
  catch (error) {
    throw httpError("Workspace file could not be read", 404, error)
  }
  return { content, path, revision: "live", size: new TextEncoder().encode(content).length }
}
