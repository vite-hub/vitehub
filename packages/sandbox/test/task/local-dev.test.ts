import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"
import { createServer, createServerModuleRunner } from "vite"

import { hubSandboxTask } from "../../src/task/vite.ts"

import type { AgentSandboxTaskConfig } from "../../src/task/module-types.ts"

const roots: string[] = []

afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function createApp() {
  const root = await mkdtemp(join(import.meta.dirname, ".vitest-tmp-local-dev-"))
  roots.push(root)
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "local-dev-fixture", private: true, type: "module" }))
  await symlink(resolve(import.meta.dirname, "../../../../node_modules"), join(root, "node_modules"), "junction")
  await mkdir(join(root, "src"))
  await writeFile(join(root, "src/release-notes.sandbox-task.ts"), [
    `import { defineSandboxTask } from "@vite-hub/sandbox/task"`,
    `export default defineSandboxTask({`,
    `  timeout: 20000,`,
    `  env: { HOME: '/tmp/tool-home', APP_HOME: 'release-notes' },`,
    `  handler: async ({ notes }: { notes: string }) => ({ items: notes.split("\\n"), pid: process.pid, home: process.env.HOME, appHome: process.env.APP_HOME }),`,
    `})`,
    ``,
  ].join("\n"))
  return root
}

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
  it.skipIf(process.platform === "win32").each(["cloudflare", "vercel"] as const)("runs a %s Sandbox Task as a local process", async (driver) => {
    const temp = await mkdtemp(join(tmpdir(), "sandbox#task-"))
    roots.push(temp)
    vi.stubEnv("TMPDIR", temp)
    const app = await startDevApp({ driver, networkPolicy: "allow-all" })
    try {
      const runner = await app.task.resolveSandboxTaskRunner("release-notes")
      expect(runner.executionAuthority).toMatchObject({ isolation: "none", filesystem: { scope: "host" } })

      const [error, result] = await app.task.runSandboxTask("release-notes", { notes: "Added digest\nFixed invite" })
      expect(error?.cause ?? error).toBeUndefined()
      expect(result).toMatchObject({
        items: ["Added digest", "Fixed invite"],
        pid: expect.any(Number),
        home: "/tmp/tool-home",
        appHome: "release-notes",
      })
      expect(result).not.toMatchObject({ pid: process.pid })
    }
    finally {
      await app.close()
    }
  }, 60_000)

  it.skipIf(process.platform === "win32").each([
    { driver: "cloudflare", networkPolicy: "deny-all" },
    { driver: "cloudflare", networkPolicy: { allow: ["example.org"] } },
    { driver: "vercel", networkPolicy: { subnets: { deny: ["10.0.0.0/8"] } } },
  ] as const)("rejects a restrictive $driver network policy in local dev: $networkPolicy", async (config) => {
    const app = await startDevApp(config)
    try {
      await expect(app.task.resolveSandboxTaskRunner("release-notes")).rejects.toMatchObject({
        code: "SANDBOX_TASK_LOCAL_NETWORK_POLICY",
        fix: expect.stringContaining("remote: true"),
      })
      const [error] = await app.task.runSandboxTask("release-notes", { notes: "Added digest" })
      expect(error).toMatchObject({ status: 500, data: { code: "SANDBOX_TASK_LOCAL_NETWORK_POLICY" } })
    }
    finally {
      await app.close()
    }
  }, 60_000)

  it.skipIf(process.platform !== "win32")("rejects local dev on native Windows before starting a task", async () => {
    await expect(startDevApp({ driver: "vercel" })).rejects.toMatchObject({
      code: "SANDBOX_TASK_LOCAL_WINDOWS",
      fix: expect.stringContaining("WSL"),
    })
  })

  it("uses the host's Sandbox with remote: true", async () => {
    const app = await startDevApp({ driver: "cloudflare", remote: true })
    try {
      const [error] = await app.task.runSandboxTask("release-notes", { notes: "Added digest" })
      expect(error).toMatchObject({ status: 500, data: { code: "SANDBOX_TASK_R0071" } })
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
    expect(facade).not.toContain("setSandboxTaskRuntimeLocalProvider")
    expect(facade).not.toContain("providers/local")
  })
})
