import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createClient } from "@libsql/client"
import { sql } from "drizzle-orm"
import { drizzle } from "drizzle-orm/libsql"
import { afterEach, describe, expect, it, vi } from "vitest"

import { createBlobStorage } from "../../blob/src/storage.ts"
import { createDriver } from "../../blob/src/drivers/fs.ts"
import { createViteHubDevToken, viteHubDevTokenHeader } from "@vite-hub/internal/dev-token"

import { createBlobDatabaseWorkspaceStore, workspaceHistorySchema } from "../src/blob-database.ts"
import { registerWorkspace, resetWorkspaceRegistry } from "../src/core/registry.ts"
import { runWorkspaceHistoryCli } from "../src/history-cli.ts"
import { workspaceHistoryDevHeader, workspaceHistoryDevHeaderValue, workspaceHistoryDevRuntimeRoute, workspaceHistoryDevTokenNamespace, workspaceHistoryDevTokenServerHeader } from "../src/history-dev.ts"
import { useWorkspace } from "../src/index.ts"
import { handleWorkspaceHistoryDevRequest } from "../src/runtime/history-dev.ts"

import type { WorkspaceDefinition } from "../src/core/types.ts"
import type { WorkspaceHistoryCommand } from "../src/history-cli.ts"

const cleanup: Array<() => Promise<void> | void> = []
const migration = await readFile(new URL("fixtures/history.sql", import.meta.url), "utf8")

afterEach(async () => {
  resetWorkspaceRegistry()
  vi.useRealTimers()
  for (const dispose of cleanup.splice(0).reverse()) await dispose()
})

function stream() {
  const chunks: Array<string | Uint8Array> = []
  return {
    bytes: () => Buffer.concat(chunks.map(chunk => Buffer.from(chunk))),
    output: () => chunks.map(chunk => Buffer.from(chunk).toString("utf8")).join(""),
    write(chunk: string | Uint8Array) {
      chunks.push(chunk)
      return true
    },
  }
}

async function tempRoot() {
  const root = await mkdtemp(join(tmpdir(), "vitehub-workspace-history-cli-"))
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
  return { definition, ids: { draft: draft.id, main: initial.id, published: published.id } }
}

/**
 * Calls the CLI through a fake Vite endpoint. Like the real endpoint, it forwards each POST with the guard header and the
 * token headers to the Nitro handler, which reads the registered Workspace.
 */
async function runCli(command: WorkspaceHistoryCommand, args: string[], definition: WorkspaceDefinition | undefined, discovery: Record<string, unknown> = { runtime: "nitro" }) {
  if (definition) registerWorkspace("content", { store: definition.store })
  const rootDir = await tempRoot()
  const { serverId } = await createViteHubDevToken(rootDir, workspaceHistoryDevTokenNamespace)
  const stdout = stream()
  const stderr = stream()
  const requests: unknown[] = []
  const fetchHistory = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    if (!init?.method || init.method === "GET") return Response.json({ root: rootDir, workspaceHistoryDevTokenServerId: serverId, ...discovery })
    const headers = new Headers(init.headers)
    requests.push(JSON.parse(String(init.body)))
    return await handleWorkspaceHistoryDevRequest(new Request(`http://localhost${workspaceHistoryDevRuntimeRoute}`, {
      body: String(init.body),
      headers: {
        "content-type": "application/json",
        [viteHubDevTokenHeader]: headers.get(viteHubDevTokenHeader) ?? "",
        [workspaceHistoryDevHeader]: headers.get(workspaceHistoryDevHeader) ?? "",
        [workspaceHistoryDevTokenServerHeader]: headers.get(workspaceHistoryDevTokenServerHeader) ?? "",
      },
      method: "POST",
    }), { rootDir, serverId })
  })
  const exitCode = await runWorkspaceHistoryCli(command, args, { cwd: rootDir, env: {}, rootDir, stderr, stdout }, { fetch: fetchHistory })
  return { exitCode, requests, stderr, stdout }
}

describe("workspace history CLI", { timeout: 30_000 }, () => {
  it("lists revisions across refs, newest first, with ref, author, message, and ISO time", async () => {
    const { definition, ids } = await retainedDefinition(await tempRoot())

    const { exitCode, stderr, stdout } = await runCli("history", ["content"], definition)

    expect(stderr.output()).toBe("")
    expect(exitCode).toBe(0)
    const lines = stdout.output().trimEnd().split("\n")
    expect(lines[0]).toMatch(/^REVISION\s+REF\s+CREATED AT\s+AUTHOR\s+FILES\s+MESSAGE$/)
    expect(lines.slice(1).map(line => line.split(/\s{2,}/))).toEqual([
      [ids.published, "published", "2026-10-15T09:10:00.000Z", "editor", "1", "Publish hello"],
      [ids.draft, "draft", "2026-10-15T09:05:00.000Z", "maxi", "2", "Save hello"],
      [ids.main, "main", "2026-10-15T09:00:00.000Z", "-", "1", "Start content"],
    ])
  })

  it("pages one ref with --ref, --limit, and --cursor", async () => {
    const { definition, ids } = await retainedDefinition(await tempRoot())
    const { history } = useWorkspace("content", { definition, mode: "write" })
    const second = await history.commit({ ref: "draft", ifHead: ids.draft!, changes: { delete: ["media/logo.bin"] }, message: "Remove logo" })

    const first = await runCli("history", ["content", "--ref", "draft", "--limit=1", "--json"], definition)
    const page = JSON.parse(first.stdout.output())
    expect(first.exitCode).toBe(0)
    expect(page).toMatchObject({ workspace: "content", ref: "draft", more: true, cursor: expect.any(String), revisions: [{ id: second.id, ref: "draft" }] })

    const text = await runCli("history", ["content", "--ref", "draft", "--limit", "1"], definition)
    expect(text.stdout.output()).toContain(`More revisions: vitehub workspace history content --ref draft --cursor ${page.cursor}`)

    const next = await runCli("history", ["content", "--ref", "draft", "--limit", "1", "--cursor", page.cursor, "--json"], definition)
    expect(JSON.parse(next.stdout.output())).toMatchObject({ more: false, revisions: [{ author: "maxi", id: ids.draft, message: "Save hello\n\nFirst draft." }] })
  })

  it("lists refs with their head revisions", async () => {
    const { definition, ids } = await retainedDefinition(await tempRoot())

    const text = await runCli("refs", ["content"], definition)
    expect(text.stdout.output().trimEnd().split("\n").slice(1).map(line => line.split(/\s{2,}/))).toEqual([
      ["draft", ids.draft, "2026-10-15T09:05:00.000Z", "maxi", "Save hello"],
      ["main", ids.main, "2026-10-15T09:00:00.000Z", "-", "Start content"],
      ["published", ids.published, "2026-10-15T09:10:00.000Z", "editor", "Publish hello"],
    ])

    const json = await runCli("refs", ["content", "--json"], definition)
    expect(JSON.parse(json.stdout.output())).toEqual({
      workspace: "content",
      refs: [
        { name: "draft", head: expect.objectContaining({ author: "maxi", id: ids.draft, parentId: null, ref: "draft" }) },
        { name: "main", head: expect.objectContaining({ id: ids.main, ref: "main" }) },
        { name: "published", head: expect.objectContaining({ author: "editor", id: ids.published, ref: "published" }) },
      ],
    })
  })

  it("shows a ref head or a revision id with its files and digests", async () => {
    const { definition, ids } = await retainedDefinition(await tempRoot())

    const byRef = await runCli("show", ["content", "draft"], definition)
    const byId = await runCli("show", ["content", ids.draft!], definition)

    expect(byRef.exitCode).toBe(0)
    expect(byId.stdout.output()).toBe(byRef.stdout.output())
    expect(byRef.stdout.output()).toContain([
      `Revision: ${ids.draft}`,
      "Ref: draft",
      "Parent: -",
      "Created at: 2026-10-15T09:05:00.000Z",
      "Author: maxi",
      "Message: Save hello\n\nFirst draft.",
      "Files: 2 (11 bytes)",
    ].join("\n"))
    expect(byRef.stdout.output()).toMatch(/PATH\s+SIZE\s+MEDIA TYPE\s+DIGEST\nmedia\/logo\.bin\s+3\s+application\/octet-stream\s+[0-9a-f]{64}\nposts\/hello\.md\s+8\s+text\/markdown\s+[0-9a-f]{64}\n$/)
  })

  it("prints one file as it was in a revision", async () => {
    const { definition } = await retainedDefinition(await tempRoot())

    const text = await runCli("show", ["content", "draft", "posts/hello.md"], definition)
    expect(text.stdout.output()).toBe("# Hello\n")

    const binary = await runCli("show", ["content", "draft", "media/logo.bin"], definition)
    expect([...binary.stdout.bytes()]).toEqual([0, 255, 1])

    const json = await runCli("show", ["content", "draft", "media/logo.bin", "--json"], definition)
    expect(JSON.parse(json.stdout.output())).toMatchObject({
      path: "media/logo.bin",
      file: { content: "AP8B", digest: expect.stringMatching(/^[0-9a-f]{64}$/), encoding: "base64", mediaType: "application/octet-stream", path: "media/logo.bin", size: 3 },
    })

    const directory = await runCli("show", ["content", "draft", "posts"], definition)
    expect(directory.stdout.output()).toContain("Path: posts\n")
    expect(directory.stdout.output()).not.toContain("media/logo.bin")
  })

  it("reports a missing ref, revision, or path", async () => {
    const { definition, ids } = await retainedDefinition(await tempRoot())

    const target = await runCli("show", ["content", "missing"], definition)
    expect(target.exitCode).toBe(1)
    expect(target.stderr.output()).toBe("Workspace \"content\" has no ref or revision \"missing\". Run `vitehub workspace refs content` to list refs.\n")

    const path = await runCli("show", ["content", "main", "posts/hello.md", "--json"], definition)
    expect(path.exitCode).toBe(1)
    expect(JSON.parse(path.stdout.output())).toEqual({ error: { code: "WORKSPACE_NOT_FOUND", message: `Revision ${ids.main} has no path "posts/hello.md".` } })
  })

  it("names the Blob + Database Store when the Workspace Store keeps no history", async () => {
    const definition: WorkspaceDefinition = { name: "content", store: { provider: "memory" } }

    for (const command of ["history", "refs"] as const) {
      const { exitCode, stderr, stdout } = await runCli(command, ["content"], definition)
      expect(exitCode).toBe(1)
      expect(stdout.output()).toBe("")
      expect(stderr.output()).toBe("Workspace \"content\" has no retained history because its Store does not keep revisions. Use the Blob + Database Store, createBlobDatabaseWorkspaceStore() from @vite-hub/workspace/blob-database, to keep refs and revisions.\n")
    }
    const json = await runCli("show", ["content", "main", "--json"], definition)
    expect(JSON.parse(json.stdout.output())).toMatchObject({ error: { code: "WORKSPACE_R0069", message: expect.stringContaining("Blob + Database Store") } })
  })

  it("rejects invalid arguments before it calls the dev server", async () => {
    const cases: Array<[WorkspaceHistoryCommand, string[], string]> = [
      ["history", [], "Missing Workspace name."],
      ["history", ["content", "--cursor", "abc"], "--cursor requires --ref."],
      ["history", ["content", "--limit", "101"], "--limit must be an integer from 1 to 100."],
      ["history", ["content", "--ref"], "Missing value for --ref."],
      ["refs", ["content", "--ref", "main"], "Unknown option: --ref."],
      ["refs", ["content", "extra"], "Unexpected argument: extra."],
      ["show", ["content"], "Missing ref or revision."],
    ]
    for (const [command, args, message] of cases) {
      const { exitCode, requests, stderr } = await runCli(command, args, undefined)
      expect(exitCode).toBe(1)
      expect(requests).toEqual([])
      expect(stderr.output()).toContain(`${message}\nUsage: vitehub workspace ${command} <workspace>`)
    }
  })

  it("rejects a Workspace that the runtime does not register", async () => {
    const { exitCode, stderr } = await runCli("refs", ["docs"], undefined)

    expect(exitCode).toBe(1)
    expect(stderr.output()).toBe("Unknown Workspace: docs.\n")
  })

  it("explains when the dev server cannot reach the Nitro runtime", async () => {
    const { exitCode, requests, stdout } = await runCli("refs", ["content", "--json"], undefined, { message: "No Nitro here.", runtime: "unavailable" })

    expect(exitCode).toBe(1)
    expect(requests).toEqual([])
    expect(JSON.parse(stdout.output())).toEqual({ error: { code: "WORKSPACE_HISTORY_DEV_RUNTIME_UNAVAILABLE", message: "No Nitro here." } })
  })

  it("rejects a runtime request without the private token", async () => {
    const rootDir = await tempRoot()
    const { serverId } = await createViteHubDevToken(rootDir, workspaceHistoryDevTokenNamespace)
    const response = await handleWorkspaceHistoryDevRequest(new Request(`http://localhost${workspaceHistoryDevRuntimeRoute}`, {
      body: JSON.stringify({ operation: "refs", workspace: "content" }),
      headers: {
        "content-type": "application/json",
        [viteHubDevTokenHeader]: "wrong",
        [workspaceHistoryDevHeader]: workspaceHistoryDevHeaderValue,
        [workspaceHistoryDevTokenServerHeader]: serverId,
      },
      method: "POST",
    }), { rootDir, serverId })

    expect(response.status).toBe(403)
    await expect(response.text()).resolves.toBe("Forbidden Workspace History token.")
  })
})
