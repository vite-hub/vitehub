import { readdir, readFile } from "node:fs/promises"
import { delimiter, join } from "node:path"

import { createBuilder } from "vite"
import { describe, expect, it, onTestFinished, vi } from "vitest"

import { createFormsHandler } from "@vite-hub/forms/runtime"
import { getStandardContext } from "@vite-hub/runtime"

import { vitehub } from "../src/index.ts"
import { resolveGeneratedConsolePlugin } from "../src/console/vite.ts"
import { freePort, startBuiltServer } from "./content-preview-fixture.ts"
import { consoleTestKey, signedRpcRequest } from "./support/console-signature.ts"
import { createProject, path, runCli } from "./support/content-cms.ts"
import { operationRpcResponseResult } from "../../internal/test-utils/operation-rpc.ts"

// The generated handler passes `getStandardContext` as the Forms context, so its result must fit. The client address
// is in `runtime`.
const _standardContext: NonNullable<Parameters<typeof createFormsHandler>[0]["context"]> = getStandardContext

// Own file: it chdirs into the fixture, because the default libSQL file is relative to the working directory.
describe("Forms in a built Nitro 3 app", () => {
  it("fails the build when Database is off and a form stores submissions", async () => {
    const root = await createProject({
      "index.html": "<!doctype html><title>Forms</title>\n",
      "package.json": JSON.stringify({ name: "forms-memory-build", private: true, type: "module" }),
      "server/forms/contact.ts": "import * as v from 'valibot'\nimport { defineForm } from 'vite-hub/forms'\nexport default defineForm({ schema: v.object({ message: v.string() }) })\n",
    })
    const { nitro } = (await import("nitro/vite" as string)) as { nitro: () => unknown }
    const build = async () => {
      const builder = await createBuilder({ cacheDir: `${root}.vite-cache`, logLevel: "silent", plugins: [vitehub({ database: false, host: "node" }), nitro() as never], root } as never)
      await builder.buildApp()
    }
    await expect(build()).rejects.toMatchObject({ code: "FORMS_B0002", message: expect.stringContaining("server/forms/contact.ts") })
  }, 240_000)

  it("turns the Database on, adds the table, and stores, validates, and limits submissions on the built server", async () => {
    const root = await createProject({
      "index.html": "<!doctype html><html><head><title>Fixture</title></head><body><main>ok</main></body></html>\n",
      "package.json": JSON.stringify({ name: "forms-build", private: true, type: "module" }),
      "server/forms/contact.ts": [
        "import * as v from 'valibot'",
        "import { defineForm } from 'vite-hub/forms'",
        "",
        "export default defineForm({",
        "  schema: v.object({ email: v.pipe(v.string(), v.email('Enter a valid email.')), message: v.pipe(v.string(), v.minLength(1)) }),",
        "  rateLimit: { limit: 3, window: '1m' },",
        "  authorize: async ({ request }) => request.headers.get('content-type') === 'application/json' && (await request.json()).message !== 'Denied',",
        "})",
        "",
      ].join("\n"),
      // Reads the inbox from server code, the way the Console and app routes do.
      "server/routes/inbox.get.ts": [
        "import { installedForms } from 'vite-hub/forms/runtime'",
        "export default { fetch: async () => Response.json((await installedForms()!.inbox.list())[1]) }",
        "",
      ].join("\n"),
    })
    process.chdir(root)
    process.env.PATH = `${join(import.meta.dirname, "../node_modules/.bin")}${delimiter}${path}`
    // No `database` option: `server/forms/` turns it on.
    const port = await freePort()
    const publicUrl = `http://127.0.0.1:${port}`
    const app = () => vitehub({ console: true, host: "node", publicUrl })
    const ci = await consoleTestKey("CI")

    const generate = await runCli(root, app(), ["database", "generate"])
    expect(generate.stderr).toBe("")
    expect(generate.exitCode).toBe(0)
    const migrations = join(root, "server/databases/default/migrations")
    const migration = (await readdir(migrations)).find(file => /^\d{14}_/.test(file))!
    const sql = await readFile(join(migrations, migration, "migration.sql"), "utf8")
    expect(sql.match(/CREATE TABLE `\w+`/g)).toEqual(["CREATE TABLE `vitehub_form_submissions`"])
    const migrate = await runCli(root, app(), ["database", "migrate"])
    expect(migrate.stderr).toBe("")
    expect(migrate.exitCode).toBe(0)

    const { nitro } = (await import("nitro/vite" as string)) as { nitro: () => unknown }
    const builder = await createBuilder({ cacheDir: `${root}.vite-cache`, logLevel: "silent", plugins: [app(), nitro() as never], root } as never)
    await builder.buildApp()
    // `server/forms/` alone turns the Forms section of the Console on.
    const consolePlugin = await readFile(resolveGeneratedConsolePlugin(root), "utf8")
    expect(consolePlugin).toMatch(/installConsoleSections\([^)]*"forms"/)
    expect(consolePlugin).toContain('"operation":"forms.list"')

    const server = await startBuiltServer(root, ci.env, { port })
    try {
      const call = async <T>(operation: string, input: unknown): Promise<T> => {
        const signed = await signedRpcRequest({ input, key: ci.key, operation, url: `${publicUrl}/_vitehub/rpc` })
        const response = await server.fetch("/_vitehub/rpc", { body: await signed.text(), headers: signed.headers, method: "POST" })
        const body = await operationRpcResponseResult(response) as { code?: string, message?: string, ok: boolean, value: T }
        if (!body.ok) throw new Error(`${operation} failed: ${body.code} ${body.message}`)
        return body.value
      }
      // The handler installs the inbox when the server starts, so server code reads it before any submission.
      expect(await (await server.fetch("/inbox")).json()).toEqual([])
      expect(await call("forms.list", {})).toEqual([])
      const send = (body: unknown, headers: Record<string, string> = {}) => server.fetch("/api/_vitehub/forms/contact", {
        body: JSON.stringify(body),
        headers: { "content-type": "application/json", referer: "http://localhost/pricing", ...headers },
        method: "POST",
      })
      // Authorization can read the bounded host request, and a refusal leaves all three rate-limit attempts.
      const denied = await send({ email: "ada@example.com", message: "Denied" })
      expect(denied.status).toBe(401)
      const created = await send({ email: "ada@example.com", message: "Hello" })
      expect(created.status).toBe(201)
      const { id } = await created.json() as { id: string }

      const invalid = await send({ email: "nope", message: "Hi" })
      expect(invalid.status).toBe(400)
      expect(await invalid.json()).toEqual({ message: "Check the form and try again.", issues: [{ message: "Enter a valid email.", path: ["email"] }] })

      expect((await send({ email: "bot@example.com", message: "Buy", website: "x" })).status).toBe(202)
      expect((await send({ email: "ada@example.com", message: "Again" })).status).toBe(429)
      expect((await server.fetch("/api/_vitehub/forms/missing", { method: "POST", body: "{}", headers: { "content-type": "application/json" } })).status).toBe(404)

      const inbox = await (await server.fetch("/inbox")).json() as Array<{ id: string, data: unknown, page: string | null, status: string }>
      expect(inbox).toEqual([expect.objectContaining({ id, data: { email: "ada@example.com", message: "Hello" }, status: "open" })])

      // The Console lists, reads, and marks the same submissions through the forms operations.
      expect(await call("forms.get", { id })).toMatchObject({ id, form: "contact" })
      expect(await call("forms.mark", { id, status: "done" })).toMatchObject({ id, status: "done" })
      expect(await call("forms.list", { status: "open" })).toEqual([])
      expect(await call<Array<{ id: string }>>("forms.list", { status: "done" })).toEqual([expect.objectContaining({ id })])

      // `vitehub forms` runs the same operations from the command line.
      vi.stubEnv(`VITEHUB_CONSOLE_PRIVATE_KEY_${ci.key.name}`, ci.key.privateKey)
      onTestFinished(() => {
        vi.unstubAllEnvs()
      })
      const url = `http://127.0.0.1:${server.port}`
      const cli = async (...args: string[]) => {
        const result = await runCli(root, app(), ["forms", ...args, "--url", url, "--json"])
        expect(result.stderr).toBe("")
        expect(result.exitCode).toBe(0)
        return JSON.parse(result.stdout) as unknown
      }
      expect(await cli("mark", id, "spam")).toMatchObject({ id, status: "spam" })
      expect(await cli("get", id)).toMatchObject({ id, form: "contact", status: "spam", data: { email: "ada@example.com", message: "Hello" } })
      expect(await cli("list", "--status", "spam", "--form", "contact")).toEqual([expect.objectContaining({ id })])
      expect(await cli("--status", "open")).toEqual([])
      const table = await runCli(root, app(), ["forms", "list", "--url", url])
      expect(table.stdout.split("\n")[0]).toMatch(/^ID +FORM +STATUS +SENT AT +TEXT$/)
      expect(table.stdout).toContain(`${id}  contact  spam`)
      expect((await runCli(root, app(), ["forms", "mark", id, "done", "--url", url])).stdout).toBe(`Marked ${id} done.\n`)
      const wrong = await runCli(root, app(), ["forms", "mark", id, "closed", "--url", url])
      expect(wrong.exitCode).toBe(1)
      expect(wrong.stderr).toContain("status")
    }
    finally {
      server.close()
    }
  }, 240_000)
})
