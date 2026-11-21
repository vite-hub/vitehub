import { afterEach, describe, expect, it, vi } from "vitest"

const vercel = vi.hoisted(() => ({
  createOptions: [] as Array<{ timeout?: number }>,
  setupLatency: 0,
  handlerStarted: false,
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
      if ((options.timeout ?? 0) > 45 * 60_000)
        throw new Error("Status code 400 is not ok: `timeout` restricted to <= 45m on Hobby plans")
      const stopsAt = Date.now() + (options.timeout ?? 300_000)
      const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
      const stopped = () => delay(Math.max(0, stopsAt - Date.now()))
      return {
        domain: () => "https://sandbox.example.com",
        async mkDir() { await delay(vercel.setupLatency) },
        async readFileToBuffer() { return null },
        async runCommand({ args }: { args: string[] }) {
          const handler = args[1]?.includes("import(process.argv[1])")
          if (handler) vercel.handlerStarted = true
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

function registerTask(options: { timeout?: number }) {
  setSandboxTaskRuntimeConfig({ driver: "vercel", token: "token", teamId: "team", projectId: "project" })
  setSandboxTaskRuntimeRegistry({
    slow: {
      bundle: { entry: "index.mjs", modules: { "index.mjs": "export default () => new Promise(() => {})" } },
      options,
    },
  })
}

afterEach(() => {
  vi.useRealTimers()
  resetSandboxTaskRuntimeState()
  vercel.createOptions.length = 0
  vercel.setupLatency = 0
  vercel.handlerStarted = false
})

describe("Vercel Sandbox Task timeout", () => {
  it("reports a task timeout as SANDBOX_TASK_TIMEOUT when Sandbox setup takes time", async () => {
    vercel.setupLatency = 60
    registerTask({ timeout: 1_000 })

    const response = await runSandboxTaskRuntime("slow")

    expect(response[0]?.status).toBe(504)
    expect(response[0]?.cause).toMatchObject({ code: "SANDBOX_TASK_TIMEOUT" })
    expect(vercel.createOptions[0]?.timeout).toBe(31_000)
  })

  it("ends a task with no timeout at the 5 minute default with SANDBOX_TASK_TIMEOUT", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
    vercel.setupLatency = 60
    registerTask({})

    let response: Awaited<ReturnType<typeof runSandboxTaskRuntime>> | undefined
    const pending = runSandboxTaskRuntime("slow").then(result => (response = result))
    // Wait for real setup I/O before advancing the execution deadline.
    await vi.waitFor(() => expect(vercel.handlerStarted).toBe(true), { timeout: 3_000 })
    expect(response).toBeUndefined()
    await vi.advanceTimersByTimeAsync(300_000)
    await pending

    expect(response?.[0]?.status).toBe(504)
    expect(response?.[0]?.cause).toMatchObject({ code: "SANDBOX_TASK_TIMEOUT", details: { timeout: 300_000 } })
    expect(vercel.createOptions[0]?.timeout).toBe(330_000)
  })

  it("reports a timeout above the Vercel plan maximum with a stable code and the limit", async () => {
    registerTask({ timeout: 3_600_000 })

    const response = await runSandboxTaskRuntime("slow")

    expect(response[0]?.status).toBe(500)
    expect(response[0]?.cause).toMatchObject({
      code: "SANDBOX_TASK_VERCEL_TIMEOUT_LIMIT",
      message: expect.stringContaining("Vercel rejected the Sandbox session timeout of 3630000ms: `timeout` restricted to <= 45m on Hobby plans."),
    })
  })
})
