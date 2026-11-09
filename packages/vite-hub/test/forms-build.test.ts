import { readdir, readFile } from "node:fs/promises"
import { delimiter, join } from "node:path"

import { createBuilder } from "vite"
import { describe, expect, it } from "vitest"

import { vitehub } from "../src/index.ts"
import { startBuiltServer } from "./content-preview-fixture.ts"
import { createProject, path, runCli } from "./support/content-cms.ts"

// Own file: it chdirs into the fixture, because the default libSQL file is relative to the working directory.
describe("Forms in a built Nitro 3 app", () => {
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
    const app = () => vitehub({ preset: "node" })

    const generate = await runCli(root, app(), ["db", "generate"])
    expect(generate.stderr).toBe("")
    expect(generate.exitCode).toBe(0)
    const migrations = join(root, "server/databases/migrations")
    const sql = await readFile(join(migrations, (await readdir(migrations)).find(file => file.endsWith(".sql"))!), "utf8")
    expect(sql.match(/CREATE TABLE `\w+`/g)).toEqual(["CREATE TABLE `vitehub_form_submissions`"])
    const migrate = await runCli(root, app(), ["db", "migrate"])
    expect(migrate.stderr).toBe("")
    expect(migrate.exitCode).toBe(0)

    const { nitro } = (await import("nitro/vite" as string)) as { nitro: () => unknown }
    const builder = await createBuilder({ cacheDir: `${root}.vite-cache`, logLevel: "silent", plugins: [app(), nitro() as never], root } as never)
    await builder.buildApp()

    const server = await startBuiltServer(root, {})
    try {
      const send = (body: unknown, headers: Record<string, string> = {}) => server.fetch("/api/_vitehub/forms/contact", {
        body: JSON.stringify(body),
        headers: { "content-type": "application/json", referer: "http://localhost/pricing", ...headers },
        method: "POST",
      })
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
    }
    finally {
      server.close()
    }
  }, 240_000)
})
