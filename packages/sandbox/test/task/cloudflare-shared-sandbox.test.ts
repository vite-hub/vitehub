import { afterEach, describe, expect, it, vi } from "vitest"

import type { CloudflareSandboxStub } from "../../src/cloudflare.ts"

vi.mock("#vitehub-sandbox-task-provider-loader", async () => {
  const { resolveCloudflareTaskSandbox } = await import("../../src/task/runtime/providers/cloudflare.ts")
  return { loadSandboxTaskRuntimeProvider: async () => ({ resolveTaskSandbox: resolveCloudflareTaskSandbox }) }
})

/**
 * One Cloudflare Container behind every Durable Object name, with an in-memory file system.
 * A Task handler is the source text of its module: `hang` runs until it is cancelled or times out,
 * `gate` writes a file in HOME, then waits for `release()` and checks that the file is still there.
 */
function fakeContainer() {
  const files = new Map<string, string>()
  const directories = new Set<string>(["/"])
  const pendingHandlers = new Map<string, () => void>()
  let gateRelease!: () => void
  const gate = new Promise<void>(resolve => gateRelease = resolve)
  let gateReached!: () => void
  const gateStarted = new Promise<void>(resolve => gateReached = resolve)
  const state = { destroyed: 0, handlers: 0 }

  const remove = (path: string) => {
    for (const key of files.keys()) if (key === path || key.startsWith(`${path}/`)) files.delete(key)
    for (const key of directories) if (key === path || key.startsWith(`${path}/`)) directories.delete(key)
  }
  const exists = (path: string) => files.has(path) || directories.has(path) || [...files.keys()].some(key => key.startsWith(`${path}/`))
  const words = (command: string) => [...command.matchAll(/'((?:[^']|'"'"')*)'|(\S+)/g)].map(match => match[1]?.replaceAll(`'"'"'`, "'") ?? match[2]!)
  const ok = (stdout = "") => ({ exitCode: 0, stderr: "", stdout, success: true })

  const runHandler = async (args: string[], options: { id?: string; timeout?: number }) => {
    state.handlers++
    const [entryPath, , outputPath] = args.slice(-3) as [string, string, string]
    const source = Buffer.from(files.get(entryPath.replace(/entry\.mjs$/, "index.mjs")) ?? "", "base64").toString()
    let output = { ok: true, result: { ok: true } } as { ok: boolean; result?: unknown }
    if (source.includes("hang")) {
      return await new Promise<ReturnType<typeof ok>>((resolve, reject) => {
        const timer = options.timeout ? setTimeout(() => reject(new Error(`Command timed out after ${options.timeout}ms.`)), options.timeout) : undefined
        pendingHandlers.set(options.id!, () => {
          clearTimeout(timer)
          resolve({ exitCode: 137, stderr: "", stdout: "", success: false })
        })
      })
    }
    if (source.includes("gate")) {
      files.set("/home/vitehub/gate-state", Buffer.from("A").toString("base64"))
      gateReached()
      await gate
      output = { ok: true, result: { homeKept: files.has("/home/vitehub/gate-state") } }
    }
    files.set(outputPath, Buffer.from(JSON.stringify(output)).toString("base64"))
    return ok()
  }

  const stub: CloudflareSandboxStub & { configure(): Promise<void> } = {
    async configure() {},
    async cancelExec(id) {
      pendingHandlers.get(id)?.()
      pendingHandlers.delete(id)
    },
    async deleteFile(path) {
      files.delete(path)
      return { success: true }
    },
    async destroy() {
      state.destroyed++
      for (const cancel of pendingHandlers.values()) cancel()
      pendingHandlers.clear()
      files.clear()
      directories.clear()
      directories.add("/")
    },
    async exec(command, options = {}) {
      const [program, ...args] = words(command)
      if (program === "rm") {
        remove(args.at(-1)!)
        return ok()
      }
      if (program === "node") return await runHandler(args, options)
      if (program === "test") return { ...ok(), exitCode: exists(args.at(-1)!) ? 0 : 1 }
      return ok()
    },
    async exists(path) {
      return { exists: exists(path) }
    },
    async mkdir(path) {
      directories.add(path)
      return { success: true }
    },
    async moveFile(source, destination) {
      files.set(destination, files.get(source)!)
      files.delete(source)
      return { success: true }
    },
    async readFile(path) {
      const content = files.get(path)
      return content === undefined ? { content: "", success: false } : { content, success: true }
    },
    async writeFile(path, contents, options) {
      files.set(path, options?.encoding === "base64" ? contents : Buffer.from(contents).toString("base64"))
      return { success: true }
    },
  }
  const namespace = {
    get: () => stub,
    idFromName: (name: string) => name,
  }
  return { directories, files, gateStarted, namespace, release: () => gateRelease(), state }
}

const task = (source: string, timeout?: number) => ({
  bundle: { entry: "index.mjs", modules: { "index.mjs": `export default () => "${source}"` } },
  ...(timeout ? { options: { timeout } } : {}),
})

/** Loads the runtime in a new module graph, like a second Worker isolate with its own run queue. */
async function isolate(namespace: unknown, config: Record<string, unknown>) {
  vi.resetModules()
  const { resolveSandboxTaskRunner } = await import("../../src/task/runtime/runtime.ts")
  const { setSandboxTaskRuntimeConfig, setSandboxTaskRuntimeRegistry } = await import("../../src/task/runtime/state.ts")
  const { runWithActiveCloudflareEnv } = await import("@vite-hub/internal/runtime/cloudflare-env")
  setSandboxTaskRuntimeConfig({ provider: "cloudflare", ...config })
  setSandboxTaskRuntimeRegistry({ echo: task("echo"), gate: task("gate"), slow: task("hang", 50) })
  return async (name: string, options?: { sandboxId?: string }) => {
    const runner = await runWithActiveCloudflareEnv({ SANDBOX: namespace }, () => resolveSandboxTaskRunner(name))
    return await runner.run(undefined, options)
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe("Cloudflare Sandbox Task lifecycle on a shared Sandbox", () => {
  it("keeps a named Sandbox and its files when a run times out", async () => {
    const container = fakeContainer()
    const run = await isolate(container.namespace, { sandboxId: "shared" })
    container.files.set("/tmp/vitehub-sandbox-task/projects/abc/.vitehub/prepared", "")

    await expect(run("slow")).rejects.toMatchObject({ code: "SANDBOX_TASK_TIMEOUT" })

    expect(container.state.destroyed).toBe(0)
    expect(container.files.has("/tmp/vitehub-sandbox-task/projects/abc/.vitehub/prepared")).toBe(true)
  })

  it("keeps a run in another isolate alive when a run on the same Sandbox times out", async () => {
    const container = fakeContainer()
    const first = await isolate(container.namespace, { sandboxId: "shared" })
    const second = await isolate(container.namespace, { sandboxId: "shared" })

    const running = first("gate")
    await container.gateStarted
    await expect(second("slow")).rejects.toMatchObject({ code: "SANDBOX_TASK_TIMEOUT" })
    container.release()

    await expect(running).resolves.toEqual({ homeKept: true })
    expect(container.state.destroyed).toBe(0)
  })

  it("does not delete HOME or the workspace of a run in another isolate when it opens", async () => {
    const container = fakeContainer()
    const first = await isolate(container.namespace, {})
    const second = await isolate(container.namespace, {})

    const running = first("gate", { sandboxId: "shared" })
    await container.gateStarted
    container.files.set("/workspace/kept", "")
    await expect(second("echo", { sandboxId: "shared" })).resolves.toEqual({ ok: true })
    container.release()

    await expect(running).resolves.toEqual({ homeKept: true })
    expect(container.files.has("/workspace/kept")).toBe(true)
  })

  it("leaves a named keepAlive Sandbox running between runs", async () => {
    const container = fakeContainer()
    const run = await isolate(container.namespace, { keepAlive: true, sandboxId: "warm" })

    await expect(run("echo")).resolves.toEqual({ ok: true })
    await expect(run("echo")).resolves.toEqual({ ok: true })

    expect(container.state.destroyed).toBe(0)
  })

  it("still stops a Sandbox without an ID after each run, also with keepAlive", async () => {
    const container = fakeContainer()
    const run = await isolate(container.namespace, { keepAlive: true })

    await expect(run("echo")).resolves.toEqual({ ok: true })
    await expect(run("slow")).rejects.toMatchObject({ code: "SANDBOX_TASK_TIMEOUT" })

    expect(container.state.destroyed).toBe(2)
  })
})
