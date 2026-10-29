import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createClient } from "@libsql/client"
import { sql } from "drizzle-orm"
import { drizzle } from "drizzle-orm/libsql"
import { afterEach, describe, expect, it, vi } from "vitest"

import { createOperationRegistry, operationCliPath, runOperation } from "@vite-hub/internal/operations"

import { createBlobStorage } from "../../blob/src/storage.ts"
import { createDriver } from "../../blob/src/drivers/fs.ts"

import { createBlobDatabaseWorkspaceStore, workspaceHistorySchema } from "../src/blob-database.ts"
import { registerWorkspace, resetWorkspaceRegistry } from "../src/core/registry.ts"
import { useWorkspace } from "../src/index.ts"
import { workspaceOperations } from "../src/operations.ts"

import type { OperationContext } from "@vite-hub/internal/operations"
import type { WorkspaceDefinition } from "../src/core/types.ts"

const cleanup: Array<() => Promise<void> | void> = []
const migration = await readFile(new URL("fixtures/history.sql", import.meta.url), "utf8")
const registry = createOperationRegistry([{ operations: workspaceOperations }])

afterEach(async () => {
  resetWorkspaceRegistry()
  vi.useRealTimers()
  for (const dispose of cleanup.splice(0).reverse()) await dispose()
})

function context(sections: OperationContext["access"]["sections"] = "all"): OperationContext {
  return { access: { mode: "local", sections }, surface: "cli", user: null }
}

async function call(name: string, input: unknown, access?: OperationContext["access"]["sections"]) {
  return await runOperation(registry, `workspace.${name}`, input, context(access))
}

async function tempRoot() {
  const root = await mkdtemp(join(tmpdir(), "vitehub-workspace-operations-"))
  cleanup.push(() => rm(root, { force: true, recursive: true }))
  return root
}

/** A Blob + Database Store with commits on `main`, `draft`, and `published` at fixed times. */
async function retainedDefinition(root: string): Promise<{ definition: WorkspaceDefinition, ids: Record<string, string> }> {
  const client = createClient({ url: `file:${join(root, "history.sqlite")}` })
  cleanup.push(() => client.close())
  const database = drizzle(client, { schema: workspaceHistorySchema })
  for (const statement of migration.split(";").filter(statement => statement.trim())) await database.run(sql.raw(statement))
  const blob = createBlobStorage(createDriver({ driver: "fs", base: join(root, "objects") }))
  const definition: WorkspaceDefinition = { name: "content", store: createBlobDatabaseWorkspaceStore({ blob, database, workspace: "content" }) }
  const { history } = useWorkspace("content", { definition, mode: "write" })
  vi.useFakeTimers({ toFake: ["Date"] })
  vi.setSystemTime(new Date("2026-10-15T09:00:00.000Z"))
  const initial = await history.commit({ ifHead: null, files: { "README.md": "# Content\n" }, message: "Start content" })
  vi.setSystemTime(new Date("2026-10-15T09:05:00.000Z"))
  const draft = await history.commit({
    ref: "draft",
    ifHead: null,
    changes: { put: { "posts/hello.md": "# Hello\n", "media/logo.bin": new Uint8Array([0, 255, 1]) } },
    message: "Save hello\n\nFirst draft.",
    metadata: { author: "maxi" },
  })
  vi.setSystemTime(new Date("2026-10-15T09:10:00.000Z"))
  const published = await history.commit({
    ref: "published",
    ifHead: null,
    changes: { put: { "posts/hello.md": "# Hello\n" } },
    message: "Publish hello",
    metadata: { author: "editor" },
  })
  vi.useRealTimers()
  registerWorkspace("content", { store: definition.store })
  return { definition, ids: { draft: draft.id, main: initial.id, published: published.id } }
}

function format(name: string, value: unknown): string {
  const operation = registry.get(`workspace.${name}`)!
  return (operation.cli!.format as (output: unknown) => string)(value)
}

describe("workspace operations", { timeout: 30_000 }, () => {
  it("is the vitehub workspace history, refs, and show commands over the workspaces section", () => {
    expect(workspaceOperations.map(operation => [operation.name, operation.kind, operation.section, operationCliPath(operation)])).toEqual([
      ["workspace.history", "read", "workspaces", { command: "history", namespace: "workspace" }],
      ["workspace.refs", "read", "workspaces", { command: "refs", namespace: "workspace" }],
      ["workspace.show", "read", "workspaces", { command: "show", namespace: "workspace" }],
    ])
  })

  it("lists revisions across refs, newest first, with ref, author, message, and ISO time", async () => {
    const { ids } = await retainedDefinition(await tempRoot())

    const result = await call("history", { workspace: "content" })

    expect(result).toMatchObject({ ok: true, value: { more: false, workspace: "content" } })
    const lines = format("history", (result as { value: unknown }).value).trimEnd().split("\n")
    expect(lines[0]).toMatch(/^REVISION\s+REF\s+CREATED AT\s+AUTHOR\s+FILES\s+MESSAGE$/)
    expect(lines.slice(1).map(line => line.split(/\s{2,}/))).toEqual([
      [ids.published, "published", "2026-10-15T09:10:00.000Z", "editor", "1", "Publish hello"],
      [ids.draft, "draft", "2026-10-15T09:05:00.000Z", "maxi", "2", "Save hello"],
      [ids.main, "main", "2026-10-15T09:00:00.000Z", "-", "1", "Start content"],
    ])
  })

  it("pages one ref with ref, limit, and cursor", async () => {
    const { definition, ids } = await retainedDefinition(await tempRoot())
    const { history } = useWorkspace("content", { definition, mode: "write" })
    const second = await history.commit({ ref: "draft", ifHead: ids.draft!, changes: { delete: ["media/logo.bin"] }, message: "Remove logo" })

    const first = await call("history", { limit: 1, ref: "draft", workspace: "content" })
    expect(first).toMatchObject({ ok: true, value: { more: true, ref: "draft", revisions: [{ id: second.id, ref: "draft" }], workspace: "content" } })
    const page = (first as { value: { cursor: string } }).value
    expect(format("history", page)).toContain(`More revisions: vitehub workspace history content --ref draft --cursor ${page.cursor}`)

    const next = await call("history", { cursor: page.cursor, limit: 1, ref: "draft", workspace: "content" })
    expect(next).toMatchObject({ ok: true, value: { more: false, revisions: [{ author: "maxi", id: ids.draft, message: "Save hello\n\nFirst draft." }] } })
  })

  it("lists refs with their head revisions", async () => {
    const { ids } = await retainedDefinition(await tempRoot())

    const result = await call("refs", { workspace: "content" })

    expect(result).toEqual({
      ok: true,
      value: {
        workspace: "content",
        refs: [
          { name: "draft", head: expect.objectContaining({ author: "maxi", id: ids.draft, parentId: null, ref: "draft" }) },
          { name: "main", head: expect.objectContaining({ id: ids.main, ref: "main" }) },
          { name: "published", head: expect.objectContaining({ author: "editor", id: ids.published, ref: "published" }) },
        ],
      },
    })
    expect(format("refs", (result as { value: unknown }).value).trimEnd().split("\n").slice(1).map(line => line.split(/\s{2,}/))).toEqual([
      ["draft", ids.draft, "2026-10-15T09:05:00.000Z", "maxi", "Save hello"],
      ["main", ids.main, "2026-10-15T09:00:00.000Z", "-", "Start content"],
      ["published", ids.published, "2026-10-15T09:10:00.000Z", "editor", "Publish hello"],
    ])
  })

  it("shows a ref head or a revision id with its files and digests", async () => {
    const { ids } = await retainedDefinition(await tempRoot())

    const byRef = await call("show", { target: "draft", workspace: "content" })
    const byId = await call("show", { target: ids.draft, workspace: "content" })

    expect(byId).toEqual(byRef)
    const text = format("show", (byRef as { value: unknown }).value)
    expect(text).toContain([
      `Revision: ${ids.draft}`,
      "Ref: draft",
      "Parent: -",
      "Created at: 2026-10-15T09:05:00.000Z",
      "Author: maxi",
      "Message: Save hello\n\nFirst draft.",
      "Files: 2 (11 bytes)",
    ].join("\n"))
    expect(text).toMatch(/PATH\s+SIZE\s+MEDIA TYPE\s+DIGEST\nmedia\/logo\.bin\s+3\s+application\/octet-stream\s+[0-9a-f]{64}\nposts\/hello\.md\s+8\s+text\/markdown\s+[0-9a-f]{64}\n$/)
  })

  it("returns one file as it was in a revision, as text or base64", async () => {
    await retainedDefinition(await tempRoot())

    const text = await call("show", { path: "posts/hello.md", target: "draft", workspace: "content" })
    expect(format("show", (text as { value: unknown }).value)).toBe("# Hello\n")

    const binary = await call("show", { path: "media/logo.bin", target: "draft", workspace: "content" })
    expect(binary).toMatchObject({
      ok: true,
      value: {
        file: { content: "AP8B", digest: expect.stringMatching(/^[0-9a-f]{64}$/), encoding: "base64", mediaType: "application/octet-stream", path: "media/logo.bin", size: 3 },
        path: "media/logo.bin",
      },
    })
    expect(format("show", (binary as { value: unknown }).value)).toContain("--json")

    const directory = await call("show", { path: "posts", target: "draft", workspace: "content" })
    const listing = format("show", (directory as { value: unknown }).value)
    expect(listing).toContain("Path: posts\n")
    expect(listing).not.toContain("media/logo.bin")
  })

  it("reports a missing ref, revision, or path", async () => {
    const { ids } = await retainedDefinition(await tempRoot())

    expect(await call("show", { target: "missing", workspace: "content" })).toMatchObject({
      code: "WORKSPACE_NOT_FOUND",
      message: "Workspace \"content\" has no ref or revision \"missing\". Run `vitehub workspace refs content` to list refs.",
      ok: false,
      status: 404,
    })
    expect(await call("show", { path: "posts/hello.md", target: "main", workspace: "content" })).toMatchObject({
      code: "WORKSPACE_NOT_FOUND",
      message: `Revision ${ids.main} has no path "posts/hello.md".`,
      ok: false,
      status: 404,
    })
  })

  it("names the Blob + Database Store when the Workspace Store keeps no history", async () => {
    registerWorkspace("content", { store: { provider: "memory" } })

    for (const [name, input] of [["history", { workspace: "content" }], ["refs", { workspace: "content" }], ["show", { target: "main", workspace: "content" }]] as const) {
      expect(await call(name, input)).toMatchObject({ code: "WORKSPACE_R0069", message: expect.stringContaining("Blob + Database Store"), ok: false, status: 409 })
    }
  })

  it("rejects invalid input before it reads a Workspace", async () => {
    expect(await call("history", { limit: 101, workspace: "content" })).toMatchObject({ ok: false, status: 400 })
    expect(await call("history", { limit: 0, workspace: "content" })).toMatchObject({ ok: false, status: 400 })
    expect(await call("history", { workspace: "" })).toMatchObject({ ok: false, status: 400 })
    expect(await call("show", { workspace: "content" })).toMatchObject({ ok: false, status: 400 })
    expect(await call("history", { cursor: "abc", workspace: "content" })).toMatchObject({ code: "WORKSPACE_HISTORY_INVALID", message: "The cursor belongs to one ref. Pass the same ref.", ok: false, status: 400 })
  })

  it("rejects a Workspace that the runtime does not register", async () => {
    expect(await call("refs", { workspace: "docs" })).toMatchObject({ code: "WORKSPACE_NOT_FOUND", message: "Unknown Workspace: docs.", ok: false, status: 404 })
  })

  it("runs with read-only access to the section and refuses access to other sections", async () => {
    await retainedDefinition(await tempRoot())

    expect(await call("refs", { workspace: "content" }, ["workspaces:read"])).toMatchObject({ ok: true })
    expect(await call("refs", { workspace: "content" }, ["workspaces"])).toMatchObject({ ok: true })
    expect(await call("refs", { workspace: "content" }, ["kv"])).toMatchObject({ ok: false, status: 403 })
  })
})
