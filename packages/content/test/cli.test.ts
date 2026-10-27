import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createClient } from "@libsql/client"
import { sql } from "drizzle-orm"
import { drizzle } from "drizzle-orm/libsql"
import { afterEach, describe, expect, it, vi } from "vitest"
import { z } from "zod"
import * as v from "valibot"

import { createBlobDatabaseWorkspaceStore, workspaceHistorySchema } from "@vite-hub/workspace/blob-database"
import { createOperationRegistry, operationExpectedRootsHeader, projectRootHash, runOperation } from "@vite-hub/internal/operations"
import { registerWorkspace } from "@vite-hub/workspace/test"

import { createBlobStorage } from "../../blob/src/storage.ts"
import { createDriver } from "../../blob/src/drivers/fs.ts"
import { createContentCliContributor, runContentCli } from "../src/cli.ts"
import { contentSessionsSchema } from "../src/database.ts"
import { documents, singleton } from "../src/collections.ts"
import { defineContent } from "../src/index.ts"
import { contentOperations } from "../src/operations.ts"
import { hubContent } from "../src/vite.ts"

import type { ContentCliOptions } from "../src/cli.ts"

const migration = [
  await readFile(new URL("../../workspace/test/fixtures/history.sql", import.meta.url), "utf8"),
  await readFile(new URL("./fixtures/sessions.sql", import.meta.url), "utf8"),
].join(";\n")
const cleanup: Array<() => Promise<void> | void> = []
let workspaces = 0
const rootDir = "/app"

afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
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
  const database = drizzle(client, { schema: { ...workspaceHistorySchema, ...contentSessionsSchema } })
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

/**
 * A fake dev server: it answers the operation RPC with the Content operations, as the Console does. The local policy
 * is the one `vite dev` installs, so `content.can()` is not asked for a user the CLI does not have.
 */
function devServer(content: unknown) {
  vi.stubEnv("NODE_ENV", "development")
  const registry = createOperationRegistry([{ operations: contentOperations }])
  Reflect.set(globalThis, Symbol.for("vitehub.console.section-modules"), content === undefined ? {} : { content: async () => ({ content }) })
  cleanup.push(() => { Reflect.deleteProperty(globalThis, Symbol.for("vitehub.console.section-modules")) })
  return vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
    const { input, operation } = JSON.parse(String(init?.body)) as { input: unknown, operation: string }
    const result = await runOperation(registry, operation, input, { access: { mode: "local", sections: "all" }, development: true, surface: "cli", user: null })
    return Response.json(result, { status: result.ok ? 200 : result.status })
  })
}

function cli(content: unknown, options: ContentCliOptions = {}) {
  const fetch = devServer(content)
  const run = async (...args: string[]) => {
    const stdout = stream()
    const stderr = stream()
    const code = await runContentCli(args, { cwd: rootDir, env: { VITEHUB_DEV_SERVER_URL: "http://localhost:5173" }, rootDir, stderr, stdout }, { fetch, ...options })
    return { code, stderr: stderr.output(), stdout: stdout.output() }
  }
  return { fetch, run }
}

const hello = { data: { title: "Hello", tags: ["vue"] }, body: "# Hello\n\nFirst post.\n" }

describe("vitehub content", { timeout: 30_000 }, () => {
  it("checks discovered roots but leaves explicit deployed URLs independent of the local path", async () => {
    const { content } = await setup()
    const { fetch, run } = cli(content)
    expect((await run("collections", "--url", "https://app.example.com")).code).toBe(0)
    expect(new Headers(fetch.mock.calls.at(-1)?.[1]?.headers).has(operationExpectedRootsHeader)).toBe(false)
    expect((await run("collections")).code).toBe(0)
    expect(new Headers(fetch.mock.calls.at(-1)?.[1]?.headers).get(operationExpectedRootsHeader)).toContain(projectRootHash(rootDir))
  })

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
        { name: "posts", kind: "documents", label: "Posts", path: "posts/**/*.md", format: "markdown", fields: ["title", "tags"], titleField: "title", documents: 2, states: { draft: 1, published: 1, changed: 0, deleted: 0 } },
        { name: "pages", kind: "documents", label: "Pages", path: "pages/*.md", format: "markdown", fields: ["title"], titleField: "title", documents: 0, states: { draft: 0, published: 0, changed: 0, deleted: 0 } },
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
    expect(missing.stderr).toContain("The diff operation requires a document id.")
  })

  it("diffs documents whose frontmatter no longer validates", async () => {
    const { content, posts, workspace } = await setup()
    await posts.save("hello", hello)
    await content.publish()
    await posts.save("hello", { ...hello, data: { title: "Renamed", tags: [] } })
    await content.dispose()
    // The field changed after the documents were written: the draft reads with issues, and the published version throws.
    const drifted = contentOn(workspace, z.literal("Only this title"))
    expect(await drifted.collection("posts").get("hello", { ref: "draft" })).toMatchObject({ issues: [expect.objectContaining({ field: "title" })] })
    await expect(drifted.collection("posts").get("hello", { ref: "published" })).rejects.toMatchObject({ code: "CONTENT_INVALID" })

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
    const helloDigest = (await posts.save("hello", hello)).digest.slice(0, 12)
    const aboutDigest = (await pages.save("about", { data: { title: "About" } })).digest.slice(0, 12)

    const unconfirmed = await cli(content).run("publish", "--json")
    expect(unconfirmed.code).toBe(1)
    expect(JSON.parse(unconfirmed.stdout)).toMatchObject({ error: { code: "CONTENT_PUBLISH_UNCONFIRMED" } })
    expect(await posts.status("hello")).toMatchObject({ state: "draft" })

    const declined = await cli(content, { confirm: async () => false }).run("publish")
    expect(declined).toMatchObject({ code: 1, stdout: "" })
    expect(declined.stderr).toBe(`Publish 2 documents:\n  add     posts/hello  ${helloDigest}\n  add     pages/about  ${aboutDigest}\nPublish cancelled.\n`)
    expect(await posts.status("hello")).toMatchObject({ state: "draft" })

    const dryRun = await cli(content).run("publish", "--collection", "posts", "--dry-run")
    expect(dryRun).toEqual({ code: 0, stderr: "", stdout: `Would publish 1 document:\n  add     posts/hello  ${helloDigest}\n` })
    expect(JSON.parse((await cli(content).run("publish", "--collection", "posts", "--dry-run", "--json")).stdout)).toEqual({
      dryRun: true, revision: null, documents: [{ collection: "posts", id: "hello", change: "add", digest: (await posts.status("hello"))!.draft }],
    })

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

  it("publishes exactly the confirmed drafts and names the ones saved after the list", async () => {
    const { content, pages, posts } = await setup()
    const listed = await posts.save("hello", hello)
    await pages.save("about", { data: { title: "About" } })

    // Someone saves posts/hello while the prompt waits.
    let saved: Awaited<ReturnType<typeof posts.save>> | undefined
    const late = await cli(content, {
      confirm: async () => {
        saved = await posts.save("hello", { data: { title: "Hello again", tags: [] }, body: "Edited during review\n" })
        return true
      },
    }).run("publish")
    expect(late).toEqual({
      code: 1,
      stderr: expect.stringContaining([
        "Nothing was published. 1 draft changed after you confirmed:",
        `  posts/hello  draft is now ${saved!.digest.slice(0, 12)} (you confirmed ${listed.digest.slice(0, 12)})`,
        "Review them with `vitehub content diff <collection> <id>`, then run the publish again.",
        "",
      ].join("\n")),
      stdout: "",
    })
    expect(await posts.status("hello")).toMatchObject({ state: "draft", published: null })
    expect(await pages.status("about")).toMatchObject({ state: "draft", published: null })

    // A deletion after the list is reported too, and --json carries the conflict details.
    const removed = await cli(content, {
      confirm: async () => {
        await posts.remove("hello")
        return true
      },
    }).run("publish", "--collection", "posts", "--json")
    expect(removed.code).toBe(1)
    expect(JSON.parse(removed.stdout)).toMatchObject({
      error: { code: "WORKSPACE_CONFLICT", details: { ref: "draft", documents: [{ collection: "posts", id: "hello", expected: saved!.digest, actual: null }] } },
    })

    // The next publish lists the current drafts and publishes them.
    await posts.save("hello", hello)
    const retried = await cli(content).run("publish", "--yes", "--json")
    expect(JSON.parse(retried.stdout)).toMatchObject({ dryRun: false, documents: [{ collection: "posts", id: "hello", change: "add" }, { collection: "pages", id: "about", change: "add" }] })
  })

  it("lists and shows documents with titles and field issues", async () => {
    const { content, posts } = await setup()
    await posts.save("hello", hello)
    await posts.save("broken", { data: { title: "", tags: [] } })
    await content.publish({ collection: "posts", ids: ["hello"] })
    const { run } = cli(content)

    expect(await run("list", "posts")).toEqual({
      code: 0,
      stderr: "",
      stdout: "draft      broken  (1 issue)\npublished  hello   Hello\n",
    })
    expect(JSON.parse((await run("list", "posts", "--ref", "published", "--json")).stdout)).toMatchObject({
      collection: "posts", ref: "published", total: 1, items: [{ id: "hello", title: "Hello", state: "published" }],
    })
    expect((await run("list", "posts", "--search", "hel")).stdout).toBe("published  hello  Hello\n")

    const shown = await run("show", "posts", "broken")
    expect(shown.code).toBe(0)
    expect(shown.stdout).toBe("---\ntitle: \"\"\ntags: []\n---\n")
    expect(shown.stderr).toBe("posts/broken has 1 field issue on draft:\n  title: Too small: expected string to have >=1 characters\n")
    expect(JSON.parse((await run("show", "posts", "hello", "--ref", "published", "--json")).stdout)).toMatchObject({
      collection: "posts", id: "hello", path: "posts/hello.md", ref: "published", digest: expect.any(String), text: expect.stringContaining("title: Hello\n"), status: { state: "published" },
    })
    expect(JSON.parse((await run("show", "posts", "nope", "--json")).stdout)).toMatchObject({ error: { code: "CONTENT_NOT_FOUND" } })
    expect(JSON.parse((await run("status", "posts", "broken", "--json")).stdout)).toMatchObject({ documents: [{ id: "broken", issues: 1 }] })
    expect((await run("status", "posts")).stdout).toContain("draft      posts/broken  (1 issue)\n")
  })

  it("saves drafts from a file or an editor and reports field issues", async () => {
    const { content, posts } = await setup()
    const root = await tempDir("vitehub-content-edit-")
    const file = join(root, "hello.md")
    await writeFile(file, "---\ntitle: Hello\ntags: [vue]\n---\n\nFrom a file.\n")
    const { run } = cli(content)

    const created = await run("edit", "posts", "hello", "--file", file, "--message", "Write hello")
    expect(created.code).toBe(0)
    const saved = (await posts.get("hello", { ref: "draft" }))!
    expect(saved).toMatchObject({ data: { title: "Hello", tags: ["vue"] }, body: "From a file.\n" })
    expect(created).toEqual({ code: 0, stderr: "", stdout: `Saved posts/hello to the draft as ${saved.digest.slice(0, 12)}.\n` })
    const [revision] = (await content.revisions("posts", "hello")).revisions
    expect(revision).toMatchObject({ message: "Write hello", metadata: { source: "cli" } })

    // Drafts accept invalid fields; the CLI saves them and names each issue.
    await writeFile(file, "---\ntitle: \"\"\n---\n")
    const invalid = await run("edit", "posts", "hello", "--file", file)
    expect(invalid.code).toBe(0)
    expect(invalid.stderr).toBe("The draft has 1 field issue. Publishing refuses it until they are fixed:\n  title: Too small: expected string to have >=1 characters\n")
    expect(JSON.parse((await run("edit", "posts", "hello", "--file", file, "--json")).stdout)).toMatchObject({ collection: "posts", id: "hello", issues: [{ field: "title" }] })

    const stale = await run("edit", "posts", "hello", "--file", file, "--if-digest", saved.digest)
    expect(stale.code).toBe(1)
    expect(stale.stderr).toContain("Nothing was saved. posts/hello changed after you opened it")
    expect((await run("edit", "posts", "hello", "--if-digest", saved.digest)).stderr).toContain("--if-digest requires --file.")

    // The editor gets the stored file; the save pins the digest it opened.
    const editor = vi.fn(async (path: string) => {
      expect(path.endsWith("hello.md")).toBe(true)
      await writeFile(path, (await readFile(path, "utf8")).replace("title: \"\"", "title: Edited"))
    })
    const edited = await cli(content, { editor }).run("edit", "posts", "hello")
    expect(edited.code).toBe(0)
    expect(await posts.get("hello", { ref: "draft" })).toMatchObject({ data: { title: "Edited" } })
    expect(await cli(content, { editor: async () => {} }).run("edit", "posts", "hello")).toEqual({ code: 0, stderr: "No changes: posts/hello was not saved.\n", stdout: "" })

    // A new document starts from a template with every field.
    const fresh = vi.fn(async (path: string) => {
      expect(await readFile(path, "utf8")).toBe("---\ntitle: null\ntags: null\n---\n")
      await writeFile(path, "---\ntitle: Fresh\n---\n")
    })
    expect((await cli(content, { editor: fresh }).run("edit", "posts", "fresh")).code).toBe(0)
    expect(await posts.get("fresh", { ref: "draft" })).toMatchObject({ data: { title: "Fresh", tags: [] } })

    // A save during the edit keeps the edit in a file and names it.
    const late = await cli(content, {
      editor: async (path) => {
        await posts.save("hello", { data: { title: "Elsewhere" } })
        await writeFile(path, "---\ntitle: Mine\n---\n")
      },
    }).run("edit", "posts", "hello")
    expect(late.code).toBe(1)
    const kept = /Your edit is kept in (\S+)\. Save it with `vitehub content edit posts hello --file \1`\./.exec(late.stderr)?.[1]
    expect(await readFile(kept!, "utf8")).toBe("---\ntitle: Mine\n---\n")
    await rm(join(kept!, ".."), { recursive: true, force: true })
    expect((await cli(undefined).run("edit", "posts", "hello")).stderr).toContain("needs --file <path> or an interactive terminal")
  })

  it("honours edit leases unless --override-lease", async () => {
    const { content, posts } = await setup()
    await posts.save("hello", hello)
    await content.sessions.acquire("posts", "hello", { session: "tab-ana-0001", user: { id: "ana", name: "Ana" } })
    const root = await tempDir("vitehub-content-lease-")
    const file = join(root, "hello.md")
    await writeFile(file, "---\ntitle: From the CLI\n---\n")
    const { run } = cli(content)

    const held = await run("edit", "posts", "hello", "--file", file)
    expect(held.code).toBe(1)
    expect(held.stderr).toMatch(/^Nothing was saved\. Ana holds the edit lease since \S+ on posts\/hello\.\nWait until they finish, or pass --override-lease to save anyway\.\n$/)
    expect(await posts.get("hello", { ref: "draft" })).toMatchObject({ data: { title: "Hello" } })
    expect(JSON.parse((await run("edit", "posts", "hello", "--file", file, "--json")).stdout)).toMatchObject({
      error: { code: "CONTENT_LEASE_HELD", details: { collection: "posts", id: "hello", holder: { kind: "edit", user: { id: "ana", name: "Ana" } } } },
    })

    expect((await run("edit", "posts", "hello", "--file", file, "--override-lease")).code).toBe(0)
    expect(await posts.get("hello", { ref: "draft" })).toMatchObject({ data: { title: "From the CLI" } })
  })

  it("works with singletons", async () => {
    const workspace = await historyWorkspace()
    const content = defineContent({
      workspace,
      collections: {
        posts: documents({ path: "posts/*.md", fields: { title: z.string() } }),
        settings: singleton({ path: "settings.json", label: "Site settings", fields: { title: z.string().min(1), social: z.array(z.string()).default([]) } }),
      },
      logger: false,
    })
    cleanup.push(() => content.dispose())
    const settings = content.collection("settings")
    const root = await tempDir("vitehub-content-singleton-")
    const file = join(root, "settings.json")
    await writeFile(file, `${JSON.stringify({ title: "ViteHub" })}\n`)
    const { run } = cli(content)

    expect((await run("edit", "settings", "--file", file)).code).toBe(0)
    expect(await settings.get({ ref: "draft" })).toMatchObject({ data: { title: "ViteHub", social: [] } })
    expect((await run("collections")).stdout).toContain("settings  settings.json  singleton\n  Fields: title, social\n  Documents: 1 (1 draft)\n")
    expect(JSON.parse((await run("collections", "--json")).stdout).collections[1]).toMatchObject({ name: "settings", kind: "singleton", label: "Site settings", format: "json", id: "settings" })
    expect(await run("list", "settings")).toMatchObject({ code: 0, stdout: "draft  settings  Site settings\n" })
    expect((await run("show", "settings")).stdout).toBe("{\n  \"title\": \"ViteHub\"\n}\n")
    expect((await run("status", "settings")).stdout).toBe("draft  settings/settings\n")
    expect((await run("diff", "settings")).stdout).toContain("--- /dev/null\n+++ draft/settings.json\n")

    const published = await cli(content, { confirm: async () => true }).run("publish", "--collection", "settings")
    expect(published.code).toBe(0)
    expect(published.stdout).toContain("  add     settings/settings\n")
    expect(await settings.get()).toMatchObject({ data: { title: "ViteHub" } })
    expect(JSON.parse((await run("revisions", "settings", "--ref", "published", "--json")).stdout)).toMatchObject({ collection: "settings", id: "settings", revisions: [{ ref: "published" }] })
  })

  it("refuses to publish drafts with field issues and names each issue", async () => {
    const { content, posts } = await setup()
    await posts.save("hello", hello)
    await posts.save("broken", { data: { title: "", tags: [] } })
    const confirm = vi.fn(async () => true)

    expect((await cli(content).run("publish", "--dry-run")).stdout).toContain("  add     posts/broken  ")
    expect((await cli(content).run("publish", "--dry-run")).stdout).toContain("  (1 issue)\n")
    const refused = await cli(content, { confirm }).run("publish")
    expect(confirm).not.toHaveBeenCalled()
    expect(refused).toEqual({
      code: 1,
      stderr: [
        "Nothing was published. 1 draft has invalid fields:",
        "  posts/broken",
        "    title: Too small: expected string to have >=1 characters",
        "Fix them with `vitehub content edit <collection> <id>`, then run the command again.",
        "",
      ].join("\n"),
      stdout: "",
    })
    expect(await posts.status("hello")).toMatchObject({ state: "draft" })
    expect(JSON.parse((await cli(content).run("publish", "--json")).stdout)).toMatchObject({
      error: { code: "CONTENT_INVALID", details: { documents: [{ collection: "posts", id: "broken", issues: [{ field: "title" }] }] } },
    })
  })

  it("schedules reviewed drafts, lists schedules, and unschedules them", async () => {
    const { content, pages, posts } = await setup()
    const listed = await posts.save("hello", hello)
    await pages.save("about", { data: { title: "About" } })
    const at = new Date(Date.now() + 3_600_000).toISOString()
    const { run } = cli(content, { confirm: async () => true })

    expect((await run("schedule", "--collection", "posts")).stderr).toContain("Missing --at.")
    expect(await run("schedule", "--collection", "posts", "--dry-run", "--at", at)).toEqual({
      code: 0, stderr: "", stdout: `Would schedule 1 document at ${at}:\n  add     posts/hello  ${listed.digest.slice(0, 12)}\n`,
    })
    const scheduled = await run("schedule", "--collection", "posts", "--at", at, "--message", "Launch")
    expect(scheduled.code).toBe(0)
    const [schedule] = await content.schedules()
    expect(schedule).toMatchObject({ at, message: "Launch", metadata: { source: "cli" }, expect: [{ collection: "posts", id: "hello", digest: listed.digest }] })
    expect(scheduled.stdout).toBe(`Scheduled 1 document for ${at} as ${schedule!.id}.\nCancel it with \`vitehub content unschedule ${schedule!.id}\`.\n`)
    expect((await run("status", "posts")).stdout).toBe(`draft  posts/hello  (scheduled ${at})\n`)

    expect(await run("scheduled")).toEqual({ code: 0, stderr: "", stdout: `pending  ${at}  ${schedule!.id}  posts/hello\n` })
    expect(JSON.parse((await run("scheduled", "pages", "--json")).stdout)).toEqual({ schedules: [] })
    expect((await run("scheduled", "--status", "failed")).stderr).toBe("No schedules.\n")
    const past = await run("schedule", "--collection", "pages", "--at", "2020-01-01T00:00:00Z", "--json")
    expect(JSON.parse(past.stdout)).toMatchObject({ error: { code: "CONTENT_R0011" } })

    // A save after scheduling makes the run fail; the list shows why.
    await posts.save("hello", { ...hello, body: "Changed after review.\n" })
    await content.publishDue({ now: new Date(Date.parse(at) + 1_000) })
    const failed = await run("scheduled", "--status", "failed")
    expect(failed.stdout).toBe(`failed  ${at}  ${schedule!.id}  posts/hello\n  WORKSPACE_CONFLICT: Content changed on the draft after it was reviewed, so publish() published nothing:\n`)

    expect(await run("unschedule", schedule!.id)).toEqual({ code: 0, stderr: "", stdout: `Removed schedule ${schedule!.id}. Nothing it named was published.\n` })
    expect(await content.schedules()).toEqual([])
    expect(JSON.parse((await run("unschedule", schedule!.id, "--json")).stdout)).toMatchObject({ error: { code: "CONTENT_NOT_FOUND" } })
  })

  it("prints the sitemap", async () => {
    const workspace = await historyWorkspace()
    const content = defineContent({
      workspace,
      collections: { posts: documents({ path: "posts/*.md", fields: { title: z.string() }, url: "/blog/:id" }) },
      seo: { site: "https://example.com" },
      logger: false,
    })
    cleanup.push(() => content.dispose())
    const { run } = cli(content)
    expect(await run("sitemap")).toMatchObject({ code: 0, stdout: "" })
    await content.collection("posts").save("hello", { data: { title: "Hello" } })
    await content.publish()

    const urls = await run("sitemap")
    expect(urls.stdout).toMatch(/^https:\/\/example\.com\/blog\/hello  \S+\n$/)
    expect((await run("sitemap", "--site", "https://vitehub.dev")).stdout).toMatch(/^https:\/\/vitehub\.dev\/blog\/hello/)
    expect((await run("sitemap", "--xml")).stdout).toContain("<loc>https://example.com/blog/hello</loc>")
    expect(JSON.parse((await run("sitemap", "--json")).stdout)).toMatchObject({ entries: [{ collection: "posts", id: "hello", loc: "https://example.com/blog/hello" }] })
  })

  it("explains when the app is unreachable and when it has no Content", async () => {
    const stdout = stream()
    const stderr = stream()
    const offline = vi.fn(async () => { throw new TypeError("fetch failed") })
    const code = await runContentCli(["status"], { cwd: rootDir, env: { VITEHUB_DEV_SERVER_URL: "http://localhost:5173" }, rootDir, stderr, stdout }, { fetch: offline })
    expect(code).toBe(1)
    expect(stderr.output()).toContain("The request to http://localhost:5173 failed")
    expect(stderr.output()).toContain("Fix: Start the dev server")

    // Without a known dev server the command asks for one. It does not try a port.
    const unknown = stream()
    const unknownErr = stream()
    const none = vi.fn()
    expect(await runContentCli(["status", "--json"], { cwd: rootDir, env: {}, rootDir, stderr: unknownErr, stdout: unknown }, { fetch: none })).toBe(1)
    expect(JSON.parse(unknown.output()).error).toMatchObject({ code: "CONTENT_R0015", fix: expect.stringContaining("vite dev") })
    expect(none).not.toHaveBeenCalled()

    const undefinedContent = await cli(undefined).run("collections", "--json")
    expect(JSON.parse(undefinedContent.stdout)).toMatchObject({ error: { code: "CONTENT_UNDEFINED", fix: expect.stringContaining("server/content.ts") } })
  })

  it("prints help and contributes the content namespace", async () => {
    const { run } = cli(undefined)
    const help = await run("publish", "--help")
    expect(help.code).toBe(0)
    expect(help.stdout).toContain("Usage: vitehub content publish [--collection <name>] [--id <id>...] [--message <text>] [--dry-run] [--yes] [--json] [--url <url>]")
    expect(help.stdout).toContain("With --url it calls a deployed app")
    expect((await run("nope")).stderr).toBe("Unknown content command: nope\nCommands: collections, list, show, status, diff, revisions, edit, publish, schedule, scheduled, unschedule, sitemap\n")
    const [namespace] = createContentCliContributor().namespaces
    expect(namespace?.name).toBe("content")
    expect(namespace?.features.map(feature => feature.name)).toEqual(["collections", "list", "show", "status", "diff", "revisions", "edit", "publish", "schedule", "scheduled", "unschedule", "sitemap"])
  })
})

describe("Content operations", () => {
  it("filters document policy before pagination and sitemap output", async () => {
    const content = defineContent({
      workspace: await historyWorkspace(),
      authorize: ({ id }) => id === undefined || id.startsWith("visible"),
      collections: { posts: documents({ path: "posts/*.md", fields: { title: z.string() }, url: "/blog/:id" }) },
      seo: { site: "https://example.com" },
      logger: false,
    })
    cleanup.push(() => content.dispose())
    for (const id of ["hidden", "visible-a", "visible-b"]) await content.collection("posts").save(id, { data: { title: id } })
    await content.publish()
    Reflect.set(globalThis, Symbol.for("vitehub.console.section-modules"), { content: async () => ({ content }) })
    cleanup.push(() => { Reflect.deleteProperty(globalThis, Symbol.for("vitehub.console.section-modules")) })
    const registry = createOperationRegistry([{ operations: contentOperations }])
    const context = { access: { mode: "open", sections: "all" as const }, surface: "console" as const, user: null }
    const first = await runOperation(registry, "content.list", { collection: "posts", limit: 1 }, context)
    expect(first).toMatchObject({ ok: true, value: { items: [{ id: "visible-a" }], total: 2, cursor: expect.any(String) } })
    if (!first.ok) throw new Error(first.message)
    const page = v.parse(v.object({ cursor: v.string() }), first.value)
    expect(await runOperation(registry, "content.list", { collection: "posts", limit: 1, cursor: page.cursor }, context))
      .toMatchObject({ ok: true, value: { items: [{ id: "visible-b" }], total: 2 } })
    const sitemap = await runOperation(registry, "content.sitemap", {}, context)
    expect(sitemap).toMatchObject({ ok: true, value: { entries: [{ id: "visible-a" }, { id: "visible-b" }] } })
  })

  it("does not trust runtime NODE_ENV as production Content authorization", async () => {
    const content = contentOn(await historyWorkspace())
    Reflect.set(globalThis, Symbol.for("vitehub.console.section-modules"), { content: async () => ({ content }) })
    cleanup.push(() => { Reflect.deleteProperty(globalThis, Symbol.for("vitehub.console.section-modules")) })
    vi.stubEnv("NODE_ENV", "development")
    const registry = createOperationRegistry([{ operations: contentOperations }])
    expect(await runOperation(registry, "content.list", { collection: "posts" }, {
      access: { mode: "open", sections: "all" }, surface: "cli", user: null,
    })).toMatchObject({ ok: false, code: "CONTENT_FORBIDDEN" })
  })

  it("rejects a publish that does not pin the digests of a dry run", async () => {
    const { content } = await setup()
    const registry = createOperationRegistry([{ operations: contentOperations }])
    const run = (input: unknown) => runOperation(registry, "content.publish", input, { access: { mode: "local", sections: "all" }, development: true, surface: "cli", user: null })
    Reflect.set(globalThis, Symbol.for("vitehub.console.section-modules"), { content: async () => ({ content }) })
    cleanup.push(() => { Reflect.deleteProperty(globalThis, Symbol.for("vitehub.console.section-modules")) })
    for (const input of [
      {},
      { collection: "posts" },
      { expect: [] },
      { expect: [{ collection: "posts", id: "hello" }] },
      { collection: "posts", expect: [{ collection: "posts", digest: null, id: "hello" }] },
      { dryRun: true, expect: [{ collection: "posts", digest: null, id: "hello" }] },
    ]) {
      const result = await run(input)
      expect(result, JSON.stringify(input)).toMatchObject({ ok: false, status: 400 })
    }
  })

  it("finds the document at a public path for the comments overlay, and nothing else", async () => {
    const workspace = await historyWorkspace()
    const content = defineContent({
      authorize: ({ action, id, user }) => action === "read" ? id !== "secret" : user?.id === "editor",
      collections: {
        pages: documents({ path: "pages/*.md", fields: { title: z.string() }, url: "/:id" }),
        posts: documents({ path: "posts/*.md", fields: { title: z.string() }, url: "/blog/:id" }),
      },
      logger: false,
      workspace,
    })
    cleanup.push(() => content.dispose())
    await content.collection("posts").save("hello world", { data: { title: "Hello" } })
    await content.collection("pages").save("about", { data: { title: "About" } })
    await content.collection("pages").save("secret", { data: { title: "Secret" } })
    Reflect.set(globalThis, Symbol.for("vitehub.console.section-modules"), { content: async () => ({ content }) })
    cleanup.push(() => { Reflect.deleteProperty(globalThis, Symbol.for("vitehub.console.section-modules")) })
    const registry = createOperationRegistry([{ operations: contentOperations }])
    const resolve = (path: string) => runOperation(registry, "content.resolve", { path }, { access: { mode: "open", sections: "all" }, surface: "console", user: null })
    expect(await resolve("/blog/hello%20world")).toEqual({ ok: true, value: { collection: "posts", id: "hello world" } })
    expect(await resolve("/blog/hello%20world/")).toMatchObject({ value: { id: "hello world" } })
    expect(await resolve("/about?ref=1")).toEqual({ ok: true, value: { collection: "pages", id: "about" } })
    // A document the reader may not read, and a path without a document, both answer null.
    expect(await resolve("/secret")).toEqual({ ok: true, value: null })
    expect(await resolve("/nowhere")).toEqual({ ok: true, value: null })
  })

  it.each([
    ["/blog/:id/", "Hello", "/blog/hello"],
    ["/blog/:id/?lang=en#top", "Hello", "/blog/hello"],
    ["/blog/:title/", "", "/blog"],
    ["/blog/?lang=en#top", "Hello", "/blog"],
  ])("resolves normalized paths for the URL pattern %s", async (url, title, target) => {
    const content = defineContent({
      authorize: () => true,
      collections: { posts: documents({ path: "posts/*.md", fields: { title: z.string() }, url }) },
      logger: false,
      workspace: await historyWorkspace(),
    })
    cleanup.push(() => content.dispose())
    await content.collection("posts").save("hello", { data: { title } })
    Reflect.set(globalThis, Symbol.for("vitehub.console.section-modules"), { content: async () => ({ content }) })
    cleanup.push(() => { Reflect.deleteProperty(globalThis, Symbol.for("vitehub.console.section-modules")) })
    const registry = createOperationRegistry([{ operations: contentOperations }])
    for (const path of [target, `${target}/`, `${target}/?ref=1#top`]) {
      expect(await runOperation(registry, "content.resolve", { path }, { access: { mode: "open", sections: "all" }, surface: "console", user: null })).toEqual({ ok: true, value: { collection: "posts", id: "hello" } })
    }
  })

  it("lists each collection once per head, and not at all when no route can produce the path", async () => {
    const workspace = await historyWorkspace()
    const content = defineContent({
      authorize: () => true,
      collections: {
        pages: documents({ path: "pages/*.md", fields: { title: z.string() }, url: "/:id" }),
        posts: documents({ path: "posts/*.md", fields: { title: z.string() }, url: "/blog/:id" }),
      },
      logger: false,
      workspace,
    })
    cleanup.push(() => content.dispose())
    const pages = content.collection("pages")
    const posts = content.collection("posts")
    await posts.save("hello", { data: { title: "Hello" } })
    await pages.save("about", { data: { title: "About" } })
    Reflect.set(globalThis, Symbol.for("vitehub.console.section-modules"), { content: async () => ({ content }) })
    cleanup.push(() => { Reflect.deleteProperty(globalThis, Symbol.for("vitehub.console.section-modules")) })
    const postList = vi.spyOn(posts, "list")
    const pageList = vi.spyOn(pages, "list")
    const registry = createOperationRegistry([{ operations: contentOperations }])
    const resolve = (path: string) => runOperation(registry, "content.resolve", { path }, { access: { mode: "open", sections: "all" }, surface: "console", user: null })

    expect(await resolve("/blog/hello")).toEqual({ ok: true, value: { collection: "posts", id: "hello" } })
    expect(await resolve("/blog/hello")).toEqual({ ok: true, value: { collection: "posts", id: "hello" } })
    expect(postList).toHaveBeenCalledTimes(1)
    // `/about` can only come from the pages route. The blog route cannot produce it, so posts are not listed again.
    expect(await resolve("/about")).toEqual({ ok: true, value: { collection: "pages", id: "about" } })
    expect(await resolve("/nowhere")).toEqual({ ok: true, value: null })
    expect([postList.mock.calls.length, pageList.mock.calls.length]).toEqual([1, 1])
    // No collection at all can produce this one.
    expect(await resolve("/blog")).toEqual({ ok: true, value: null })
    // A save moves the head: the next lookup lists again, and sees the new document.
    await posts.save("second", { data: { title: "Second" } })
    expect(await resolve("/blog/second")).toEqual({ ok: true, value: { collection: "posts", id: "second" } })
    expect(postList).toHaveBeenCalledTimes(2)
    expect(postList.mock.calls[0]![0]).toMatchObject({ limit: 1_000, ref: "draft" })
  })

  it("reads every page of a large collection when it builds the index", async () => {
    const collection = {
      kind: "documents",
      list: vi.fn(async (options: { cursor?: string }) => {
        const page = Number(options.cursor ?? 0)
        return { items: Array.from({ length: 1_000 }, (_, index) => ({ id: `d${page * 1_000 + index}`, url: `/d/d${page * 1_000 + index}` })), nextCursor: page < 4 ? String(page + 1) : null, total: 5_000 }
      }),
      name: "docs",
      routable: true,
      urlPattern: "/d/:id",
    }
    const runtime = {
      can: async () => true,
      collection: () => collection,
      collections: () => [collection],
      head: async () => "head-1",
      hasPolicy: true,
      publish: async () => undefined,
      revisions: async () => undefined,
      schedule: async () => undefined,
      schedules: async () => undefined,
      sitemap: async () => undefined,
      unschedule: async () => undefined,
    }
    Reflect.set(globalThis, Symbol.for("vitehub.console.section-modules"), { content: async () => ({ content: runtime }) })
    cleanup.push(() => { Reflect.deleteProperty(globalThis, Symbol.for("vitehub.console.section-modules")) })
    const registry = createOperationRegistry([{ operations: contentOperations }])
    const resolve = (path: string) => runOperation(registry, "content.resolve", { path }, { access: { mode: "open", sections: "all" }, surface: "console", user: null })
    // The last document of 5,000: far beyond any first page.
    expect(await resolve("/d/d4999")).toEqual({ ok: true, value: { collection: "docs", id: "d4999" } })
    expect(collection.list).toHaveBeenCalledTimes(5)
    expect(await resolve("/d/d2500")).toMatchObject({ value: { id: "d2500" } })
    expect(collection.list).toHaveBeenCalledTimes(5)
  })

  it("applies content.can() for a signed-in user and for an Agent Actor", async () => {
    const workspace = await historyWorkspace()
    const content = defineContent({
      authorize: ({ action, user }) => action === "read" || user?.id === "editor",
      collections: { posts: documents({ path: "posts/**/*.md", fields: { title: z.string() } }) },
      logger: false,
      workspace,
    })
    cleanup.push(() => content.dispose())
    Reflect.set(globalThis, Symbol.for("vitehub.console.section-modules"), { content: async () => ({ content }) })
    cleanup.push(() => { Reflect.deleteProperty(globalThis, Symbol.for("vitehub.console.section-modules")) })
    const registry = createOperationRegistry([{ operations: contentOperations }])
    const text = "---\ntitle: Hello\n---\n\nHi\n"
    const as = (id: string | undefined) => ({ access: { mode: "open", sections: "all" as const }, surface: "console" as const, user: id ? { id } : null })
    expect(await runOperation(registry, "content.save", { collection: "posts", id: "hello", ifDigest: null, text }, as("reader"))).toMatchObject({ code: "CONTENT_FORBIDDEN", fix: expect.stringContaining("authorize"), ok: false, status: 403 })
    expect(await runOperation(registry, "content.save", { collection: "posts", id: "hello", ifDigest: null, text }, as("editor"))).toMatchObject({ ok: true })
    expect(await runOperation(registry, "content.list", { collection: "posts" }, as(undefined))).toMatchObject({ ok: true, value: { items: [{ id: "hello" }] } })
    // A deployed app without a signed-in user is not the trusted dev CLI.
    expect(await runOperation(registry, "content.publish", { dryRun: true }, as(undefined))).toMatchObject({ ok: true })
  })
})

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

  it("adds no dev endpoint and contributes the Content operations", async () => {
    const root = await project(true)
    const plugin = hubContent()
    const serve: Record<string, unknown> = { nitro: { handlers: [] }, root }
    await configHook(plugin)(serve, { command: "serve", mode: "development" })
    expect(serve.nitro).toEqual({ handlers: [] })
    const operations = plugin.vitehub.operations
    if (!(operations instanceof Function)) throw new Error("expected a function that reads the project first")
    const entries = await operations()
    expect(entries).toEqual([expect.objectContaining({ export: "contentOperations", module: "@vite-hub/content/operations" })])
    expect(await entries[0]!.load!()).toBe(contentOperations)
    // An app without server/content.ts has no Content to operate on.
    const without = hubContent()
    await configHook(without)({ root: await project(false) }, { command: "serve", mode: "development" })
    const none = without.vitehub.operations
    expect(none instanceof Function ? await none() : none).toEqual([])
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
})

describe("Content operations in a development server and for Agents", () => {
  async function operationsOn(content: ReturnType<typeof defineContent>) {
    Reflect.set(globalThis, Symbol.for("vitehub.console.section-modules"), { content: async () => ({ content }) })
    cleanup.push(() => { Reflect.deleteProperty(globalThis, Symbol.for("vitehub.console.section-modules")) })
    const registry = createOperationRegistry([{ operations: contentOperations }])
    return (name: string, input: unknown, context: Parameters<typeof runOperation>[3]) => runOperation(registry, name, input, context)
  }

  async function policed() {
    const workspace = await historyWorkspace()
    const content = defineContent({
      authorize: ({ user }) => user?.id === "editor",
      collections: { posts: documents({ path: "posts/**/*.md", fields: { title: z.string() } }) },
      logger: false,
      workspace,
    })
    cleanup.push(() => content.dispose())
    return content
  }

  const text = "---\ntitle: Hello\n---\n\nHi\n"
  const cli = (mode: string, development = false) => ({ access: { mode, sections: "all" as const }, development, surface: "cli" as const, user: null })

  it("trusts the CLI without a user only in a development server, with local or open access", async () => {
    const run = await operationsOn(await policed())
    const list = { collection: "posts" }
    for (const mode of ["local", "open"]) {
      vi.stubEnv("NODE_ENV", "development")
      expect(await run("content.list", list, cli(mode, true)), mode).toMatchObject({ ok: true })
      vi.stubEnv("NODE_ENV", "production")
      expect(await run("content.list", list, cli(mode)), mode).toMatchObject({ code: "CONTENT_FORBIDDEN", ok: false, status: 403 })
    }
    vi.stubEnv("NODE_ENV", "development")
    // A Console that signs people in is never trusted this way.
    expect(await run("content.list", list, cli("auth", true))).toMatchObject({ code: "CONTENT_FORBIDDEN" })
    expect(await run("content.list", list, { access: { mode: "local", sections: "all" }, development: true, surface: "console", user: null })).toMatchObject({ code: "CONTENT_FORBIDDEN" })
  })

  it("rejects lease override from an Agent unless the developer allowed it", async () => {
    const run = await operationsOn(await policed())
    const input = { collection: "posts", id: "hello", ifDigest: null, lease: "override", text }
    const agent = { access: { mode: "agent", sections: "all" as const }, actor: { id: "agent_1" }, surface: "agent" as const, user: { id: "editor" } }
    expect(await run("content.save", input, agent)).toMatchObject({ code: "CONTENT_FORBIDDEN", fix: expect.stringContaining("overrideLeases"), ok: false, status: 403 })
    expect(await run("content.save", input, { ...agent, overrideLeases: true })).toMatchObject({ ok: true })
    // Without the override, an Agent saves as before, and a person may still override from the Console.
    expect(await run("content.save", { ...input, ifDigest: undefined, lease: undefined }, agent)).toMatchObject({ ok: true })
    expect(await run("content.save", { ...input, ifDigest: undefined }, { access: { mode: "open", sections: "all" }, surface: "console", user: { id: "editor" } })).toMatchObject({ ok: true })
  })

  it("marks a publish dry run as read only", () => {
    const publish = contentOperations.find(operation => operation.name === "content.publish")!
    expect(publish.readOnlyWhen?.({ dryRun: true } as never)).toBe(true)
    expect(publish.readOnlyWhen?.({ expect: [] } as never)).toBe(false)
    expect(publish.kind).toBe("destructive")
  })
})
