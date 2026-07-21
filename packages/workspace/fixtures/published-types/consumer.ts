import { ViteHubError, type ViteHubErrorShape } from "@vite-hub/runtime"
import { WorkspaceNotFoundError, WorkspacePathError } from "@vite-hub/workspace"
import { queryWorkspaceCollection, type WorkspaceCollectionPage } from "@vite-hub/workspace/collections"
import { useWorkspaceCollection, type WorkspaceCollectionRequester } from "@vite-hub/workspace/collections/client"

const missing = new WorkspaceNotFoundError("documents")
missing.code satisfies "WORKSPACE_NOT_FOUND"
missing.details satisfies { name: string } | undefined
missing.toJSON() satisfies ViteHubErrorShape<"WORKSPACE_NOT_FOUND", { name: string }>
missing satisfies ViteHubError<"WORKSPACE_NOT_FOUND", { name: string }>

const invalidPath = new WorkspacePathError("../secrets")
invalidPath.code satisfies "WORKSPACE_PATH_INVALID"
invalidPath.details satisfies { path: string } | undefined
invalidPath.toJSON() satisfies ViteHubErrorShape<"WORKSPACE_PATH_INVALID", { path: string }>

queryWorkspaceCollection({ path: "data/articles.json", workspace: "published-types" }) satisfies Promise<WorkspaceCollectionPage>
declare const request: WorkspaceCollectionRequester
useWorkspaceCollection<{ slug: string }>("/api/articles", { immediate: false, request }).items.value satisfies Array<{ slug: string }>
