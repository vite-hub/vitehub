import { afterEach, describe, expect, it, vi } from "vitest"

const vercel = vi.hoisted(() => ({
  createOptions: [] as Array<{ timeout?: number }>,
  setupLatency: 0,
}))

/**
 * A fake Vercel VM. Its clock starts at `create`, like the real one, and every setup
 * call takes `setupLatency`. Once the VM timeout passes, Vercel stops the VM: the
 * running command ends with exit code 143 and its output file is gone.
 */
vi.mock("@vercel/sandbox", () => ({
  Sandbox: {
    async create(options: { timeout?: number }) {
      vercel.createOptions.push(options)
      const stopsAt = Date.now() + (options.timeout ?? 300_000)
      const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
      const stopped = () => delay(Math.max(0, stopsAt - Date.now()))
      return {
        domain: () => "https://sandbox.example.com",
        async mkDir() { await delay(vercel.setupLatency) },
        async readFileToBuffer() { return null },
        async runCommand({ args }: { args: string[] }) {
          const handler = args[1]?.includes("import(process.argv[1])")
          const exit = handler ? stopped().then(() => ({ exitCode: 143 })) : delay(vercel.setupLatency).then(() => ({ exitCode: 0 }))
          return {
            async closeStdin() {},
            async kill() {},
            async *logs() {},
            async stderr() { await exit; return "" },
            async stdout() { await exit; return "" },
            async wait() { return await exit },
            async writeStdin() {},
          }
        },
        async stop() {},
        async writeFiles() { await delay(vercel.setupLatency) },
      }
    },
  },
}))

vi.mock("#vitehub-sandbox-task-provider-loader", async () => {
  const { resolveVercelTaskSandbox } = await import("../../src/task/runtime/providers/vercel.ts")
  return { loadSandboxTaskRuntimeProvider: async () => ({ resolveTaskSandbox: resolveVercelTaskSandbox }) }
})

import { runSandboxTaskRuntime } from "../../src/task/runtime/runtime.ts"
import { resetSandboxTaskRuntimeState, setSandboxTaskRuntimeConfig, setSandboxTaskRuntimeRegistry } from "../../src/task/runtime/state.ts"

afterEach(() => {
  resetSandboxTaskRuntimeState()
  vercel.createOptions.length = 0
  vercel.setupLatency = 0
})

describe("Vercel Sandbox Task timeout", () => {
  it("reports a task timeout as SANDBOX_TASK_TIMEOUT when Sandbox setup takes time", async () => {
    vercel.setupLatency = 60
    setSandboxTaskRuntimeConfig({ provider: "vercel", token: "token", teamId: "team", projectId: "project" })
    setSandboxTaskRuntimeRegistry({
      slow: {
        bundle: { entry: "index.mjs", modules: { "index.mjs": "export default () => new Promise(() => {})" } },
        options: { timeout: 1_000 },
      },
    })

    const response = await runSandboxTaskRuntime("slow")

    expect(response.status).toBe(504)
    expect(await response.json()).toMatchObject({ error: { code: "SANDBOX_TASK_TIMEOUT" } })
    expect(vercel.createOptions[0]?.timeout).toBe(31_000)
  })
})
