import { ViteHubError, type ViteHubErrorShape } from "@vite-hub/runtime"
import { WorkspaceNotFoundError, WorkspacePathError } from "@vite-hub/workspace"

const missing = new WorkspaceNotFoundError("documents")
missing.code satisfies "WORKSPACE_NOT_FOUND"
missing.details satisfies { name: string } | undefined
missing.toJSON() satisfies ViteHubErrorShape<"WORKSPACE_NOT_FOUND", { name: string }>
missing satisfies ViteHubError<"WORKSPACE_NOT_FOUND", { name: string }>

const invalidPath = new WorkspacePathError("../secrets")
invalidPath.code satisfies "WORKSPACE_PATH_INVALID"
invalidPath.details satisfies { path: string } | undefined
invalidPath.toJSON() satisfies ViteHubErrorShape<"WORKSPACE_PATH_INVALID", { path: string }>
