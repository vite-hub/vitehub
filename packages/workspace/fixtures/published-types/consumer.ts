import { ViteHubError, type ViteHubErrorShape } from "@vite-hub/runtime"
import { defineCollection, type CollectionPage } from "@vite-hub/source"

import type { WorkspaceErrorCode } from "@vite-hub/workspace"
import { registerWorkspacePlugin, useWorkspace, workspaceFile } from "@vite-hub/workspace"
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
const draft = await workspace.history.commit({ ref: "draft", ifHead: null, changes: { put: { "posts/a.md": { content: "---\n---\n", metadata: { title: "A" } } }, delete: ["old.md"] } })
draft.ref satisfies string
await workspace.history.head({ ref: "draft" }) satisfies import("@vite-hub/workspace").WorkspaceRevision | null
await workspace.history.refs() satisfies import("@vite-hub/workspace").WorkspaceHistoryRef[]
// @ts-expect-error A commit takes either a complete file set or changes.
workspace.history.commit({ ifHead: null, files: {}, changes: {} })

registerWorkspacePlugin("published-types", { id: "content", hooks: { "write:validate": () => {} } }) satisfies () => void

const missing = new ViteHubError<"WORKSPACE_NOT_FOUND", { name: string }>(
  "WORKSPACE_NOT_FOUND",
  "Workspace is not registered.",
  { details: { name: "documents" } },
)
missing.code satisfies WorkspaceErrorCode
missing.toJSON() satisfies ViteHubErrorShape<"WORKSPACE_NOT_FOUND", { name: string }>

const articles = defineCollection({
  source: workspaceFile({ filters: ["category"], path: "data/articles.json", workspace: "published-types" }),
  transform: article => ({ slug: String(article.slug) }),
})
articles.page({ query: { category: ["guide"] } }) satisfies Promise<CollectionPage<{ slug: string }>>
// @ts-expect-error Only declared filters reach the Collection query.
articles.page({ query: { secret: ["one"] } })
