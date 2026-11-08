import { useWorkspaceFiles, type ReadonlyWorkspaceFiles } from "@vite-hub/workspace/files"
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

/** The ref that other refs are compared with. */
const baseRef = "main"

/**
 * Reads one Workspace for the Workspaces section: the head of a ref, or a given revision, with `main` as the base of
 * its changes. A Workspace without retained history shows its mounted files.
 */
async function consoleWorkspaceFilesHandler(event: ConsoleRequestEvent): Promise<WorkspaceDescriptor | WorkspaceFileResponse> {
  assertConsoleRequest(event)
  const url = consoleRequestURL(event)
  const name = stringValue(url.searchParams.get("name"))?.trim()
  if (!name) throw failure(400, "Choose a Workspace.")
  const path = url.searchParams.get("path")
  const ref = stringValue(url.searchParams.get("ref")) || undefined
  const revision = stringValue(url.searchParams.get("revision")) || undefined
  let workspace: ReadonlyWorkspaceFiles<string>
  try {
    workspace = useWorkspaceFiles(name, { mode: "read", refresh: false })
  }
  catch {
    throw failure(404, `This app defines no Workspace named "${name}".`)
  }
  if (revision === "current") return await readMountedWorkspace(workspace, name, path)
  const history = historyReader(workspace)
  if (!history) return await readMountedWorkspace(workspace, name, path)
  const cursor = url.searchParams.get("cursor") ?? undefined
  if (revision) return await readWorkspaceRevision(history, { base: baseRef, cursor, path, ref, repository: name, revision })
  const page = await historyMetadata(history, ref, cursor, Boolean(ref || cursor))
  const head = page?.refs.find(item => item.name === page.ref)?.head.id
  if (!head) return await readMountedWorkspace(workspace, name, path, page)
  return await readWorkspaceRevision(history, {
    base: baseRef,
    ...(page ? { history: page } : {}),
    path,
    ...(page?.ref ? { ref: page.ref } : {}),
    repository: name,
    revision: head,
  })
}

const guardedHandler: ConsoleAccessRoute<typeof consoleWorkspaceFilesHandler> = withConsoleAccess(consoleWorkspaceFilesHandler, { section: "workspaces" })
export default guardedHandler
