import { readdir, readFile } from "node:fs/promises"
import { delimiter, join } from "node:path"

import { createBuilder, resolveConfig } from "vite"
import { describe, expect, it } from "vitest"

import { vitehub } from "../src/index.ts"
import { consoleRpcHeader } from "../src/console/runtime/rpc.ts"
import { startBuiltServer } from "./content-preview-fixture.ts"
import { createProject, path, runCli, serverBuild } from "./support/content-cms.ts"

import type { CommentThread } from "@vite-hub/comments"

// Own file: it chdirs into the fixture, because the default libSQL file is relative to the working directory.
describe("Comments in a built Nitro 3 app", () => {
  it("creates the contributed tables with the CLI and serves create, reply, list, and resolve from the built server", async () => {
    const root = await createProject({
      "index.html": "<!doctype html><html><head><title>Fixture</title></head><body><main>ok</main></body></html>\n",
      "package.json": JSON.stringify({ name: "comments-build", private: true, type: "module" }),
      // Only the policy and the stores of vitehub() are the app's: the Database, its tables, and the plugin are contributed.
      "server/comments.ts": [
        "import { defineComments } from 'vite-hub/comments'",
        "",
        "export default defineComments({ authorize: () => true })",
        "",
      ].join("\n"),
      // A server-rendered page, which Vite's index.html transform does not see.
      "server/routes/ssr.ts": "export default () => new Response('<html><body><h1>Rendered</h1></body></html>', { headers: { 'content-type': 'text/html; charset=utf-8' } })\n",
      // Fixture-only sign-in lets the production build exercise writes as a verified Console user.
      "server/plugins/test-user.ts": [
        "import { definePlugin } from 'nitro'",
        "import { installConsoleAccess } from 'vite-hub/console/sections'",
        "export default definePlugin(app => {",
        "  app.hooks.hook('request', event => {",
        "    installConsoleAccess(event.req.headers.get('x-test-user') === 'ana'",
        "      ? { mode: 'auth', check: async () => undefined, user: async () => ({ id: 'ana', name: 'Ana' }) }",
        "      : { mode: 'open' })",
        "  })",
        "})",
      ].join("\n"),
    })
    process.chdir(root)
    process.env.PATH = `${join(import.meta.dirname, "../node_modules/.bin")}${delimiter}${path}`
    // Production output must never invent a local identity, even with NODE_ENV=development.
    const app = () => vitehub({ console: { auth: false }, preset: "node" })

    const generate = await runCli(root, app(), ["db", "generate"])
    expect(generate.stderr).toBe("")
    expect(generate.exitCode).toBe(0)
    const migrations = join(root, "server/databases/migrations")
    const sql = await readFile(join(migrations, (await readdir(migrations)).find(file => file.endsWith(".sql"))!), "utf8")
    expect(sql.match(/CREATE TABLE `\w+`/g)?.toSorted()).toEqual(["CREATE TABLE `vitehub_comment_counters`", "CREATE TABLE `vitehub_comment_messages`", "CREATE TABLE `vitehub_comment_threads`"])
    const migrate = await runCli(root, app(), ["db", "migrate"])
    expect(migrate.stderr).toBe("")
    expect(migrate.exitCode).toBe(0)

    const { nitro } = (await import("nitro/vite" as string)) as { nitro: () => unknown }
    const builder = await createBuilder({
      cacheDir: `${root}.vite-cache`,
      logLevel: "silent",
      // Where the docs put vitehub(): the Console routes reach Nitro when it comes after.
      plugins: [app(), nitro() as never],
      root,
    } as never)
    await builder.buildApp()

    const server = await startBuiltServer(root, { NODE_ENV: "development" })
    try {
      const unsigned = await server.fetch("/_vitehub/rpc/__call", {
        body: JSON.stringify({ input: { anchor: { kind: "page" }, body: "Unsigned", subject: { kind: "page", id: "/pricing" } }, operation: "comments.create" }),
        headers: { "content-type": "application/json", [consoleRpcHeader]: "1" },
        method: "POST",
      })
      expect(unsigned.status).toBe(401)
      expect(await unsigned.json()).toMatchObject({ code: "COMMENTS_R0012" })
      const call = async <T>(operation: string, input: unknown): Promise<T> => {
        const response = await server.fetch("/_vitehub/rpc/__call", {
          body: JSON.stringify({ input, operation }),
          headers: { "content-type": "application/json", "x-test-user": "ana", [consoleRpcHeader]: "1" },
          method: "POST",
        })
        const body = await response.json() as { code?: string, message?: string, ok: boolean, value: T }
        if (!body.ok) throw new Error(`${operation} failed: ${body.code} ${body.message}`)
        return body.value
      }
      const subject = { id: "/pricing", kind: "page" }

      // The overlay: the loader tag is in the SPA page and in a server-rendered page, once, and the files are served for good.
      const tag = /<script type="module" src="(\/_vitehub\/comments\/loader\.[\w-]+\.js\?f=(overlay\.[\w-]+\.js))"><\/script>/
      const home = await (await server.fetch("/")).text()
      const found = tag.exec(home)
      expect(found, home).not.toBeNull()
      expect(home.match(/comments\/loader\./g)).toHaveLength(1)
      const rendered = await (await server.fetch("/ssr")).text()
      expect(rendered).toMatch(/<h1>Rendered<\/h1><script type="module" src="\/_vitehub\/comments\/loader\.[\w-]+\.js\?f=overlay\.[\w-]+\.js"><\/script><\/body>/)
      expect(await call("comments.session", { subject })).toEqual({ canRead: true, canWrite: true, user: { id: "ana", name: "Ana" } })
      for (const file of [found![1]!.split("?")[0]!, `/_vitehub/comments/${found![2]!}`]) {
        const asset = await server.fetch(file)
        expect(asset.status, file).toBe(200)
        expect(asset.headers.get("content-type")).toContain("javascript")
        expect(asset.headers.get("cache-control")).toMatch(/max-age=31536000/)
      }
      // The Console page is HTML too, and gets no overlay.
      expect(await (await server.fetch("/_vitehub")).text()).not.toContain("comments/loader.")

      const created = await call<CommentThread>("comments.create", { anchor: { kind: "page" }, body: "Too small.", subject })
      expect(created).toMatchObject({ author: { id: "ana", name: "Ana" }, n: 1, status: "open", subject })
      const replied = await call<CommentThread>("comments.reply", { body: "Agreed.", threadId: created.id })
      expect(replied.messages.map(message => message.body)).toEqual(["Too small.", "Agreed."])
      const listed = await call<CommentThread[]>("comments.list", { page: "/pricing" })
      expect(listed.map(thread => [thread.id, thread.messages.length])).toEqual([[created.id, 2]])
      const resolved = await call<CommentThread>("comments.resolve", { threadId: created.id })
      expect(resolved.status).toBe("resolved")
      expect(await call<CommentThread[]>("comments.list", { status: "open" })).toEqual([])
      expect((await call<CommentThread[]>("comments.list", { status: "resolved" })).map(thread => thread.id)).toEqual([created.id])
    }
    finally {
      server.close()
    }
  }, 240_000)

  it.each([undefined, false] as const)("omits the production overlay when console is %s", async (console) => {
    const root = await createProject({
      "index.html": "<!doctype html><html><body><main>ok</main></body></html>",
      "package.json": JSON.stringify({ name: "comments-no-rpc", private: true, type: "module" }),
      "server/comments.ts": "import { defineComments } from 'vite-hub/comments'\nexport default defineComments({ authorize: () => true })\n",
      "server/routes/ssr.ts": "export default () => new Response('<html><body>Rendered</body></html>', { headers: { 'content-type': 'text/html' } })\n",
    })
    process.chdir(root)
    const { nitro } = await import("nitro/vite")
    const builder = await createBuilder({
      cacheDir: `${root}.vite-cache`, logLevel: "silent", root,
      plugins: [vitehub({ console, preset: "node" }), nitro()],
    })
    await builder.buildApp()
    const server = await startBuiltServer(root, {})
    try {
      for (const path of ["/", "/ssr"]) {
        const response = await server.fetch(path)
        expect(response.status).toBe(200)
        expect(await response.text()).not.toContain("/_vitehub/comments/loader.")
      }
      const entries = await readdir(join(root, ".output/public/_vitehub/comments")).catch(() => [])
      expect(entries).toEqual([])
    }
    finally { server.close() }
  }, 240_000)

  it("fails the build with COMMENTS_B0001 when the app sets database: false, and leaves apps without comments alone", async () => {
    const root = await createProject({
      "package.json": JSON.stringify({ name: "comments-no-database", private: true, type: "module" }),
      "server/comments.ts": "import { defineComments } from 'vite-hub/comments'\nexport default defineComments()\n",
    })
    await expect(resolveConfig(serverBuild(root, vitehub({ database: false, preset: "node" })), "build")).rejects.toMatchObject({
      code: "COMMENTS_B0001",
      fix: expect.stringContaining("database: false"),
    })
    await expect(resolveConfig(serverBuild(root, vitehub({ preset: "node" })), "build")).resolves.toBeDefined()

    const plain = await createProject({ "package.json": JSON.stringify({ name: "no-comments", private: true, type: "module" }) })
    await expect(resolveConfig(serverBuild(plain, vitehub({ database: false, preset: "node" })), "build")).resolves.toBeDefined()
  }, 60_000)
})
