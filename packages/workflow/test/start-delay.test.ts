import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

import { buildSync } from "esbuild"
import { afterEach, describe, expect, it, vi } from "vitest"
import { sleep as workflowSleep } from "workflow"

import { defineWorkflow } from "../src/definition.ts"
import { vercelWorkflowSleepSymbol, writeProviderEntries } from "../src/internal/vite-build.ts"
import { getCloudflareWorkflowBindingName } from "../src/integrations/cloudflare.ts"
import { runCloudflareWorkflow } from "../src/runtime/cloudflare-runner.ts"
import { getWorkflowRun, startWorkflow } from "../src/runtime/client.ts"
import { getOpenWorkflowRuntime, resetOpenWorkflowRuntime } from "../src/runtime/openworkflow.ts"
import { createOpenWorkflowWorker } from "../src/runtime/openworkflow-worker.ts"
import { enterWorkflowRuntimeEvent, resetWorkflowRuntime, setWorkflowRuntimeConfig, setWorkflowRuntimeRegistry } from "../src/runtime/state.ts"
import { setVercelWorkflowRuntimeLoader } from "../src/runtime/vercel.ts"

import type { WorkflowProviderStep } from "../src/types.ts"
import type { VercelRun, VercelWorkflowRuntime } from "../src/runtime/vercel.ts"
import { unwrap } from "./unwrap.ts"

afterEach(async () => {
  resetWorkflowRuntime()
  setVercelWorkflowRuntimeLoader()
  await resetOpenWorkflowRuntime()
})

async function waitFor(check: () => Promise<boolean>, timeout = 2_000) {
  const end = Date.now() + timeout
  while (!await check()) {
    if (Date.now() > end) throw new Error("Timed out")
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

describe("inline runs", () => {
  function inlineWorkflow() {
    const seen: unknown[] = []
    setWorkflowRuntimeConfig({ driver: "vercel" })
    setWorkflowRuntimeRegistry({
      remind: async () => ({ default: defineWorkflow<{ to: string }>({ handler: async ({ payload }) => {
        seen.push(payload)
        return "sent"
      } }) }),
    })
    return seen
  }

  it("reports queued and runs the handler after the delay", async () => {
    const seen = inlineWorkflow()
    const startedAt = Date.now()

    const run = await unwrap(startWorkflow("remind", { to: "ada" }, { delay: "150ms" }))

    expect(run.status).toBe("queued")
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(seen).toEqual([])
    await expect(unwrap(getWorkflowRun("remind", run.id))).resolves.toMatchObject({ status: "queued" })
    await waitFor(async () => (await unwrap(getWorkflowRun("remind", run.id))).status === "completed")
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(140)
    expect(seen).toEqual([{ to: "ada" }])
  })

  it("accepts a duration string and a future Date", async () => {
    const seen = inlineWorkflow()

    const byString = await unwrap(startWorkflow("remind", { to: "a" }, { delay: "100ms", id: "by-string" }))
    const byDate = await unwrap(startWorkflow("remind", { to: "b" }, { delay: new Date(Date.now() + 100), id: "by-date" }))

    await expect(unwrap(getWorkflowRun("remind", byString.id))).resolves.toMatchObject({ status: "queued" })
    await expect(unwrap(getWorkflowRun("remind", byDate.id))).resolves.toMatchObject({ status: "queued" })
    await waitFor(async () => seen.length === 2)
  })

  it("starts now for a Date in the past", async () => {
    const seen = inlineWorkflow()

    const run = await unwrap(startWorkflow("remind", { to: "ada" }, { delay: new Date(Date.now() - 60_000) }))

    await waitFor(async () => (await unwrap(getWorkflowRun("remind", run.id))).status === "completed", 500)
    expect(seen).toHaveLength(1)
  })

  it.each([
    -1,
    150,
    Number.NaN,
    "-1 hour",
    "soon",
    "10",
    "1 month",
  ])("rejects the delay %s with RUNTIME_DURATION_INVALID", async (delay) => {
    const seen = inlineWorkflow()

    await expect(startWorkflow("remind", { to: "ada" }, { delay: delay as never })).resolves.toMatchObject([{ code: "RUNTIME_DURATION_INVALID" }, undefined])
    expect(seen).toEqual([])
  })

  it("shows the string form when the delay is a number", async () => {
    inlineWorkflow()

    await expect(startWorkflow("remind", { to: "ada" }, { delay: 300_000 as never })).resolves.toMatchObject([{ fix: expect.stringContaining("\"5m\"") }, undefined])
  })

  it.each([new Date(Number.NaN), "300000000000 weeks"])("rejects the delay %s, which a Date cannot hold, with WORKFLOW_START_DELAY_INVALID", async (delay) => {
    const seen = inlineWorkflow()

    await expect(startWorkflow("remind", { to: "ada" }, { delay: delay as never })).resolves.toMatchObject([{ code: "WORKFLOW_START_DELAY_INVALID" }, undefined])
    expect(seen).toEqual([])
  })
})

describe("OpenWorkflow", () => {
  const config = { driver: "openworkflow", sqlite: { path: ":memory:" } } as const

  it("keeps a delayed run queued until its start time", async () => {
    const seen: unknown[] = []
    setWorkflowRuntimeConfig(config)
    setWorkflowRuntimeRegistry({
      remind: async () => ({ default: defineWorkflow<{ to: string }>({ handler: async ({ payload }) => {
        seen.push(payload)
        return "sent"
      } }) }),
    })
    const before = Date.now()

    const run = await unwrap(startWorkflow("remind", { to: "ada" }, { delay: "1 hour", id: "remind-ada" }))

    expect(run).toMatchObject({ id: "remind-ada", status: "queued" })
    const runtime = await getOpenWorkflowRuntime(config)
    const stored = await runtime.backend.getWorkflowRun({ workflowRunId: (await runtime.findRunId("remind", "remind-ada")) ?? "remind-ada" })
    expect(stored?.availableAt?.getTime()).toBeGreaterThanOrEqual(before + 3_600_000)

    const worker = await createOpenWorkflowWorker()
    await worker.tick()
    expect(seen).toEqual([])
    await expect(unwrap(getWorkflowRun("remind", "remind-ada"))).resolves.toMatchObject({ status: "queued" })

    const db: { prepare(sql: string): { run(...values: unknown[]): unknown } } = Reflect.get(runtime.backend, "db")
    db.prepare(`UPDATE "workflow_runs" SET "available_at" = ?`).run(new Date(Date.now() - 1_000).toISOString())
    await worker.tick()
    await waitFor(async () => (await unwrap(getWorkflowRun("remind", "remind-ada"))).status === "completed")
    await worker.stop()
    expect(seen).toEqual([{ to: "ada" }])
  })
})

describe("Cloudflare", () => {
  function cloudflareBinding() {
    const binding = {
      createBatch: vi.fn(async (batch: { id: string, params: unknown }[]) => batch.map(({ id }) => ({ id, status: async () => ({ status: "queued" }) }))),
      get: vi.fn(async (id: string) => ({ id, status: async () => ({ status: "waiting" }) })),
    }
    setWorkflowRuntimeConfig({ driver: "cloudflare" })
    setWorkflowRuntimeRegistry({ remind: async () => ({ default: { handler: async () => "sent" } }) })
    enterWorkflowRuntimeEvent({ req: { runtime: { cloudflare: { env: { [getCloudflareWorkflowBindingName("remind")]: binding } } } } })
    return binding
  }

  it("sends the start time next to the payload", async () => {
    const binding = cloudflareBinding()
    const startAt = new Date(Date.now() + 3_600_000)

    const run = await unwrap(startWorkflow("remind", { to: "ada" }, { delay: startAt, id: "remind-ada" }))

    expect(run).toMatchObject({ id: "remind-ada", payload: { to: "ada" }, status: "queued" })
    expect(binding.createBatch).toHaveBeenCalledWith([{ id: "remind-ada", params: { "~vitehubStartAt": startAt.getTime(), payload: { to: "ada" } } }])
  })

  it("sends the payload alone without a delay", async () => {
    const binding = cloudflareBinding()

    await unwrap(startWorkflow("remind", { to: "ada" }, { id: "remind-now" }))

    expect(binding.createBatch).toHaveBeenCalledWith([{ id: "remind-now", params: { to: "ada" } }])
  })

  function fakeStep() {
    const calls: unknown[][] = []
    const step: WorkflowProviderStep & { sleepUntil: (name: string, at: Date | number) => Promise<void> } = {
      do: async (_name, _options, run) => await run(),
      sleepUntil: async (...args) => {
        calls.push(["sleepUntil", ...args])
      },
    }
    return { calls, step }
  }

  it("sleeps until the start time before the handler and gives the handler the plain payload", async () => {
    const { calls, step } = fakeStep()
    const seen: unknown[] = []
    const startAt = Date.now() + 3_600_000

    const result = await runCloudflareWorkflow({
      config: { driver: "cloudflare" },
      env: {},
      event: { instanceId: "remind-ada", payload: { "~vitehubStartAt": startAt, payload: { to: "ada" } } },
      name: "remind",
      registry: {
        remind: async () => ({ default: { handler: async ({ payload }) => {
          calls.push(["handler"])
          seen.push(payload)
          return "sent"
        } } }),
      },
      step,
    })

    expect(result).toBe("sent")
    expect(calls).toEqual([["sleepUntil", "vitehub-delay", new Date(startAt)], ["handler"]])
    expect(seen).toEqual([{ to: "ada" }])
  })

  it("does not sleep for a run without a delay", async () => {
    const { calls, step } = fakeStep()
    const seen: unknown[] = []

    await runCloudflareWorkflow({
      config: { driver: "cloudflare" },
      env: {},
      event: { instanceId: "remind-now", payload: { to: "ada" } },
      name: "remind",
      registry: { remind: async () => ({ default: { handler: async ({ payload }) => { seen.push(payload) } } }) },
      step,
    })

    expect(calls).toEqual([])
    expect(seen).toEqual([{ to: "ada" }])
  })
})

describe("Vercel native", () => {
  function vercelRuntime() {
    const start = vi.fn<VercelWorkflowRuntime["start"]>(async () => ({ runId: "wrun_1", returnValue: new Promise<unknown>(() => {}) } as unknown as VercelRun))
    setVercelWorkflowRuntimeLoader(async () => ({
      getRun: vi.fn(),
      listSteps: vi.fn(async () => []),
      resumeHook: vi.fn(),
      start,
    }))
    setWorkflowRuntimeConfig({ driver: "vercel" })
    return start
  }

  it("passes the start time to a native entry that ViteHub generated", async () => {
    const start = vercelRuntime()
    const native = Object.assign(async () => "native", { workflowId: "workflow//./.vitehub/workflow/vercel-native//RemindNative", "~vitehubGenerated": true })
    setWorkflowRuntimeRegistry({ remind: async () => ({ default: { handler: async () => "inline", native, rootStep: false } }) })
    const startAt = new Date(Date.now() + 3_600_000)

    await expect(unwrap(startWorkflow("remind", { to: "ada" }, { delay: startAt }))).resolves.toMatchObject({ id: "wrun_1", status: "queued" })

    expect(start).toHaveBeenCalledWith(native, [{ "name": "remind", "payload": { to: "ada" }, "provider": "vercel", "~vitehubStartAt": startAt.getTime() }])
  })

  it("rejects a delay for a native entry that the developer wrote", async () => {
    const start = vercelRuntime()
    const native = Object.assign(async () => "native", { workflowId: "workflow//./server/workflows/durable.ts//durable" })
    setWorkflowRuntimeRegistry({ remind: async () => ({ default: { handler: async () => "inline", native } }) })

    expect(await startWorkflow("remind", { to: "ada" }, { delay: "1 hour" })).toMatchObject([{
      code: "WORKFLOW_OPERATION_UNSUPPORTED",
      data: { operation: "delay", provider: "vercel" },
    }, undefined])
    expect(start).not.toHaveBeenCalled()
  })
})

describe("generated Vercel native entry", () => {
  const sleepSymbol = Symbol.for(vercelWorkflowSleepSymbol)

  afterEach(() => {
    Reflect.deleteProperty(globalThis, sleepSymbol)
  })

  it("uses the function that Workflow DevKit sleep() calls", async () => {
    const sleep = vi.fn(async () => {})
    Reflect.set(globalThis, sleepSymbol, sleep)
    const at = new Date(Date.now() + 60_000)

    await workflowSleep(at)

    expect(sleep).toHaveBeenCalledWith(at)
  })

  it("sleeps until the start time before the first step, and the registry marks it", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vitehub-workflow-start-delay-"))
    try {
      await mkdir(join(rootDir, "server", "workflows", "remind"), { recursive: true })
      await writeFile(join(rootDir, "server", "workflows", "remind", "01-send.ts"), "export default async function send(input) { globalThis.viteHubDelayCalls.push(['step', input]); return 'sent' }\n")
      const artifacts = await writeProviderEntries(rootDir, false, { workflow: "vite-hub/workflow" }, undefined, false)

      const registry = await readFile(join(artifacts.generatedDir, "registry-runtime.mjs"), "utf8")
      expect(registry).toContain(`native["~vitehubGenerated"] = true`)
      const [nativeFile] = artifacts.vercelNativeFiles
      const bundled = buildSync({ bundle: true, entryPoints: [nativeFile!], format: "esm", platform: "node", write: false })
      const bundleFile = join(rootDir, "native.mjs")
      await writeFile(bundleFile, bundled.outputFiles[0]!.text)
      const native = Object.values(await import(pathToFileURL(bundleFile).href))[0] as (context: unknown) => Promise<unknown>

      const calls: unknown[][] = []
      Reflect.set(globalThis, "viteHubDelayCalls", calls)
      Reflect.set(globalThis, sleepSymbol, async (at: Date) => {
        calls.push(["sleep", at])
      })
      const startAt = Date.now() + 60_000

      await expect(native({ "name": "remind", "payload": { to: "ada" }, "provider": "vercel", "~vitehubStartAt": startAt })).resolves.toBe("sent")
      await expect(native({ name: "remind", payload: { to: "bob" }, provider: "vercel" })).resolves.toBe("sent")
      expect(calls).toEqual([["sleep", new Date(startAt)], ["step", { to: "ada" }], ["step", { to: "bob" }]])
    }
    finally {
      Reflect.deleteProperty(globalThis, "viteHubDelayCalls")
      await rm(rootDir, { force: true, recursive: true })
    }
  })
})
