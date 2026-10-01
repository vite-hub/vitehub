import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { collectViteHubDefinitionInspectors } from "@vite-hub/internal/inspect"
import { resolveConfig } from "vite"
import { afterEach, describe, expect, it } from "vitest"

import { discoverConsoleBuildCatalog } from "../src/console/build.ts"
import { vitehub } from "../src/index.ts"

import type { ConsoleSectionCatalog } from "../src/console/runtime/definitions.ts"

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map(dir => rm(dir, { force: true, recursive: true })))
})

async function writeProjectFile(root: string, file: string, contents: string) {
  await mkdir(join(root, file, ".."), { recursive: true })
  await writeFile(join(root, file), contents)
}

const sectionByKind = {
  database: "databases",
  queue: "queues",
  "rate-limit": "rate-limits",
  sandbox: "sandboxes",
  schedule: "schedules",
  workflow: "workflows",
  workspace: "workspaces",
} as const satisfies Record<string, keyof ConsoleSectionCatalog["content"]>

describe("Definition inspection parity", () => {
  it("lists the same Definitions in `vitehub inspect` and the Console", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-inspect-parity-"))
    directories.push(root)
    await writeProjectFile(root, "package.json", "{}\n")
    await writeProjectFile(root, "server/databases/config.ts", "export default defineDatabase({ schema: { notes } })\n")
    await writeProjectFile(root, "server/queues/email.ts", "export default defineQueue({ handler() {} })\n")
    await writeProjectFile(root, "server/api/login.post.ts", 'export default defineHandler(async (event) => { await requireRateLimit(event, "login", { limit: 5, window: "1m" }) })\n')
    await writeProjectFile(root, "src/runner.sandbox.ts", "export default defineSandbox({ run: async () => ({}) })\n")
    await writeProjectFile(root, "server/schedules/adhoc.ts", "export default defineScheduleTarget({ handler() {} })\n")
    await writeProjectFile(root, "server/workflows/welcome.ts", "export default defineWorkflow(async () => {})\n")
    await writeProjectFile(root, "server/workspaces/docs/config.ts", "export default defineWorkspace({ store: { provider: 'memory' } })\n")

    const config = await resolveConfig({
      logLevel: "silent",
      plugins: [vitehub({ blob: false, console: false, database: true, env: false, preset: "cloudflare", queue: true, rateLimit: true, sandbox: true, schedule: true, workflow: true, workspace: true })],
      root,
    }, "build")
    const inspectors = await collectViteHubDefinitionInspectors(config.plugins)
    const catalog = await discoverConsoleBuildCatalog({
      discoveryRoot: root,
      projectRoot: root,
      sections: Object.values(sectionByKind),
    })

    for (const [kind, section] of Object.entries(sectionByKind)) {
      const inspector = inspectors.find(candidate => candidate.kind === kind)
      expect(inspector, `Expected a ${kind} inspector`).toBeDefined()
      const listed = await inspector!.list()
      expect(listed.length, `Expected ${kind} Definitions`).toBeGreaterThan(0)
      expect(catalog.content[section]?.kind, kind).toBe("definition-catalog")
      expect({ definitions: listed, kind: "definition-catalog" }, kind).toEqual(catalog.content[section])
    }
  }, 60_000)
})
