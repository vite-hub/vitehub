import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import type { WorkflowDefinition, WorkflowProviderStep, WorkflowStepOptions } from "../src/types.ts"
import { readWorkflowStepOptions } from "../src/internal/step-options.ts"
import { assertVercelStepRetries, writeProviderEntries } from "../src/internal/vite-build.ts"
import { getWorkflowRun, startWorkflow } from "../src/runtime/client.ts"
import { runCloudflareWorkflow } from "../src/runtime/cloudflare-runner.ts"
import { createWorkflowSteps, resolveWorkflowStepOptions, runProviderStep } from "../src/runtime/execute.ts"
import { resetOpenWorkflowRuntime } from "../src/runtime/openworkflow.ts"
import { createOpenWorkflowWorker } from "../src/runtime/openworkflow-worker.ts"
import { resetWorkflowRuntime, setWorkflowRuntimeConfig, setWorkflowRuntimeRegistry } from "../src/runtime/state.ts"

const attempts: string[] = []
const signals: AbortSignal[] = []

/** The shape that the generated registry gives a folder Workflow: one step file with its exported options. */
function folderWorkflow(options: WorkflowStepOptions, run: (input: unknown, context: { signal: AbortSignal }) => unknown): WorkflowDefinition {
  return {
    options: { rootStep: false },
    handler: async (payload, context) => await createWorkflowSteps(context, [{ name: "01.sync.ts", options, run }]).sync!(payload),
  }
}

/** Fails until the signal aborts, or answers after 300 ms. */
async function waitForAbort(_input: unknown, { signal }: { signal: AbortSignal }) {
  attempts.push("sync")
  signals.push(signal)
  await delay(300, undefined, { signal })
  return "synced"
}

beforeEach(() => {
  resetWorkflowRuntime()
  attempts.length = 0
  signals.length = 0
})

describe("step options", () => {
  it("fills in the default retries", () => {
    expect(resolveWorkflowStepOptions("report/01.sync.ts", undefined)).toEqual({ retries: { backoff: "exponential", delay: "10 seconds", limit: 3 } })
    expect(resolveWorkflowStepOptions("report/01.sync.ts", { retries: { limit: 0 }, timeout: "2 minutes" }))
      .toEqual({ retries: { backoff: "exponential", delay: "10 seconds", limit: 0 }, timeout: "2 minutes" })
  })

  it.each([
    [{ retries: { limit: -1 } }, "retries.limit"],
    [{ retries: { limit: 1.5 } }, "retries.limit"],
    [{ retries: { delay: "soon" } }, "retries.delay"],
    [{ retries: { backoff: "linear" } }, "retries.backoff"],
    [{ retries: { attempts: 3 } }, "retries.attempts"],
    [{ timeout: 0 }, "timeout"],
    [{ timeout: "1 fortnight" }, "timeout"],
    [{ retry: 3 }, "retry"],
  ])("rejects %j", (options, option) => {
    expect(() => resolveWorkflowStepOptions("report/01.sync.ts", options)).toThrow(expect.objectContaining({
      code: "WORKFLOW_STEP_OPTIONS_INVALID",
      message: expect.stringContaining(`\`${option}\``),
    }))
  })

  it("fails an inline attempt at its timeout and aborts the step's signal", async () => {
    await expect(runProviderStep(undefined, "report/01.sync.ts", context => waitForAbort(undefined, context), { timeout: 20 }))
      .rejects.toMatchObject({ code: "WORKFLOW_STEP_TIMEOUT" })
    expect(signals[0]?.aborted).toBe(true)
    expect(signals[0]?.reason).toMatchObject({ code: "WORKFLOW_STEP_TIMEOUT" })
  })
})

describe("Cloudflare", () => {
  it("passes the step options to step.do() and aborts the signal at the timeout", async () => {
    const configs: unknown[] = []
    const step: WorkflowProviderStep = {
      do: async (_name, options, run) => {
        configs.push(options)
        return await run()
      },
    }
    const definition = folderWorkflow({ retries: { backoff: "constant", delay: "30 seconds", limit: 5 }, timeout: 20 }, waitForAbort)

    await expect(runCloudflareWorkflow({
      config: { driver: "cloudflare" },
      env: {},
      event: { instanceId: "run-1" },
      name: "report",
      registry: { report: async () => ({ default: definition }) },
      step,
    })).rejects.toMatchObject({ code: "WORKFLOW_STEP_TIMEOUT" })

    expect(configs).toEqual([{ retries: { backoff: "constant", delay: "30 seconds", limit: 5 }, timeout: 20 }])
    expect(signals[0]?.aborted).toBe(true)
  })
})

describe("OpenWorkflow (SQLite)", () => {
  afterEach(async () => {
    await resetOpenWorkflowRuntime()
  })

  async function tick(): Promise<void> {
    const worker = await createOpenWorkflowWorker()
    await worker.tick()
    await worker.stop()
  }

  it("runs a step once more for each retry in `limit`, then fails the run", async () => {
    setWorkflowRuntimeConfig({ driver: "openworkflow", sqlite: { path: ":memory:" } })
    setWorkflowRuntimeRegistry({
      report: async () => ({
        default: folderWorkflow({ retries: { delay: 0, limit: 1 } }, () => {
          attempts.push("sync")
          throw new Error("GitHub is down")
        }),
      }),
    })
    const started = await startWorkflow("report")

    for (let tickCount = 0; tickCount < 4; tickCount++) await tick()

    expect(attempts).toEqual(["sync", "sync"])
    await expect(getWorkflowRun("report", started.id)).resolves.toMatchObject({ error: { message: "GitHub is down" }, status: "failed" })
  })

  it.each([0, 1])("enforces explicit step timeouts with %i retries", async (limit) => {
    setWorkflowRuntimeConfig({ driver: "openworkflow", sqlite: { path: ":memory:" } })
    setWorkflowRuntimeRegistry({
      report: async () => ({
        default: {
          options: { rootStep: false },
          handler: async (_payload, context) => await context.step!.do!("slow", { retries: { delay: 0, limit }, timeout: 20 }, async () => {
            attempts.push("slow")
            await delay(120)
            return "done"
          }),
        },
      }),
    })
    const started = await startWorkflow("report")
    for (let tickCount = 0; tickCount < 4; tickCount++) await tick()

    expect(attempts).toHaveLength(limit + 1)
    await expect(getWorkflowRun("report", started.id)).resolves.toMatchObject({ error: { name: "WORKFLOW_STEP_TIMEOUT" }, status: "failed" })
  })

  it("fails an attempt at its timeout", async () => {
    setWorkflowRuntimeConfig({ driver: "openworkflow", sqlite: { path: ":memory:" } })
    setWorkflowRuntimeRegistry({ report: async () => ({ default: folderWorkflow({ retries: { limit: 0 }, timeout: 20 }, waitForAbort) }) })
    const started = await startWorkflow("report")

    await tick()
    await tick()

    expect(attempts).toEqual(["sync"])
    expect(signals[0]?.aborted).toBe(true)
    await expect(getWorkflowRun("report", started.id)).resolves.toMatchObject({ error: { message: expect.stringContaining("timeout of 20 ms"), name: "WORKFLOW_STEP_TIMEOUT" }, status: "failed" })
  })
})

describe("build", () => {
  const roots: string[] = []
  afterEach(async () => {
    await Promise.all(roots.splice(0).map(root => rm(root, { force: true, recursive: true })))
  })

  async function stepFile(source: string): Promise<{ file: string, root: string }> {
    const root = await mkdtemp(join(tmpdir(), "vitehub-workflow-step-options-"))
    roots.push(root)
    const directory = join(root, "server", "workflows", "report")
    await mkdir(directory, { recursive: true })
    const file = join(directory, "01.sync.ts")
    await writeFile(file, source)
    return { file, root }
  }

  it("reads literal options from the step file", async () => {
    const { file } = await stepFile([
      "import type { WorkflowStepRetries } from '@vite-hub/workflow'",
      "export const retries = { limit: 5, delay: '30 seconds' } satisfies WorkflowStepRetries",
      "export const timeout = '2 minutes'",
      "export default async function sync() {}",
    ].join("\n"))

    await expect(readWorkflowStepOptions(file)).resolves.toEqual({ retries: { delay: "30 seconds", limit: 5 }, timeout: "2 minutes" })
  })

  it("rejects options that the build cannot read or that are invalid", async () => {
    const dynamic = await stepFile("const limit = Number(process.env.LIMIT)\nexport const retries = { limit }\nexport default async function sync() {}\n")
    await expect(readWorkflowStepOptions(dynamic.file)).rejects.toMatchObject({ code: "WORKFLOW_STEP_OPTIONS_NOT_STATIC" })

    const invalid = await stepFile("export const timeout = '1 fortnight'\nexport default async function sync() {}\n")
    await expect(readWorkflowStepOptions(invalid.file)).rejects.toMatchObject({ code: "WORKFLOW_STEP_OPTIONS_INVALID" })
  })

  it("writes the retry limit and the timeout into the Vercel step", async () => {
    const { root } = await stepFile("export const retries = { limit: 5 }\nexport const timeout = '2 minutes'\nexport default async function sync() {}\n")

    const artifacts = await writeProviderEntries(root, { driver: "vercel" })
    const native = await readFile(artifacts.vercelNativeFiles[0]!, "utf8")

    expect(native).toMatch(/Step0\.maxRetries = 5/)
    expect(native).toContain(`runWorkflowStepAttempt("report/01.sync.ts", "2 minutes"`)
    await expect(assertVercelStepRetries(artifacts.providerDefinitions)).resolves.toBeUndefined()
  })

  it("fails a Vercel build whose step sets a retry delay", async () => {
    const { root } = await stepFile("export const retries = { limit: 5, delay: '1 minute' }\nexport default async function sync() {}\n")

    const artifacts = await writeProviderEntries(root, { driver: "vercel" })

    await expect(assertVercelStepRetries(artifacts.providerDefinitions)).rejects.toMatchObject({ code: "WORKFLOW_STEP_RETRY_DELAY_UNSUPPORTED" })
  })
})
