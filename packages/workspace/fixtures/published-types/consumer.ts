import { ViteHubError, type ViteHubErrorShape } from "@vite-hub/runtime"
import { WorkspaceNotFoundError, WorkspacePathError } from "@vite-hub/workspace"

const missing = new WorkspaceNotFoundError("documents")
missing.code satisfies "WORKSPACE_NOT_FOUND"
missing.details satisfies { name: string } | undefined
missing.toJSON() satisfies ViteHubErrorShape<"WORKSPACE_NOT_FOUND", { name: string }>
missing satisfies ViteHubError<"WORKSPACE_NOT_FOUND", { name: string }>
// @ts-expect-error WorkspaceNotFoundError details do not expose arbitrary keys.
missing.details?.token

const invalidPath = new WorkspacePathError("../secrets")
invalidPath.code satisfies "WORKSPACE_PATH_INVALID"
invalidPath.details satisfies { reason: "absolute" | "empty" | "invalid" | "reserved" | "traversal" } | undefined
invalidPath.toJSON() satisfies ViteHubErrorShape<"WORKSPACE_PATH_INVALID", { reason: "absolute" | "empty" | "invalid" | "reserved" | "traversal" }>
// @ts-expect-error WorkspacePathError details expose a bounded reason instead of the raw path.
invalidPath.details.path
