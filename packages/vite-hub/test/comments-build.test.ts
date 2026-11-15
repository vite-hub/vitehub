import { readdir, readFile } from "node:fs/promises"
import { delimiter, join } from "node:path"

import { viteHubPageToolsInlineScript } from "@vite-hub/internal/runtime/page-tools-shared"
import { createBuilder, resolveConfig } from "vite"
import { describe, expect, it } from "vitest"

import { vitehub } from "../src/index.ts"
import { consoleRpcHeader } from "../src/console/runtime/rpc.ts"
import { freePort, startBuiltServer } from "./content-preview-fixture.ts"
import { createProject, path, runCli, serverBuild } from "./support/content-cms.ts"

import type { CommentThread } from "@vite-hub/comments/client"
import { consoleTestKey, signedRpcRequest } from "./support/console-signature.ts"
import { operationRpcBody, operationRpcResponseResult } from "../../internal/test-utils/operation-rpc.ts"

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
      // The overlay API reads the app Auth session. The Console calls are signed instead.
      "server/auth.ts": "import { defineAuth } from 'vite-hub/auth'\nexport default defineAuth({ database: 'memory', emailAndPassword: { enabled: true } })\n",
      "server/console-authorize.ts": "export default () => true\n",
      // A server-rendered page, which Vite's index.html transform does not see.
      "server/routes/ssr.ts": "export default () => new Response('<html><body><h1>Rendered</h1></body></html>', { headers: { 'content-type': 'text/html; charset=utf-8' } })\n",
    })
    process.chdir(root)
    process.env.PATH = `${join(import.meta.dirname, "../node_modules/.bin")}${delimiter}${path}`
    // Production output must never invent a local identity, even with NODE_ENV=development.
    // Signed calls on Node check the origin that `publicUrl` names, so the server starts on a known port.
    const port = await freePort()
    const publicUrl = `http://127.0.0.1:${port}`
    const app = () => vitehub({ auth: true, console: { authorize: "./server/console-authorize.ts" }, host: "node", publicUrl })
    const ci = await consoleTestKey("CI")

    const generate = await runCli(root, app(), ["database", "generate"])
    expect(generate.stderr).toBe("")
    expect(generate.exitCode).toBe(0)
    const migrations = join(root, "server/databases/default/migrations")
    const migration = (await readdir(migrations)).find(file => /^\d{14}_/.test(file))!
    const sql = await readFile(join(migrations, migration, "migration.sql"), "utf8")
    expect(sql.match(/CREATE TABLE `\w+`/g)?.toSorted()).toEqual(["CREATE TABLE `vitehub_comment_counters`", "CREATE TABLE `vitehub_comment_forge`", "CREATE TABLE `vitehub_comment_messages`", "CREATE TABLE `vitehub_comment_threads`"])
    const migrate = await runCli(root, app(), ["database", "migrate"])
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

    const server = await startBuiltServer(root, { ...ci.env, NODE_ENV: "development" }, { port })
    try {
      const unsigned = await server.fetch("/_vitehub/rpc", {
        body: operationRpcBody("comments.create", { anchor: { kind: "page" }, body: "Unsigned", subject: { kind: "page", id: "/pricing" } }),
        headers: { "content-type": "application/json", [consoleRpcHeader]: "1" },
        method: "POST",
      })
      expect(unsigned.status).toBe(401)
      expect(await unsigned.json()).toMatchObject({ code: "CONSOLE_SIGNATURE_MISSING" })
      // The Console signs each call for the person who uses it.
      const call = async <T>(operation: string, input: unknown): Promise<T> => {
        const signed = await signedRpcRequest({ caller: { user: { id: "ana", name: "Ana" }, via: "console" }, input, key: ci.key, operation, url: `${publicUrl}/_vitehub/rpc` })
        const response = await server.fetch("/_vitehub/rpc", { body: await signed.text(), headers: signed.headers, method: "POST" })
        const body = await operationRpcResponseResult(response) as { code?: string, message?: string, ok: boolean, value: T }
        if (!body.ok) throw new Error(`${operation} failed: ${body.code} ${body.message}`)
        return body.value
      }
      const subject = { id: "/pricing", kind: "page" }

      // The overlay is the `comments` page tool: each page gets the page tools bootstrap once, also a server-rendered one.
      const home = await (await server.fetch("/")).text()
      expect(home.match(/data-vitehub-page-tools/g), home).toHaveLength(1)
      const rendered = await (await server.fetch("/ssr")).text()
      expect(rendered).toBe(`<html><body><h1>Rendered</h1>${viteHubPageToolsInlineScript("")}</body></html>`)
      expect(await call("comments.session", { subject })).toEqual({ canRead: true, canWrite: true, user: { id: "ana", name: "Ana" } })
      const overlay = await server.fetch("/api/_vitehub/comments/assets/overlay.js")
      expect(overlay.status).toBe(200)
      expect(overlay.headers.get("content-type")).toContain("javascript")

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

      // One server/comments.ts: the Comments API of the overlay reads and writes the same threads as the operations.
      const api = async (path: string, init: RequestInit = {}) => await server.fetch(`/api/_vitehub/comments${path}`, { ...init, headers: { "content-type": "application/json", "x-test-user": "ana", ...init.headers } })
      const overApi = await (await api("/threads?page=/pricing&status=resolved")).json() as { data: CommentThread[] }
      expect(overApi.data.map(thread => thread.id)).toEqual([created.id])
      // The overlay API trusts Auth or `identify`, not the Console, so the Console user of this fixture may not reopen there.
      const refused = await api(`/threads/${created.id}/reopen`, { method: "POST" })
      expect(refused.status).toBe(403)
      expect(await refused.json()).toMatchObject({ error: { code: "COMMENTS_FORBIDDEN" } })
      expect(await call<CommentThread>("comments.reopen", { threadId: created.id })).toMatchObject({ status: "open" })
      expect((await call<CommentThread[]>("comments.list", { status: "open" })).map(thread => thread.id)).toEqual([created.id])
    }
    finally {
      server.close()
    }
  }, 240_000)

  it("fails the build with COMMENTS_B0001 when the app sets database: false, and leaves apps without comments alone", async () => {
    const root = await createProject({
      "package.json": JSON.stringify({ name: "comments-no-database", private: true, type: "module" }),
      "server/comments.ts": "import { defineComments } from 'vite-hub/comments'\nexport default defineComments()\n",
    })
    await expect(resolveConfig(serverBuild(root, vitehub({ database: false, host: "node" })), "build")).rejects.toMatchObject({
      code: "COMMENTS_B0001",
      fix: expect.stringContaining("database: false"),
    })
    await expect(resolveConfig(serverBuild(root, vitehub({ host: "node" })), "build")).resolves.toBeDefined()

    const plain = await createProject({ "package.json": JSON.stringify({ name: "no-comments", private: true, type: "module" }) })
    await expect(resolveConfig(serverBuild(plain, vitehub({ database: false, host: "node" })), "build")).resolves.toBeDefined()
  }, 60_000)
})
