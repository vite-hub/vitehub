import { ref } from "vue"
import { groupConsoleEnv } from "../src/console/runtime/client/env-groups.ts"
import { indexEnvStatuses } from "../src/console/runtime/client/env-status.ts"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, afterEach, describe, expect, it } from "vitest"
import { consoleStateKey } from "../src/console/internal.ts"
import { writeConsoleAppModule } from "../src/console/app-module.ts"
import { installConsoleEnv } from "../src/console/runtime/server/env.ts"
import { installConsoleSections } from "../src/console/runtime/server/sections.ts"
import envHandlerRoute from "../src/env/console/env.get.ts"
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
    await writeConsoleAppModule({ file: plugin, projectRoot: root, sections: ["env"], catalog: { agents: [], content: {} }, blobStores: [] })
    const generated = await readFile(plugin, "utf8")
    // The Console runtime loads the declarations with the first Console request.
    const runtimeImports = generated.split("\n").find(line => line.includes("await Promise.all("))
    expect(runtimeImports).toContain('import("#vitehub/env/description")')
    expect(runtimeImports).not.toContain('"#vitehub/env/server"')
    expect(generated).not.toContain('from "#vitehub/env/server"')
    // Status comes from the env.inspect operation of Env, so the Console does not load Server Env itself.
    expect(generated).not.toContain("#vitehub/env/server")
  })
  it("retains distinct pathless statuses through reactive row filtering", () => {
    const descriptions = ref([
      { source: "env" as const, secret: true, required: true, hasDefault: false },
      { path: "env.server.public", source: "literal" as const, secret: false, required: false, hasDefault: false },
      { source: "provider" as const, secret: true, required: false, hasDefault: false },
    ])
    const status = (fields: { blocking: boolean, path?: string, source: "env" | "literal" | "provider", status: "available" | "error" | "missing" }) => ({ required: true, secret: false, ...fields })
    const statuses = ref(indexEnvStatuses(descriptions.value, [
      status({ blocking: true, source: "env", status: "missing" }),
      status({ blocking: false, path: "env.server.public", source: "literal", status: "available" }),
      status({ blocking: false, source: "provider", status: "error" }),
    ]))
    const filtered = descriptions.value.filter(entry => !entry.path)
    expect(filtered.map(entry => statuses.value.get(entry)?.status)).toEqual(["missing", "error"])
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
  it("answers no status, so values stay with the env.inspect operation of Env", async () => {
    installConsoleSections("/env-test", ["env"])
    const metadata = { entries: [{ path: "env.server.token", source: "env" as const, secret: true, required: true, hasDefault: false }] }
    installConsoleEnv("/env-test", metadata)
    await expect(envHandler(consoleEvent({ url: "/_vitehub/api/env?status=1" }))).resolves.toEqual(metadata)
  })
  it("rejects requests when Env is disabled", async () => {
    installConsoleSections("/env-test", [])
    await expect(envHandler(consoleEvent({ method: "GET", url: "http://localhost/_vitehub/api/env" }))).rejects.toThrow("Env section not found")
  })
})
