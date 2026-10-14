import { EventEmitter } from "node:events"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Readable, Writable } from "node:stream"
import { pathToFileURL } from "node:url"
import { createClient } from "@libsql/client"
import { sql } from "drizzle-orm"
import { drizzle } from "drizzle-orm/libsql"
import { afterEach, describe, expect, it, vi } from "vitest"
import { z } from "zod"

import { createBlobDatabaseWorkspaceStore, workspaceHistorySchema } from "@vite-hub/workspace/blob-database"
import { registerWorkspace } from "@vite-hub/workspace/test"

import { createBlobStorage } from "../../blob/src/storage.ts"
import { createDriver } from "../../blob/src/drivers/fs.ts"
import { createContentCliContributor, runContentCli } from "../src/cli.ts"
import { contentDevHeader, contentDevHeaderValue, contentDevRoute, contentDevRuntimeRoute } from "../src/dev.ts"
import { defineContent, documents } from "../src/index.ts"
import { handleContentDevRequest } from "../src/runtime/dev.ts"
import { contentDevRuntimeUnavailableMessage, hubContent } from "../src/vite.ts"

import type { IncomingMessage, ServerResponse } from "node:http"
import type { ContentCliOptions } from "../src/cli.ts"

const migration = await readFile(new URL("../../workspace/test/fixtures/history.sql", import.meta.url), "utf8")
const cleanup: Array<() => Promise<void> | void> = []
let workspaces = 0
const rootDir = "/app"

afterEach(async () => {
  vi.restoreAllMocks()
  for (const dispose of cleanup.splice(0).reverse()) await dispose()
})

async function tempDir(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  return root
}

/** A Workspace on the libSQL Blob + Database Store, as the document collection tests use. */
async function historyWorkspace(): Promise<string> {
  const root = await tempDir("vitehub-content-cli-")
  const client = createClient({ url: `file:${join(root, "history.sqlite")}` })
  cleanup.push(() => client.close())
  const database = drizzle(client, { schema: workspaceHistorySchema })
  for (const statement of migration.split(";").filter(statement => statement.trim())) await database.run(sql.raw(statement))
  const blob = createBlobStorage(createDriver({ driver: "fs", base: join(root, "objects") }))
  const workspace = `site-cli-${++workspaces}`
  registerWorkspace(workspace, { store: createBlobDatabaseWorkspaceStore({ blob, database, workspace }) })
  return workspace
}

function contentOn(workspace: string, title: z.ZodType = z.string().min(1)) {
  const content = defineContent({
    workspace,
    collections: {
      posts: documents({ path: "posts/**/*.md", fields: { title, tags: z.array(z.string()).default([]) } }),
      pages: documents({ path: "pages/*.md", fields: { title: z.string() } }),
    },
    logger: false,
  })
  cleanup.push(() => content.dispose())
  return content
}

async function setup() {
  const workspace = await historyWorkspace()
  const content = contentOn(workspace)
  return { content, pages: content.collection("pages"), posts: content.collection("posts"), workspace }
}

function stream() {
  let value = ""
  return {
    output: () => value,
    write(chunk: string | Uint8Array) {
      value += String(chunk)
      return true
    },
  }
}

/** A fake Vite + Nitro dev server: `GET` discovery, `POST` straight into the Nitro dev handler. */
function devServer(content: unknown) {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => init?.method === "POST"
    ? await handleContentDevRequest(new Request(input, init), content)
    : Response.json({ root: rootDir, runtime: "nitro" }))
}

function cli(content: unknown, options: ContentCliOptions = {}) {
  const fetch = devServer(content)
  const run = async (...args: string[]) => {
    const stdout = stream()
    const stderr = stream()
    const code = await runContentCli(args, { cwd: rootDir, env: {}, rootDir, stderr, stdout }, { fetch, ...options })
    return { code, stderr: stderr.output(), stdout: stdout.output() }
  }
  return { fetch, run }
}

const hello = { data: { title: "Hello", tags: ["vue"] }, body: "# Hello\n\nFirst post.\n" }

describe("vitehub content", { timeout: 30_000 }, () => {
  it("lists collections with fields and document states", async () => {
    const { content, posts } = await setup()
    await posts.save("hello", hello)
    await posts.save("second", { data: { title: "Second" } })
    await content.publish({ collection: "posts", ids: ["hello"] })
    const { run } = cli(content)

    expect(await run("collections")).toEqual({
      code: 0,
      stderr: "",
      stdout: [
        "posts  posts/**/*.md",
        "  Fields: title, tags",
        "  Documents: 2 (1 published, 1 draft)",
        "pages  pages/*.md",
        "  Fields: title",
        "  Documents: 0",
        "",
      ].join("\n"),
    })
    const json = await run("collections", "--json")
    expect(JSON.parse(json.stdout)).toEqual({
      collections: [
        { name: "posts", path: "posts/**/*.md", fields: ["title", "tags"], documents: 2, states: { draft: 1, published: 1, changed: 0, deleted: 0 } },
        { name: "pages", path: "pages/*.md", fields: ["title"], documents: 0, states: { draft: 0, published: 0, changed: 0, deleted: 0 } },
      ],
    })
  })

  it("reports draft, published, changed, and deleted documents", async () => {
    const { content, pages, posts } = await setup()
    await posts.save("hello", hello)
    await posts.save("old", { data: { title: "Old" } })
    await posts.save("2026/kept", { data: { title: "Kept" } })
    await pages.save("about", { data: { title: "About" } })
    await content.publish()
    await posts.save("hello", { ...hello, body: "# Hello\n\nEdited.\n" })
    await posts.remove("old")
    await posts.save("new", { data: { title: "New" } })
    const { run } = cli(content)

    expect(await run("status")).toEqual({
      code: 0,
      stderr: "",
      stdout: [
        "published  posts/2026/kept",
        "changed    posts/hello",
        "draft      posts/new",
        "deleted    posts/old",
        "published  pages/about",
        "",
      ].join("\n"),
    })
    expect((await run("status", "pages")).stdout).toBe("published  pages/about\n")
    const one = JSON.parse((await run("status", "posts", "hello", "--json")).stdout)
    expect(one).toEqual({ documents: [{ collection: "posts", id: "hello", state: "changed", draft: expect.any(String), published: expect.any(String) }] })
    expect(one.documents[0].draft).not.toBe(one.documents[0].published)

    const missing = await run("status", "posts", "nope", "--json")
    expect(missing.code).toBe(1)
    expect(JSON.parse(missing.stdout)).toMatchObject({ error: { code: "CONTENT_NOT_FOUND" } })
    const unknown = await run("status", "drafts")
    expect(unknown.code).toBe(1)
    expect(unknown.stderr).toContain("Unknown Content collection \"drafts\"")
  })

  it("prints a unified diff from published to draft", async () => {
    const { content, posts } = await setup()
    await posts.save("hello", hello)
    await content.publish()
    await posts.save("hello", { data: { title: "Hello again", tags: ["vue"] }, body: "# Hello\n\nEdited.\n" })
    await posts.save("fresh", { data: { title: "Fresh" }, body: "New." })
    const { run } = cli(content)

    const changed = await run("diff", "posts", "hello")
    expect(changed.code).toBe(0)
    expect(changed.stdout).toBe([
      "--- published/posts/hello.md",
      "+++ draft/posts/hello.md",
      "@@ -1,9 +1,9 @@",
      " ---",
      "-title: Hello",
      "+title: Hello again",
      " tags:",
      "   - vue",
      " ---",
      " ",
      " # Hello",
      " ",
      "-First post.",
      "+Edited.",
      "",
    ].join("\n"))

    const added = await run("diff", "posts", "fresh")
    expect(added.stdout).toContain("--- /dev/null\n+++ draft/posts/fresh.md\n")
    expect(added.stdout).toContain("+title: Fresh\n")

    const json = JSON.parse((await run("diff", "posts", "hello", "--json")).stdout)
    expect(json).toMatchObject({
      collection: "posts",
      id: "hello",
      path: "posts/hello.md",
      state: "changed",
      published: { digest: expect.any(String), text: expect.stringContaining("title: Hello\n") },
      draft: { digest: expect.any(String), text: expect.stringContaining("title: Hello again\n") },
      diff: changed.stdout,
    })

    await content.publish()
    expect(await run("diff", "posts", "hello")).toEqual({ code: 0, stderr: "No changes: posts/hello is published as drafted.\n", stdout: "" })
    const missing = await run("diff", "posts")
    expect(missing.code).toBe(1)
    expect(missing.stderr).toContain("Missing id.")
  })

  it("diffs documents whose frontmatter no longer validates", async () => {
    const { content, posts, workspace } = await setup()
    await posts.save("hello", hello)
    await content.publish()
    await posts.save("hello", { ...hello, data: { title: "Renamed", tags: [] } })
    await content.dispose()
    // The field changed after the documents were written, so get() rejects both versions.
    const drifted = contentOn(workspace, z.literal("Only this title"))
    await expect(drifted.collection("posts").get("hello", { ref: "draft" })).rejects.toMatchObject({ code: "CONTENT_INVALID" })

    const diff = await cli(drifted).run("diff", "posts", "hello")
    expect(diff.code).toBe(0)
    expect(diff.stdout).toContain("-title: Hello\n-tags:\n-  - vue\n+title: Renamed\n+tags: []\n")
  })

  it("lists the revisions of one document", async () => {
    const { content, posts } = await setup()
    await posts.save("hello", hello, { message: "Write hello" })
    await posts.save("hello", { ...hello, body: "Edited." }, { message: "Edit hello" })
    await content.publish({ message: "Ship hello" })
    const { run } = cli(content)

    const drafts = await run("revisions", "posts", "hello")
    expect(drafts.code).toBe(0)
    expect(drafts.stdout.trim().split("\n").map(line => line.split("  ").slice(2))).toEqual([["save", "Edit hello"], ["save", "Write hello"]])
    const published = JSON.parse((await run("revisions", "posts", "hello", "--ref", "published", "--json")).stdout)
    expect(published).toMatchObject({ collection: "posts", id: "hello", ref: "published", revisions: [{ ref: "published", message: "Ship hello", metadata: { content: { action: "publish" } } }] })

    const page = await run("revisions", "posts", "hello", "--limit", "1")
    expect(page.stdout.trim().split("\n")).toHaveLength(1)
    expect(page.stderr).toMatch(/Next page: --cursor \S+/)
    expect((await run("revisions", "posts", "hello", "--limit", "101")).code).toBe(1)
    expect((await run("revisions", "posts", "hello", "--ref", "main")).stderr).toContain("--ref must be draft or published.")
  })

  it("publishes only after confirmation and prints the new revision", async () => {
    const { content, pages, posts } = await setup()
    await posts.save("hello", hello)
    await pages.save("about", { data: { title: "About" } })

    const unconfirmed = await cli(content).run("publish", "--json")
    expect(unconfirmed.code).toBe(1)
    expect(JSON.parse(unconfirmed.stdout)).toMatchObject({ error: { code: "CONTENT_PUBLISH_UNCONFIRMED" } })
    expect(await posts.status("hello")).toMatchObject({ state: "draft" })

    const declined = await cli(content, { confirm: async () => false }).run("publish")
    expect(declined).toMatchObject({ code: 1, stdout: "" })
    expect(declined.stderr).toBe("Publish 2 documents:\n  add     posts/hello\n  add     pages/about\nPublish cancelled.\n")
    expect(await posts.status("hello")).toMatchObject({ state: "draft" })

    const dryRun = await cli(content).run("publish", "--collection", "posts", "--dry-run")
    expect(dryRun).toEqual({ code: 0, stderr: "", stdout: "Would publish 1 document:\n  add     posts/hello\n" })

    const confirm = vi.fn(async () => true)
    const confirmed = await cli(content, { confirm }).run("publish", "--collection", "posts", "--id", "hello", "--message", "Ship hello")
    expect(confirm).toHaveBeenCalledWith("Publish? [y/N] ")
    expect(confirmed.code).toBe(0)
    const [revision] = (await content.revisions("posts", "hello", { ref: "published" })).revisions
    expect(revision).toMatchObject({ message: "Ship hello" })
    expect(confirmed.stdout).toBe(`Published 1 document in revision ${revision!.id}:\n  add     posts/hello\n`)
    expect(await pages.status("about")).toMatchObject({ state: "draft" })

    const all = JSON.parse((await cli(content).run("publish", "--yes", "--json")).stdout)
    expect(all).toMatchObject({ dryRun: false, revision: { ref: "published", id: expect.any(String) }, documents: [{ collection: "pages", id: "about", change: "add" }] })

    expect(await cli(content).run("publish", "--yes")).toEqual({ code: 0, stderr: "Nothing to publish: every selected document is published as drafted.\n", stdout: "" })
    const byIdWithoutCollection = await cli(content).run("publish", "--id", "hello")
    expect(byIdWithoutCollection.code).toBe(1)
    expect(byIdWithoutCollection.stderr).toContain("--id requires --collection.")
    const missing = await cli(content).run("publish", "--collection", "posts", "--id", "nope", "--yes", "--json")
    expect(JSON.parse(missing.stdout)).toMatchObject({ error: { code: "CONTENT_NOT_FOUND" } })
  })

  it("explains when no Vite + Nitro Development Server is reachable", async () => {
    const run = async (fetch: typeof globalThis.fetch, ...args: string[]) => {
      const stdout = stream()
      const stderr = stream()
      const code = await runContentCli(args, { cwd: rootDir, env: {}, rootDir, stderr, stdout }, { fetch })
      return { code, stderr: stderr.output(), stdout: stdout.output() }
    }
    const offline = await run(vi.fn(async () => { throw new TypeError("fetch failed") }), "status")
    expect(offline.code).toBe(1)
    expect(offline.stderr).toContain("No Compatible Vite Development Server found at http://localhost:5173.")
    expect(offline.stderr).toContain("Nuxt, plain Vite, and deployed apps are not supported.")

    const unavailable = await run(vi.fn(async () => Response.json({ message: contentDevRuntimeUnavailableMessage, root: rootDir, runtime: "unavailable" })), "status", "--json")
    expect(JSON.parse(unavailable.stdout)).toEqual({ error: { code: "CONTENT_DEV_RUNTIME_UNAVAILABLE", message: contentDevRuntimeUnavailableMessage } })

    const undefinedContent = await cli(undefined).run("collections", "--json")
    expect(JSON.parse(undefinedContent.stdout)).toMatchObject({ error: { code: "CONTENT_UNDEFINED" } })
  })

  it("prints help and contributes the content namespace", async () => {
    const { run } = cli(undefined)
    const help = await run("publish", "--help")
    expect(help.code).toBe(0)
    expect(help.stdout).toContain("Usage: vitehub content publish [--collection <name>] [--id <id>...] [--message <text>] [--dry-run] [--yes] [--json] [--url <url>]")
    expect(help.stdout).toContain("It does not reach a deployed app.")
    expect((await run("nope")).stderr).toBe("Unknown content command: nope\nCommands: collections, status, diff, revisions, publish\n")
    const [namespace] = createContentCliContributor().namespaces
    expect(namespace?.name).toBe("content")
    expect(namespace?.features.map(feature => feature.name)).toEqual(["collections", "status", "diff", "revisions", "publish"])
  })
})

describe("Content dev handler", () => {
  it("rejects requests without the guard header, from another host, or with another method", async () => {
    const url = `http://localhost:5173${contentDevRuntimeRoute}`
    const json = { "content-type": "application/json" }
    expect((await handleContentDevRequest(new Request(url, { body: "{}", headers: json, method: "POST" }), undefined)).status).toBe(403)
    expect((await handleContentDevRequest(new Request(`http://attacker.test${contentDevRuntimeRoute}`, { body: "{}", headers: { ...json, [contentDevHeader]: contentDevHeaderValue }, method: "POST" }), undefined)).status).toBe(403)
    expect((await handleContentDevRequest(new Request(url, { headers: { [contentDevHeader]: contentDevHeaderValue } }), undefined)).status).toBe(405)
    const invalid = await handleContentDevRequest(new Request(url, { body: "{\"operation\":\"clear\"}", headers: { ...json, [contentDevHeader]: contentDevHeaderValue }, method: "POST" }), (await setup()).content)
    expect(invalid.status).toBe(400)
  })
})

/** Fake Vite dev server parts that the dev endpoint registration uses. */
function fakeServer() {
  const middlewares: Array<(req: IncomingMessage, res: ServerResponse, next: () => void) => void> = []
  return {
    middlewares,
    server: {
      config: { root: rootDir, server: {} },
      environments: {},
      middlewares: { use: (handler: (req: IncomingMessage, res: ServerResponse, next: () => void) => void) => middlewares.push(handler) },
      resolvedUrls: { local: ["http://localhost:5173/"] },
    },
  }
}

async function call(middleware: (req: IncomingMessage, res: ServerResponse, next: () => void) => void, init: { body?: string, headers?: Record<string, string>, method: string }) {
  const req = Object.assign(Readable.from(init.body ? [Buffer.from(init.body)] : []), {
    headers: { host: "localhost:5173", ...init.headers },
    method: init.method,
    url: contentDevRoute,
  }) as unknown as IncomingMessage
  const done = new EventEmitter()
  const chunks: Buffer[] = []
  const res = Object.assign(new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.from(chunk))
      callback()
    },
    final(callback) {
      done.emit("end")
      callback()
    },
  }), { setHeader() {}, statusCode: 200 })
  const ended = new Promise(resolve => done.once("end", resolve))
  middleware(req, res as unknown as ServerResponse, () => done.emit("end"))
  await ended
  return { body: Buffer.concat(chunks).toString("utf8"), status: res.statusCode }
}

describe("hubContent", () => {
  type ConfigHook = (config: Record<string, unknown>, env: { command: "build" | "serve", mode: string }) => Promise<void>

  function configHook(plugin: ReturnType<typeof hubContent>): ConfigHook {
    const hook = plugin.config
    const handler = hook && "handler" in hook ? hook.handler : hook
    // SAFETY: The test calls the concrete hook with the Vite config fields that it reads.
    return handler as unknown as ConfigHook
  }

  async function project(withContent: boolean): Promise<string> {
    const root = await tempDir("vitehub-content-vite-")
    await writeFile(join(root, "package.json"), "{}")
    await mkdir(join(root, "server"))
    if (withContent) await writeFile(join(root, "server", "content.ts"), "export const content = {}\n")
    return root
  }

  it("adds the Nitro dev handler for the Content Definition only in serve mode", async () => {
    const root = await project(true)
    const plugin = hubContent({ importBase: "vite-hub/_internal/content" })
    const build: Record<string, unknown> = { nitro: { handlers: [] }, root }
    await configHook(plugin)(build, { command: "build", mode: "production" })
    expect(build.nitro).toEqual({ handlers: [] })

    const serve: Record<string, unknown> = { nitro: { handlers: [] }, root }
    await configHook(plugin)(serve, { command: "serve", mode: "development" })
    const handler = join(root, ".vitehub/nitro/content/dev-handler.ts")
    expect(serve.nitro).toEqual({ handlers: [{ handler, route: contentDevRuntimeRoute }], plugins: [] })
    const source = await readFile(handler, "utf8")
    expect(source).toContain("import { handleContentDevRequest } from \"vite-hub/_internal/content/runtime/dev\"")
    expect(source).toContain(`import * as definition from ${JSON.stringify(pathToFileURL(join(root, "server", "content.ts")).href)}`)
    expect(source).toContain("handleContentDevRequest(event.req, definition.content)")
  })

  it("contributes the CLI namespace and the Content inspector only when the app defines Content", async () => {
    const withContent = hubContent()
    await configHook(withContent)({ root: await project(true) }, { command: "serve", mode: "development" })
    const contributor = await (withContent.vitehub.cli as () => Promise<{ namespaces: Array<{ name: string }> }>)()
    expect(contributor.namespaces.map(namespace => namespace.name)).toEqual(["content"])
    const inspection = await (withContent.vitehub.inspect as () => Promise<{ definitions: Array<{ kind: string, list: () => unknown }> }>)()
    expect(inspection.definitions.map(inspector => inspector.kind)).toEqual(["content"])
    expect(inspection.definitions[0]!.list()).toEqual([{
      fields: [{ label: "Route", value: "/api/content/**" }, { label: "Collections", value: "vitehub content collections" }],
      file: "server/content.ts",
      name: "content",
      source: "server-content",
    }])

    const without = hubContent()
    const root = await project(false)
    const serve: Record<string, unknown> = { nitro: { handlers: [] }, root }
    await configHook(without)(serve, { command: "serve", mode: "development" })
    expect(serve.nitro).toEqual({ handlers: [] })
    expect(await (without.vitehub.cli as () => Promise<unknown>)()).toBeUndefined()
    expect(await (without.vitehub.inspect as () => Promise<unknown>)()).toBeUndefined()
  })

  it("registers a guarded endpoint that reports hosts without an in-process Nitro environment", async () => {
    const { middlewares, server } = fakeServer()
    const plugin = hubContent()
    const configureServer = plugin.configureServer as unknown as (server: unknown) => void
    configureServer(server)
    expect((await call(middlewares[0]!, { method: "GET" })).status).toBe(403)
    const discovery = await call(middlewares[0]!, { headers: { [contentDevHeader]: contentDevHeaderValue }, method: "GET" })
    expect(JSON.parse(discovery.body)).toEqual({ message: contentDevRuntimeUnavailableMessage, root: rootDir, runtime: "unavailable" })
  })
})
