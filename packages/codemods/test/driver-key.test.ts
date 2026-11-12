import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import { describe, expect, it } from "vitest"

import { formatReport, runCodemod } from "../src/index.ts"

const fixture = fileURLToPath(new URL("./fixtures/driver-key/", import.meta.url))

async function migrateSource(file: string, source: string) {
  const cwd = await mkdtemp(join(tmpdir(), "vitehub-driver-key-"))
  try {
    await writeFile(join(cwd, file), source)
    return (await runCodemod("driver-key", { cwd, dryRun: true })).result
  }
  finally {
    await rm(cwd, { recursive: true, force: true })
  }
}

describe("driver-key", () => {
  it("renames backend keys to driver and host driver values in an app", async () => {
    const input = join(fixture, "input")
    const run = await runCodemod("driver-key", { cwd: input, dryRun: true })
    for (const edit of run.result.edits) {
      expect(edit.before).toBe(await readFile(join(input, edit.path), "utf8"))
      await expect(edit.after).toMatchFileSnapshot(join(fixture, "output", edit.path))
    }
    expect(run.result.edits.map(edit => edit.path)).not.toContain("app/app.config.ts")
    await expect(formatReport(run)).toMatchFileSnapshot(join(fixture, "output", "report.txt"))
  })

  it("leaves a key that already reads driver and reports a config that sets both", async () => {
    const result = await migrateSource("vite.config.ts", "import { defineConfig } from 'vite'\nexport default defineConfig({ queue: { provider: 'vercel', driver: 'cloudflare' } })\n")
    expect(result.edits).toEqual([])
    expect(result.followUps).toEqual([{ file: "vite.config.ts", line: 2, message: "`queue` sets both `provider` and `driver`. Keep one `driver`." }])
  })

  it.each([
    ["", '"vite-hub/nuxt"'],
    ['import hub from "vite-hub/nuxt"', "hub"],
    ['import { default as hub } from "vite-hub/nuxt"', "hub"],
    ['import * as hub from "vite-hub/nuxt"', "hub.default"],
  ])("migrates inline Nuxt module options with %s %s", async (imports, module) => {
    const source = `${imports}
export default defineNuxtConfig({
  modules: [[${module}, {
    workflow: { provider: "openworkflow" },
    realtime: { authority: "memory" },
    workspace: { store: { provider: "cloudflare-artifacts" } },
    blob: { driver: "vercel-blob" },
  }], ["other-module", { workflow: { provider: "memory" } }]],
  vitehub: { queue: { provider: "cloudflare" } },
})
`
    const result = await migrateSource("nuxt.config.ts", source)
    const after = result.edits[0]?.after
    expect(after).toContain('workflow: { driver: "openworkflow" }')
    expect(after).toContain('realtime: { driver: "memory" }')
    expect(after).toContain('workspace: { store: { driver: "cloudflare" } }')
    expect(after).toContain('blob: { driver: "vercel" }')
    expect(after).toContain('queue: { driver: "cloudflare" }')
    expect(after).toContain('["other-module", { workflow: { provider: "memory" } }]')
    expect(result.followUps).toEqual([])
    const repeated = await migrateSource("nuxt.config.ts", after!)
    expect(repeated.edits).toEqual([])
  })

  it("leaves unrelated and shadowed Nuxt module imports unchanged", async () => {
    const source = `
import { defineNuxtConfig } from "nuxt/config"
import hub from "other-module"
import viteHubNuxt from "vite-hub/nuxt"
export default defineNuxtConfig({ modules: [[hub, { workflow: { provider: "memory" } }]] })
function config(viteHubNuxt) {
  return defineNuxtConfig({ modules: [[viteHubNuxt, { workflow: { provider: "memory" } }]] })
}
`
    expect((await migrateSource("nuxt.config.ts", source)).edits).toEqual([])
  })

  it("keeps a store whose provider is not a Workspace Store driver", async () => {
    const result = await migrateSource("utils.ts", "export const cache = { store: { provider: 'redis' } }\n")
    expect(result.edits).toEqual([])
  })

  it("leaves unrelated APIs and Workspace-like data unchanged", async () => {
    const result = await migrateSource("vite.config.ts", `
import { createBrowser, createEmail, hubQueue, defineConfig } from "other-library"
const api = { createBrowser() {}, hubQueue() {} }
createBrowser({ provider: "local" })
createEmail({ driver: "cloudflare-email" })
hubQueue({ provider: "memory" })
api.createBrowser({ provider: "local" })
api.hubQueue({ provider: "memory" })
defineConfig({ queue: { provider: "memory" } })
const data = { vitehub: { queue: { provider: "memory" } }, checkout: { store: { provider: "github" } } }
const cache = { store: { provider: "memory" } }
`)
    expect(result.edits).toEqual([])
  })

  it("resolves aliases and namespace imports of the owning APIs", async () => {
    const result = await migrateSource("utils.ts", `
import { vitehub as hub } from "vite-hub"
import { createBrowser as browser } from "vite-hub/browser"
import { createQueueClient as queue } from "@vite-hub/queue"
import { defineWorkspace as workspace } from "@vite-hub/workspace"
import * as email from "@vite-hub/email"
hub({ queue: { provider: "memory" }, workspace: { store: { provider: "vercel-blob" } } })
browser({ provider: localBrowser() })
queue({ provider: "cloudflare" })
workspace({ store: { provider: "github" } })
email.createEmail({ driver: "cloudflare-email" })
`)
    const after = result.edits[0]?.after
    expect(after).toContain('queue: { driver: "memory" }')
    expect(after).toContain('store: { driver: "vercel" }')
    expect(after).toContain('browser({ driver: localBrowser() })')
    expect(after).toContain('queue({ driver: "cloudflare" })')
    expect(after).toContain('store: { driver: "github" }')
    expect(after).toContain('email.createEmail({ driver: "cloudflare" })')
  })

  it.each(["@vite-hub/agent", "vite-hub/agent"])("migrates only Workspace stores in Agent Definitions from %s", async (source) => {
    const result = await migrateSource("agent.ts", `
import { defineAgent as agent } from "${source}"
import * as agents from "${source}"
agent({
  workspace: { store: { provider: "memory" } },
  providers: { sandbox: { provider: "vercel" } },
  store: { provider: "memory" },
})
agents.defineAgent({ workspace: { store: { provider: "cloudflare-artifacts" } } })
`)
    const after = result.edits[0]?.after
    expect(after).toContain('workspace: { store: { driver: "memory" } }')
    expect(after).toContain('workspace: { store: { driver: "cloudflare" } }')
    expect(after).toContain('providers: { sandbox: { provider: "vercel" } }')
    expect(after).toContain('  store: { provider: "memory" }')
    expect(result.followUps).toEqual([])
  })

  it("leaves unrelated and shadowed Agent Definitions unchanged", async () => {
    const result = await migrateSource("agent.ts", `
import { defineAgent } from "other-library"
import { defineAgent as agent } from "@vite-hub/agent"
defineAgent({ workspace: { store: { provider: "memory" } } })
function make(agent) { return agent({ workspace: { store: { provider: "memory" } } }) }
`)
    expect(result.edits).toEqual([])
  })

  it("leaves local functions and shadowed imports unchanged", async () => {
    const result = await migrateSource("utils.ts", `
import { createBrowser as browser } from "vite-hub/browser"
import * as queue from "@vite-hub/queue/vite"
function createEmail(options) { return options }
createEmail({ driver: "cloudflare-email" })
function useBrowser(browser) { return browser({ provider: "local" }) }
function useQueue({ queue }) { return queue.hubQueue({ provider: "memory" }) }
function make() {
  const hubQueue = options => options
  return hubQueue({ provider: "memory" })
}
`)
    expect(result.edits).toEqual([])
  })
})
