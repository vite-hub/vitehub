import { runWorkspaceRequest } from "../core/request-scope.ts"

/** Nitro middleware: runs the rest of the request in its own Workspace request scope. */
export default function workspaceRequestMiddleware(_event: unknown, next: () => unknown): Promise<unknown> {
  return runWorkspaceRequest(next)
}
