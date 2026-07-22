import { ViteHubError, type ViteHubErrorShape } from "@vite-hub/runtime"
import { queryWorkspaceCollection, type WorkspaceCollectionPage } from "@vite-hub/workspace/collections"
import { useWorkspaceCollection, type WorkspaceCollectionRequester } from "@vite-hub/workspace/collections/client"

import type { WorkspaceErrorCode } from "@vite-hub/workspace"

const missing = new ViteHubError<"WORKSPACE_NOT_FOUND", { name: string }>(
  "WORKSPACE_NOT_FOUND",
  "Workspace is not registered.",
  { details: { name: "documents" } },
)
missing.code satisfies WorkspaceErrorCode
missing.toJSON() satisfies ViteHubErrorShape<"WORKSPACE_NOT_FOUND", { name: string }>

queryWorkspaceCollection({ path: "data/articles.json", workspace: "published-types" }) satisfies Promise<WorkspaceCollectionPage>
declare const request: WorkspaceCollectionRequester
useWorkspaceCollection<{ slug: string }>("/api/articles", { immediate: false, request }).items.value satisfies Array<{ slug: string }>
