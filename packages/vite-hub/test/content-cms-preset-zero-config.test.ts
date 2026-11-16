import { readFile, readdir } from "node:fs/promises"
import { delimiter, join } from "node:path"
import { pathToFileURL } from "node:url"

import { build, createServer } from "vite"
import { describe, expect, it } from "vitest"

import { vitehub } from "../src/index.ts"
import { contentDefinition, createProject, path, runCli, server, serverBuild, type RunResult } from "./support/content-cms.ts"

// Own file, so its Workspace and Database runtime state does not mix with content-cms-preset.test.ts.
describe("Content cms preset with only server/content.ts and vitehub({ host })", () => {
  it("turns on Workspace, Database, and Blob and uses the implicit default Database", async () => {
    const root = await createProject({
      "package.json": JSON.stringify({ name: "content-cms-zero-config", private: true, type: "module" }),
      "server/content.ts": contentDefinition,
      "src/server.ts": server,
    })
    // The default libSQL file and Blob directory are relative to the working directory, as when the app runs.
    process.chdir(root)
    const zeroConfig = () => vitehub({ host: "node" })
    process.env.PATH = `${join(import.meta.dirname, "../node_modules/.bin")}${delimiter}${path}`

    const generate = await runCli(root, zeroConfig(), ["database", "generate"])
    expect(generate.stderr).toBe("")
    expect(generate.exitCode).toBe(0)
    const migrationsDir = join(root, "server/databases/default/migrations")
    const migration = (await readdir(migrationsDir)).find(file => /^\d{14}_/.test(file))!
    expect((await readFile(join(migrationsDir, migration, "migration.sql"), "utf8")).match(/CREATE TABLE `\w+`/g)?.toSorted()).toEqual([
      "CREATE TABLE `vitehub_content_sessions`",
      "CREATE TABLE `workspace_history_metadata`",
      "CREATE TABLE `workspace_history_objects`",
      "CREATE TABLE `workspace_history_refs`",
      "CREATE TABLE `workspace_history_revisions`",
      "CREATE TABLE `workspace_history_workspaces`",
    ])
    await expect(readFile(join(root, ".vitehub/content/database.ts"), "utf8")).rejects.toMatchObject({ code: "ENOENT" })
    const migrate = await runCli(root, zeroConfig(), ["database", "migrate"])
    expect(migrate.stderr).toBe("")
    expect(migrate.exitCode).toBe(0)

    const inspect = await runCli(root, zeroConfig(), ["inspect", "definitions", "--kind", "database", "--json"])
    expect(inspect.exitCode).toBe(0)
    expect(inspect.stdout).toContain("ViteHub adds an empty default Database for plugin \\\"@vite-hub/cms/vite\\\"")
    expect(inspect.stdout).toContain("Stores the history of Content documents.")

    const dev = await createServer({ ...serverBuild(root, zeroConfig()), server: { middlewareMode: true, watch: null } })
    try {
      // SAFETY: The fixture module exports run() with the RunResult shape.
      const module = await dev.ssrLoadModule(join(root, "src/server.ts")) as { run: (id: string) => Promise<RunResult> }
      await expect(module.run("hello")).resolves.toEqual({
        after: { body: "# hello\n", data: { title: "Post hello" } },
        before: null,
        ids: ["hello"],
        published: [{ change: "add", collection: "posts", id: "hello" }],
      })
    }
    finally {
      await dev.close()
    }

    await build(serverBuild(root, zeroConfig()))
    const output = (await readdir(join(root, "dist"))).find(file => /^server\.m?js$/.test(file))!
    // SAFETY: The built entry exports run() with the RunResult shape.
    const built = await import(pathToFileURL(join(root, "dist", output)).href) as { run: (id: string) => Promise<RunResult> }
    const result = await built.run("second")
    expect(result.after).toEqual({ body: "# second\n", data: { title: "Post second" } })
    expect(result.ids).toEqual(["hello", "second"])
  }, 180_000)

})
