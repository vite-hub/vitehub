import { ref } from "vue"
import { groupConsoleEnv } from "../src/console/runtime/client/env-groups.ts"
import { indexEnvStatuses } from "../src/console/runtime/client/env-status.ts"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, afterEach, describe, expect, it, vi } from "vitest"
import { consoleStateKey } from "../src/console/internal.ts"
import { writeConsoleNitroPlugin } from "../src/console/plugin.ts"
import { installConsoleEnv } from "../src/console/runtime/server/env.ts"
import { installConsoleSections } from "../src/console/runtime/server/sections.ts"
import envHandlerRoute from "../src/console/runtime/server/env.get.ts"
import { allowed } from "./support/console-access.ts"
import { consoleEvent } from "./console-event.ts"

const temporaryDirectories: string[] = []

afterAll(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { force: true, recursive: true })))
})

async function temporaryDirectory(prefix: string) {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  temporaryDirectories.push(directory)
  return directory
}

const envHandler = allowed(envHandlerRoute)

afterEach(() => { Reflect.deleteProperty(globalThis, consoleStateKey) })

describe("Console Env", () => {
  it("loads declaration metadata without importing provider-backed Server Env", async () => {
    const root = await temporaryDirectory("vitehub-console-env-")
    const plugin = join(root, "console.mjs")
    await writeConsoleNitroPlugin({ file: plugin, projectRoot: root, sections: ["env"], catalog: { agents: [], content: {} }, blobStores: [] })
    const generated = await readFile(plugin, "utf8")
    // The Console runtime loads the declarations with the first Console request.
    const runtimeImports = generated.split("\n").find(line => line.includes("await Promise.all("))
    expect(runtimeImports).toContain('import("#vitehub/env/description")')
    expect(runtimeImports).not.toContain('"#vitehub/env/server"')
    expect(generated).not.toContain('from "#vitehub/env/server"')
    // Status inspection can call providers, so the plugin imports it only on request.
    expect(generated).toContain('async () => (await import("#vitehub/env/server")).inspectServerEnv()')
  })
  it("retains distinct pathless statuses through reactive row filtering", () => {
    const descriptions = ref([
      { source: "env" as const, secret: true, required: true, hasDefault: false },
      { path: "env.server.public", source: "literal" as const, secret: false, required: false, hasDefault: false },
      { source: "provider" as const, secret: true, required: false, hasDefault: false },
    ])
    const statuses = ref(indexEnvStatuses(descriptions.value, [
      { blocking: true, status: "missing" },
      { blocking: false, path: "env.server.public", status: "available" },
      { blocking: false, status: "error" },
    ]))
    const filtered = descriptions.value.filter(entry => !entry.path)
    expect(filtered.map(entry => statuses.value.get(entry))).toEqual([{ blocking: true, status: "missing" }, { blocking: false, status: "error" }])
  })

  it("groups declarations by namespace and folds one-value namespaces into Other", () => {
    const entry = (path?: string) => ({ ...(path ? { path: `env.server.${path}` } : {}), source: "env" as const, secret: false, required: true, hasDefault: false })
    const groups = groupConsoleEnv([
      entry("logLevel"),
      entry("executor.url"),
      entry("github.token"),
      entry("labeller.dryRun"),
      entry("executor.apiKey"),
      entry(),
      entry("labeller.labels.GitHub.color.textColor"),
      entry("appName"),
    ])
    expect(groups.map(group => [group.name, group.rows.map(row => `${row.parent}${row.name}`)])).toEqual([
      ["executor", ["url", "apiKey"]],
      ["labeller", ["dryRun", "labels.GitHub.color.textColor"]],
      ["", ["logLevel", "github.token", "appName"]],
      [undefined, [""]],
    ])
  })
  it("serves declaration metadata and rejects mutations", async () => {
    installConsoleSections("/env-test", ["env"])
    const metadata = { entries: [{ path: "env.server.token", source: "provider" as const, provider: "vault", secret: true, required: true, hasDefault: false, type: "string" }, { path: "env.server.dryRun", source: "env" as const, secret: false, required: true, hasDefault: true, type: "boolean" }] }
    installConsoleEnv("/env-test", metadata)
    await expect(envHandler(consoleEvent({ method: "GET", url: "http://localhost/_vitehub/api/env" }))).resolves.toEqual(metadata)
    await expect(envHandler(consoleEvent({ method: "POST", url: "http://localhost/_vitehub/api/env" }))).rejects.toThrow("Method not allowed")
  })
  it("loads status only on request and never returns values", async () => {
    installConsoleSections("/env-test", ["env"])
    const metadata = { entries: [
      { path: "env.server.token", source: "provider" as const, provider: "vault", secret: true, required: true, hasDefault: false },
      { path: "env.server.label", source: "env" as const, secret: false, required: false, hasDefault: false },
      { source: "provider" as const, provider: "vault", secret: true, required: true, hasDefault: false },
    ] }
    const inspect = vi.fn(async () => ({ entries: [
      { masked: true, path: "env.server.token", provider: "vault", required: true, source: "provider" as const, status: "error" as const },
      { masked: false, path: "env.server.label", required: false, source: "env" as const, status: "missing" as const },
      { masked: true, provider: "vault", required: true, source: "provider" as const, status: "missing" as const },
    ] }))
    installConsoleEnv("/env-test", metadata, inspect)
    await expect(envHandler(consoleEvent({ method: "GET", url: "http://localhost/_vitehub/api/env" }))).resolves.toEqual(metadata)
    expect(inspect).not.toHaveBeenCalled()
    await expect(envHandler(consoleEvent({ url: "/_vitehub/api/env?status=1" }))).resolves.toEqual({
      ...metadata,
      status: [
        { blocking: true, path: "env.server.token", status: "error" },
        { blocking: false, path: "env.server.label", status: "missing" },
        { blocking: true, status: "missing" },
      ],
    })
    expect(inspect).toHaveBeenCalledOnce()
    expect(inspect).toHaveBeenCalledWith(expect.objectContaining({ "~standard": expect.objectContaining({ req: expect.objectContaining({ method: "GET" }) }) }))
  })
  it("hides status failures behind a fixed message", async () => {
    installConsoleSections("/env-test", ["env"])
    const statusEvent = consoleEvent({ url: "/_vitehub/api/env?status=1" })
    installConsoleEnv("/env-test", { entries: [] })
    await expect(envHandler(statusEvent)).rejects.toMatchObject({ statusCode: 503, statusMessage: "Env status is unavailable." })
    installConsoleEnv("/env-test", { entries: [] }, async () => { throw new Error("private provider detail") })
    await expect(envHandler(statusEvent)).rejects.toMatchObject({ statusCode: 503, statusMessage: "Env status is unavailable." })
  })
  it("rejects requests when Env is disabled", async () => {
    installConsoleSections("/env-test", [])
    await expect(envHandler(consoleEvent({ method: "GET", url: "http://localhost/_vitehub/api/env" }))).rejects.toThrow("Env section not found")
  })
})
