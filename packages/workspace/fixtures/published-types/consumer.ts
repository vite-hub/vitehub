import { ViteHubError, type ViteHubErrorShape } from "@vite-hub/runtime"
import { queryWorkspaceCollection, type WorkspaceCollectionPage } from "@vite-hub/workspace/collections"
import { useWorkspaceCollection, type WorkspaceCollectionRequester } from "@vite-hub/workspace/collections/client"

import type { WorkspaceErrorCode } from "@vite-hub/workspace"
import { useWorkspace } from "@vite-hub/workspace"
import { createBlobDatabaseWorkspaceStore, workspaceHistorySchema } from "@vite-hub/workspace/blob-database"
import type { BlobStorage } from "@vite-hub/blob"
import type { Database } from "@vite-hub/database"

declare const blob: BlobStorage
declare const database: Database<typeof workspaceHistorySchema>
const store = createBlobDatabaseWorkspaceStore({ blob, database, workspace: "published-types" })
const workspace = useWorkspace("published-types", { mode: "write", definition: { name: "published-types", store } })
const revision = await workspace.history.commit({ ifHead: null, files: { "a.txt": "text" } })
const version = await workspace.history.open(revision.id)
await version.readFile("a.txt") satisfies string
await version.readFile("a.txt", { encoding: "binary" }) satisfies Uint8Array
useWorkspace("published-types").history.head() satisfies Promise<import("@vite-hub/workspace").WorkspaceRevision | null>
// @ts-expect-error Read mode cannot publish a revision.
useWorkspace("published-types").history.commit({ ifHead: null, files: {} })
// @ts-expect-error A revision view cannot change historical bytes.
version.writeFile("a.txt", "changed")
// @ts-expect-error Publication requires an expected head.
workspace.history.commit({ files: {} })

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
