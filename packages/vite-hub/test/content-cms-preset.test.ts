import { readFile, readdir, rm } from "node:fs/promises"
import { delimiter, join } from "node:path"
import { pathToFileURL } from "node:url"

import { build, createServer, resolveConfig, type PluginOption } from "vite"
import { describe, expect, it, vi } from "vitest"

import { vitehub } from "../src/index.ts"
import { contentDefinition, createProject, path, runCli, server, serverBuild, type RunResult } from "./support/content-cms.ts"

function project(extra: Record<string, string> = {}) {
  return createProject({
    "package.json": JSON.stringify({ name: "content-cms-fixture", private: true, type: "module" }),
    ".data/.keep": "",
    "server/databases/config.ts": [
      "import { defineDatabase } from 'vite-hub/database'",
      "export default defineDatabase({ connection: { url: 'file:<root>/.data/content.db' }, schema: {} })",
      "",
    ].join("\n"),
    "server/content.ts": contentDefinition,
    "src/server.ts": server,
    ...extra,
  })
}

function plugins(root: string, options: Record<string, unknown> = {}): PluginOption[] {
  return vitehub({
    preset: "node",
    env: false,
    database: true,
    workspace: true,
    blob: { stores: { default: { driver: "fs", base: join(root, ".data/blob") } } },
    ...options,
  })
}

/** Lists the Cloudflare resources that `vitehub provision run --dry-run` plans, against an empty stubbed account. */
async function plannedCloudflareResources(root: string, pluginOptions: PluginOption[]) {
  vi.stubGlobal("fetch", async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input)
    return Response.json({ result: new URL(url).pathname.endsWith("/r2/buckets") ? { buckets: [] } : [], success: true })
  })
  process.env.CLOUDFLARE_ACCOUNT_ID = "account"
  process.env.CLOUDFLARE_API_TOKEN = "token"
  try {
    const result = await runCli(root, pluginOptions, ["provision", "run", "--provider", "cloudflare", "--dry-run", "--json"])
    expect(result.exitCode).toBe(0)
    const plan = JSON.parse(result.stdout) as { actions?: Array<{ kind: string, name: string }>, steps?: unknown }
    return plan
  }
  finally {
    delete process.env.CLOUDFLARE_ACCOUNT_ID
    delete process.env.CLOUDFLARE_API_TOKEN
  }
}

describe("Content cms preset on libSQL", () => {
  it("generates the history tables, then saves, publishes, and reads in dev and in a build", async () => {
    const root = await project()
    const appPlugins = plugins(root)
    // `vitehub db` runs drizzle-kit from the app's dependencies.
    process.env.PATH = `${join(import.meta.dirname, "../node_modules/.bin")}${delimiter}${path}`

    const generate = await runCli(root, appPlugins, ["db", "generate"])
    expect(generate.stderr).toBe("")
    expect(generate.exitCode).toBe(0)
    const migrationsDir = join(root, "server/databases/migrations")
    const migration = (await readdir(migrationsDir)).find(file => file.endsWith(".sql"))!
    const sql = await readFile(join(migrationsDir, migration), "utf8")
    expect(sql.match(/CREATE TABLE `\w+`/g)?.toSorted()).toEqual([
      "CREATE TABLE `workspace_history_metadata`",
      "CREATE TABLE `workspace_history_objects`",
      "CREATE TABLE `workspace_history_refs`",
      "CREATE TABLE `workspace_history_revisions`",
      "CREATE TABLE `workspace_history_workspaces`",
    ])
    const migrate = await runCli(root, appPlugins, ["db", "migrate"])
    expect(migrate.stderr).toBe("")
    expect(migrate.exitCode).toBe(0)

    const dev = await createServer({ ...serverBuild(root, plugins(root)), server: { middlewareMode: true, watch: null } })
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

    await build(serverBuild(root, plugins(root)))
    // The build loaded the generated Workspace module to bundle its assets, without a Database runtime.
    expect(await readFile(join(root, ".vitehub/vite-runtime/workspace/assets/registry.mjs"), "utf8")).toContain("[\"content\"]: createWorkspaceAssets(")
    const output = (await readdir(join(root, "dist"))).find(file => /^server\.m?js$/.test(file))!
    // SAFETY: The built entry exports run() with the RunResult shape.
    const built = await import(pathToFileURL(join(root, "dist", output)).href) as { run: (id: string) => Promise<RunResult> }
    const result = await built.run("second")
    expect(result.after).toEqual({ body: "# second\n", data: { title: "Post second" } })
    // The build reads what the dev server published from the same Database and Blob store.
    expect(result.ids).toEqual(["hello", "second"])
  }, 120_000)

  it("names the setting to change when a required feature is off", async () => {
    const root = await project()
    await expect(resolveConfig(serverBuild(root, plugins(root, { workspace: false })), "build"))
      .rejects.toThrow("uses the Content cms preset: it needs workspace enabled. Set vitehub({ workspace: true }) in your Vite config.")
    await expect(resolveConfig(serverBuild(root, plugins(root, { blob: false })), "build"))
      .rejects.toThrow("uses the Content cms preset: it needs blob enabled. Set vitehub({ blob: true }) in your Vite config.")
  }, 60_000)

  it("fails when the Database choice is ambiguous and names the preset option", async () => {
    const root = await project({
      "server/databases/config.ts": "",
      "server/databases/blog/config.ts": "import { defineDatabase } from 'vite-hub/database'\nexport default defineDatabase({ name: 'blog', schema: {} })\n",
      "server/databases/audit/config.ts": "import { defineDatabase } from 'vite-hub/database'\nexport default defineDatabase({ name: 'audit', schema: {} })\n",
    })
    await rm(join(root, "server/databases/config.ts"))
    await expect(resolveConfig(serverBuild(root, plugins(root)), "build"))
      .rejects.toThrow("it needs one Database, but the app has several and none is named \"default\": \"audit\", \"blog\". Choose one with extends: [cms, { database: \"audit\" }].")
  }, 60_000)
})

// The dev server and build of the zero-config app run in content-cms-preset-zero-config.test.ts, in their own
// process, because Workspace and Database runtime state is process-wide.
describe("Content cms preset with only server/content.ts", () => {
  it("plans the same Cloudflare resources as the explicit setup", async () => {
    const zeroConfig = await createProject({
      "package.json": JSON.stringify({ name: "content-cms-zero-config", private: true, type: "module" }),
      "server/content.ts": contentDefinition,
    })
    const explicit = await createProject({
      "package.json": JSON.stringify({ name: "content-cms-zero-config", private: true, type: "module" }),
      "server/content.ts": contentDefinition,
      "server/databases/config.ts": "import { defineDatabase } from 'vite-hub/database'\nexport default defineDatabase({ schema: {} })\n",
    })
    const zeroPlan = await plannedCloudflareResources(zeroConfig, vitehub({ preset: "cloudflare", env: false }))
    const explicitPlan = await plannedCloudflareResources(explicit, vitehub({ preset: "cloudflare", env: false, database: true, blob: true, workspace: true }))
    expect(zeroPlan).toEqual(explicitPlan)
    expect(zeroPlan.actions?.map(action => action.kind)).toEqual(["cloudflare-r2-bucket"])

    // The preset's Database is planned like an app Definition once D1 is named.
    const d1Plan = await plannedCloudflareResources(zeroConfig, vitehub({ preset: "cloudflare", env: false, database: { driver: "d1", databaseName: "cms-db" } }))
    expect(d1Plan.actions?.map(action => `${action.kind} ${action.name}`).toSorted()).toEqual(["cloudflare-d1 cms-db", "cloudflare-r2-bucket content-cms-zero-config"])
  }, 60_000)

  it("keeps an explicitly disabled feature off and names it", async () => {
    const root = await createProject({
      "package.json": JSON.stringify({ name: "content-cms-zero-config", private: true, type: "module" }),
      "server/content.ts": contentDefinition,
    })
    await expect(resolveConfig(serverBuild(root, vitehub({ preset: "node", env: false, workspace: false })), "build"))
      .rejects.toThrow("uses the Content cms preset: it needs workspace enabled. Set vitehub({ workspace: true }) in your Vite config.")
  }, 60_000)

  it("leaves apps without the preset unchanged", async () => {
    const root = await createProject({
      "package.json": JSON.stringify({ name: "content-plain", private: true, type: "module" }),
    })
    const config = await resolveConfig(serverBuild(root, vitehub({ preset: "node", env: false })), "build")
    const names = config.plugins.map(plugin => plugin.name)
    expect(names).not.toContain("@vite-hub/database/vite")
    expect(names).not.toContain("@vite-hub/workspace/vite")
    expect(names).not.toContain("@vite-hub/blob/vite")
    expect(names).toContain("@vite-hub/content/vite")
    expect(names.filter(name => name === "@vite-hub/content/vite")).toHaveLength(1)
  }, 60_000)
})
