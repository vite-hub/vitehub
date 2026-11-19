import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"

import { afterEach, describe, expect, it } from "vitest"
import { createServer, createServerModuleRunner } from "vite"

import { hubSandboxTask } from "../../src/task/vite.ts"

import type { AgentSandboxTaskConfig } from "../../src/task/module-types.ts"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function createApp() {
  const root = await mkdtemp(join(import.meta.dirname, ".vitest-tmp-local-dev-"))
  roots.push(root)
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "local-dev-fixture", private: true, type: "module" }))
  await symlink(resolve(import.meta.dirname, "../../../../node_modules"), join(root, "node_modules"), "dir")
  await mkdir(join(root, "src"))
  await writeFile(join(root, "src/release-notes.sandbox-task.ts"), [
    `import { defineSandboxTask } from "@vite-hub/sandbox/task"`,
    `export default defineSandboxTask({`,
    `  timeout: 20000,`,
    `  handler: async ({ notes }: { notes: string }) => ({ items: notes.split("\\n"), pid: process.pid }),`,
    `})`,
    ``,
  ].join("\n"))
  return root
}

// A real `vite dev` server of an app with one Sandbox Task, and no Cloudflare binding or Vercel credentials.
async function startDevApp(config: AgentSandboxTaskConfig) {
  const root = await createApp()
  const server = await createServer({
    configFile: false,
    logLevel: "silent",
    plugins: [hubSandboxTask(config)],
    root,
    server: { middlewareMode: true, ws: false },
  })
  const runner = createServerModuleRunner(server.environments.ssr, { hmr: false })
  // Nitro and `vite-hub` alias `@vite-hub/sandbox/task` to this generated dev facade. Plain Vite has no server alias.
  const task: typeof import("../../src/task/index.ts") = await runner.import(join(root, ".vitehub/sandbox-task/runtime/sandbox-task.mjs"))
  return {
    task,
    async close() {
      await runner.close()
      await server.close()
    },
  }
}

describe("Sandbox Tasks in vite dev", () => {
  it.each(["cloudflare", "vercel"] as const)("runs a %s Sandbox Task as a local process", async (driver) => {
    const app = await startDevApp({ driver })
    try {
      const runner = await app.task.resolveSandboxTaskRunner("release-notes")
      expect(runner.executionAuthority).toMatchObject({ isolation: "none", filesystem: { scope: "host" } })

      const response = await app.task.runSandboxTask("release-notes", { notes: "Added digest\nFixed invite" })
      const result = await response.json() as { items: string[], pid: number }
      expect(response.status, JSON.stringify(result)).toBe(200)
      expect(result.items).toEqual(["Added digest", "Fixed invite"])
      expect(result.pid).not.toBe(process.pid)
    }
    finally {
      await app.close()
    }
  }, 60_000)

  it("uses the host's Sandbox with remote: true", async () => {
    const app = await startDevApp({ driver: "cloudflare", remote: true })
    try {
      const response = await app.task.runSandboxTask("release-notes", { notes: "Added digest" })
      expect(response.status).toBe(500)
      expect(await response.json()).toMatchObject({ error: { code: "SANDBOX_TASK_R0071" } })
    }
    finally {
      await app.close()
    }
  }, 60_000)

  it("leaves the local provider out of a build", async () => {
    const root = await createApp()
    const plugin = hubSandboxTask({ driver: "vercel" })
    const config = plugin.config as (config: Record<string, unknown>, env: { command: "build", mode: string }) => Promise<unknown>
    const configResolved = plugin.configResolved as unknown as (config: { root: string, resolve: { alias: [] } }) => Promise<unknown>
    await config({ root }, { command: "build", mode: "production" })
    await configResolved({ root, resolve: { alias: [] } })

    const facade = await readFile(join(root, ".vitehub/sandbox-task/runtime/sandbox-task.mjs"), "utf8")
    expect(facade).toContain("setSandboxTaskRuntimeDevelopment(false)")
    expect(facade).not.toContain("providers/local")
  })
})
