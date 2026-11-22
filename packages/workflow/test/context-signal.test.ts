import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest"

import type { CloudflareWorkflowStep } from "../src/runtime/cloudflare-runner.ts"
import type { WorkflowDefinition, WorkflowExecutionContext } from "../src/types.ts"
import { defineWorkflow } from "../src/definition.ts"
import { getCloudflareWorkflowBindingName } from "../src/integrations/cloudflare.ts"
import { cancelWorkflow, getWorkflowRun, resumeWorkflow, startWorkflow } from "../src/runtime/client.ts"
import { runCloudflareWorkflow } from "../src/runtime/cloudflare-runner.ts"
import { setWorkflowDevRecorder } from "../src/runtime/dev-recorder.ts"
import { enableWorkflowDevRuns } from "../src/runtime/dev-runs.ts"
import { resetOpenWorkflowRuntime } from "../src/runtime/openworkflow.ts"
import { createOpenWorkflowWorker } from "../src/runtime/openworkflow-worker.ts"
import { createWorkflowSignalToken } from "../src/runtime/signals.ts"
import { enterWorkflowRuntimeEvent, resetWorkflowRuntime, setWorkflowRuntimeConfig, setWorkflowRuntimeRegistry } from "../src/runtime/state.ts"
import { unwrap } from "./unwrap.ts"

interface Transcript { text: string }

const calls: string[] = []
const tokens: string[] = []

function folderWorkflow<TPayload>(handler: (context: WorkflowExecutionContext<TPayload>) => Promise<string>): WorkflowDefinition<TPayload, string> {
  return { rootStep: false, handler }
}

const summary = folderWorkflow<undefined>(async (context) => {
  calls.push("request")
  const signal = context.createSignal<Transcript>()
  tokens.push(signal.token)
  const transcript = await signal.wait()
  calls.push(`summarize ${transcript.text}`)
  return transcript.text.toUpperCase()
})

const summaryInRootStep = defineWorkflow<undefined>({ handler: async ({ payload: _payload, ...context }) => {
  calls.push("request")
  const transcript = await context.createSignal<Transcript>().wait()
  calls.push("summarize")
  return transcript.text
} })

const rootStepSignal = { code: "WORKFLOW_ROOT_STEP_SIGNAL", message: expect.stringContaining("folder Workflow") }

beforeEach(() => {
  resetWorkflowRuntime()
  calls.length = 0
  tokens.length = 0
})

it("types the value of `wait()` from `createSignal<T>()`", () => {
  folderWorkflow<undefined>(async (context) => {
    const signal = context.createSignal<Transcript>()
    expectTypeOf(signal.token).toEqualTypeOf<string>()
    expectTypeOf(signal.wait()).toEqualTypeOf<Promise<Transcript>>()
    expectTypeOf(context.createSignal().wait()).toEqualTypeOf<Promise<unknown>>()
    return ""
  })
})

describe("Cloudflare", () => {
  function run(step: CloudflareWorkflowStep, definition: WorkflowDefinition<undefined, unknown> = summary) {
    return runCloudflareWorkflow({
      config: { driver: "cloudflare" },
      env: {},
      event: { instanceId: "run-1" },
      name: "summary",
      registry: { summary: async () => ({ default: definition }) },
      step,
    })
  }

  it("waits for an event of the signal type, for as long as Cloudflare allows", async () => {
    const waitForEvent = vi.fn(async () => ({ payload: { text: "hello" }, timestamp: new Date(), type: "vitehub-signal-1" }))

    await expect(run({ do: async (_name, _options, step) => await step(), waitForEvent })).resolves.toBe("HELLO")

    expect(waitForEvent).toHaveBeenCalledWith("signal-1", { timeout: "365 days", type: "vitehub-signal-1" })
    expect(tokens).toEqual([createWorkflowSignalToken({ host: "cloudflare", run: "run-1", signal: "signal-1", workflow: "summary" })])
    expect(calls).toEqual(["request", "summarize hello"])
  })

  it("makes the same token on a replay", async () => {
    const step: CloudflareWorkflowStep = { do: async (_name, _options, step) => await step(), waitForEvent: async () => ({ payload: { text: "hi" } }) }
    await run(step)
    await run(step)
    expect(tokens[0]).toBe(tokens[1])
  })

  it("fails a root step that waits, and fails the same way on replay", async () => {
    const waitForEvent = vi.fn(async () => ({ payload: { text: "hello" } }))
    let recorded: unknown
    await expect(run({ do: async (_name, _options, step) => recorded = await step(), waitForEvent }, summaryInRootStep)).rejects.toMatchObject(rootStepSignal)

    await expect(run({ do: async <T>() => structuredClone(recorded) as T, waitForEvent }, summaryInRootStep)).rejects.toMatchObject(rootStepSignal)
    expect(waitForEvent).not.toHaveBeenCalled()
    expect(calls).toEqual(["request"])
  })

  it("sends the value to the instance as an event of the signal type", async () => {
    const sendEvent = vi.fn(async () => {})
    const status = vi.fn(async () => ({ status: "queued" }))
    const binding = { createBatch: vi.fn(), get: vi.fn(async (id: string) => ({ id, sendEvent, status })) }
    setWorkflowRuntimeConfig({ driver: "cloudflare" })
    enterWorkflowRuntimeEvent({ req: { runtime: { cloudflare: { env: { [getCloudflareWorkflowBindingName("summary")]: binding } } } } })
    const token = createWorkflowSignalToken({ host: "cloudflare", run: "run-1", signal: "signal-1", workflow: "summary" })

    await expect(unwrap(resumeWorkflow(token, { text: "hello" }))).resolves.toEqual({ id: "run-1", provider: "cloudflare" })

    expect(binding.get).toHaveBeenCalledWith("run-1")
    expect(sendEvent).toHaveBeenCalledWith({ payload: { text: "hello" }, type: "vitehub-signal-1" })

    status.mockResolvedValue({ status: "complete" })
    const [finished] = await resumeWorkflow(token, { text: "again" })
    expect(finished).toMatchObject({ code: "WORKFLOW_SIGNAL_NOT_WAITING" })
    binding.get.mockRejectedValueOnce(new Error("instance.not_found"))
    const [missing] = await resumeWorkflow(token, { text: "again" })
    expect(missing).toMatchObject({ code: "WORKFLOW_SIGNAL_NOT_WAITING" })
    expect(sendEvent).toHaveBeenCalledTimes(1)
  })

  it("rejects a token of another provider or a string that no signal made", async () => {
    setWorkflowRuntimeConfig({ driver: "cloudflare" })
    const openWorkflowToken = createWorkflowSignalToken({ host: "openworkflow", run: "run-1", signal: "signal-1", workflow: "summary" })

    for (const token of [openWorkflowToken, "hook-token", "vhsig1.not-base64!", `vhsig1.${btoa("[]")}`]) {
      const [error] = await resumeWorkflow(token, { text: "hello" })
      expect(error, token).toMatchObject({ code: "WORKFLOW_SIGNAL_TOKEN_INVALID" })
    }
  })
})

describe("inline runs (vite dev)", () => {
  beforeEach(() => {
    enableWorkflowDevRuns()
    setWorkflowRuntimeConfig({ driver: "cloudflare" })
    setWorkflowRuntimeRegistry({ summary: async () => ({ default: summary }), summaryInRootStep: async () => ({ default: summaryInRootStep }) })
  })

  afterEach(() => {
    setWorkflowDevRecorder(undefined)
  })

  it("waits in memory until `resumeWorkflow()` sends the value", async () => {
    const started = await unwrap(startWorkflow("summary"))
    await vi.waitFor(() => expect(tokens).toHaveLength(1))
    await expect(unwrap(getWorkflowRun("summary", started.id))).resolves.toMatchObject({ status: "running" })

    await expect(unwrap(resumeWorkflow(tokens[0]!, { text: "hello" }))).resolves.toEqual({ id: started.id, provider: "cloudflare" })

    await vi.waitFor(async () => {
      await expect(unwrap(getWorkflowRun("summary", started.id))).resolves.toMatchObject({ status: "completed", result: "HELLO" })
    })
    expect(calls).toEqual(["request", "summarize hello"])
  })

  it("keeps a value that comes before the wait", async () => {
    const early = folderWorkflow<undefined>(async (context) => {
      const signal = context.createSignal<Transcript>()
      tokens.push(signal.token)
      await new Promise(resolve => setTimeout(resolve, 50))
      return (await signal.wait()).text
    })
    setWorkflowRuntimeRegistry({ early: async () => ({ default: early }) })

    const started = await unwrap(startWorkflow("early"))
    await vi.waitFor(() => expect(tokens).toHaveLength(1))
    await unwrap(resumeWorkflow(tokens[0]!, { text: "early" }))

    await vi.waitFor(async () => {
      await expect(unwrap(getWorkflowRun("early", started.id))).resolves.toMatchObject({ status: "completed", result: "early" })
    })
  })

  it("fails a second value, a finished run, and a token that no run has", async () => {
    const started = await unwrap(startWorkflow("summary"))
    await vi.waitFor(() => expect(tokens).toHaveLength(1))
    await unwrap(resumeWorkflow(tokens[0]!, { text: "hello" }))
    await vi.waitFor(async () => {
      await expect(unwrap(getWorkflowRun("summary", started.id))).resolves.toMatchObject({ status: "completed" })
    })

    const [again] = await resumeWorkflow(tokens[0]!, { text: "again" })
    expect(again).toMatchObject({ code: "WORKFLOW_SIGNAL_NOT_WAITING", data: { run: started.id } })
    const [unknown] = await resumeWorkflow(createWorkflowSignalToken({ host: "inline", run: "run-x", signal: "signal-1", workflow: "summary" }), {})
    expect(unknown).toMatchObject({ code: "WORKFLOW_SIGNAL_NOT_WAITING" })
  })

  it("fails a root step that waits with the same code", async () => {
    const started = await unwrap(startWorkflow("summaryInRootStep"))

    await vi.waitFor(async () => {
      await expect(unwrap(getWorkflowRun("summaryInRootStep", started.id))).resolves.toMatchObject({ status: "failed", error: rootStepSignal })
    })
    expect(calls).toEqual(["request"])
  })
})

describe("Vercel", () => {
  it("fails `createSignal()` with a code that says signals do not work on Vercel yet", async () => {
    setWorkflowRuntimeConfig({ driver: "vercel" })
    setWorkflowRuntimeRegistry({ summary: async () => ({ default: summary }) })

    const started = await unwrap(startWorkflow("summary"))

    await vi.waitFor(async () => {
      await expect(unwrap(getWorkflowRun("summary", started.id))).resolves.toMatchObject({
        status: "failed",
        error: { code: "WORKFLOW_SIGNAL_VERCEL_UNSUPPORTED", message: expect.stringContaining("\"summary\"") },
      })
    })
    expect(calls).toEqual(["request"])
  })

  it("rejects a ViteHub token instead of looking for a Vercel hook", async () => {
    setWorkflowRuntimeConfig({ driver: "vercel" })
    const [error] = await resumeWorkflow(createWorkflowSignalToken({ host: "cloudflare", run: "run-1", signal: "signal-1", workflow: "summary" }), {})
    expect(error).toMatchObject({ code: "WORKFLOW_SIGNAL_TOKEN_INVALID", data: { provider: "vercel" } })
  })
})

describe("OpenWorkflow (SQLite)", () => {
  beforeEach(() => {
    setWorkflowRuntimeConfig({ driver: "openworkflow", sqlite: { path: ":memory:" } })
    setWorkflowRuntimeRegistry({ summary: async () => ({ default: summary }), summaryInRootStep: async () => ({ default: summaryInRootStep }) })
  })

  afterEach(async () => {
    await resetOpenWorkflowRuntime()
  })

  async function tick(): Promise<void> {
    const worker = await createOpenWorkflowWorker()
    await worker.tick()
    await worker.stop()
  }

  it("wakes the run with the value of `resumeWorkflow()`", async () => {
    const started = await unwrap(startWorkflow("summary"))

    await tick()
    await expect(unwrap(getWorkflowRun("summary", started.id))).resolves.toMatchObject({ status: "running", steps: [{ name: "signal-1", status: "running" }] })
    expect(tokens).toEqual([createWorkflowSignalToken({ host: "openworkflow", run: started.id, signal: "signal-1", workflow: "summary" })])

    await expect(unwrap(resumeWorkflow(tokens[0]!, { text: "hello" }))).resolves.toEqual({ id: started.id, provider: "openworkflow" })
    await tick()

    await expect(unwrap(getWorkflowRun("summary", started.id))).resolves.toMatchObject({ status: "completed", result: "HELLO" })
    expect(calls).toEqual(["request", "request", "summarize hello"])
    expect(tokens[1]).toBe(tokens[0])
    const [finished] = await resumeWorkflow(tokens[0]!, { text: "again" })
    expect(finished).toMatchObject({ code: "WORKFLOW_SIGNAL_NOT_WAITING" })
  })

  it("does not deliver a signal to a cancelled run with a pending wait", async () => {
    const started = await unwrap(startWorkflow("summary", undefined, { id: "cancelled-summary" }))
    await tick()
    await expect(unwrap(getWorkflowRun("summary", started.id))).resolves.toMatchObject({ steps: [{ name: "signal-1", status: "running" }] })
    await expect(unwrap(cancelWorkflow("summary", started.id))).resolves.toMatchObject({ status: "cancelled" })

    const [error] = await resumeWorkflow(tokens[0]!, { text: "too late" })
    expect(error).toMatchObject({ code: "WORKFLOW_SIGNAL_NOT_WAITING" })
  })

  it("fails a value that comes before the wait, so the caller can retry", async () => {
    const started = await unwrap(startWorkflow("summary"))
    const token = createWorkflowSignalToken({ host: "openworkflow", run: started.id, signal: "signal-1", workflow: "summary" })

    const [error] = await resumeWorkflow(token, { text: "early" })
    expect(error).toMatchObject({ code: "WORKFLOW_SIGNAL_NOT_WAITING", data: { run: started.id } })

    await tick()
    await unwrap(resumeWorkflow(token, { text: "retried" }))
    await tick()
    await expect(unwrap(getWorkflowRun("summary", started.id))).resolves.toMatchObject({ status: "completed", result: "RETRIED" })
  })

  it("fails a root step that waits at once", async () => {
    const started = await unwrap(startWorkflow("summaryInRootStep"))

    await tick()

    await expect(unwrap(getWorkflowRun("summaryInRootStep", started.id))).resolves.toMatchObject({ status: "failed" })
    expect(calls).toEqual(["request"])
  })
})
