import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { runInNewContext } from "node:vm"

import { transform } from "esbuild"
import { Diagnostic } from "nostics"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

import { writeProviderEntries } from "../src/internal/vite-build.ts"
import { runCloudflareWorkflow } from "../src/runtime/cloudflare-runner.ts"
import type { WorkflowDefinitionRegistry, WorkflowProviderStep } from "../src/types.ts"

let rootDir: string
let generatedCode: string
let generatedSource: string

beforeAll(async () => {
  const baseDir = new URL("../.vitest-tmp/", import.meta.url)
  await mkdir(baseDir, { recursive: true })
  rootDir = await mkdtemp(join(baseDir.pathname, "cloudflare-errors-"))
  const artifacts = await writeProviderEntries(rootDir, { provider: "cloudflare" })
  generatedSource = await readFile(artifacts.cloudflareWorkerFile, "utf8")
  // The VM below has no ESM loader, so dynamic imports become require calls.
  generatedCode = (await transform(generatedSource, { format: "cjs", supported: { "dynamic-import": false } })).code
})

afterAll(async () => {
  if (rootDir) await rm(rootDir, { force: true, recursive: true })
})

function loadGeneratedDispatcher(registry: WorkflowDefinitionRegistry) {
  const constructions = vi.fn()
  // cloudflare:workflows is host-only. Match its two-argument constructor;
  // a third ErrorOptions argument is ignored by the native implementation.
  class NonRetryableError extends Error {
    constructor(message: string, name = "NonRetryableError") {
      super(message)
      this.name = name
      constructions(message, name)
    }
  }
  const module = { exports: {} }
  const dispatcher: unknown = runInNewContext(`${generatedCode}\nmodule.exports.runViteHubWorkflowDefinition`, {
    module,
    require(id: string) {
      switch (id) {
        case "@vite-hub/workflow/runtime/cloudflare-vite":
          return { createWorkflowCloudflareWorker: () => ({}), installWorkflowCloudflareRuntime: () => {} }
        case "@vite-hub/workflow/runtime/cloudflare-runner":
          return { runCloudflareWorkflow }
        case "./registry.mjs":
          return { default: registry, __esModule: true }
        case "cloudflare:workflows":
          return { NonRetryableError }
        default:
          throw new Error(`Unexpected generated import: ${id}`)
      }
    },
  })
  if (typeof dispatcher !== "function") throw new Error("Missing generated Workflow dispatcher")
  return { constructions, NonRetryableError, run: async (step: WorkflowProviderStep): Promise<unknown> => await dispatcher("reject", {}, { id: "run-reject" }, step) }
}

it("loads without cloudflare:workflows, as the Node.js prerender build of a Nuxt app does", () => {
  expect(generatedSource).not.toMatch(/^import .*["']cloudflare:workflows["']/m)
  const module = { exports: {} }
  expect(() => runInNewContext(generatedCode, {
    module,
    require(id: string) {
      if (id === "cloudflare:workflows") throw new Error("Only URLs with a scheme in: file, data, and node are supported")
      if (id === "@vite-hub/workflow/runtime/cloudflare-vite") return { createWorkflowCloudflareWorker: () => ({}), installWorkflowCloudflareRuntime: () => {} }
      return {}
    },
  })).not.toThrow()
})

const boundaries = ["root", "root step", "explicit step"] as const
const stepOptions = { retries: { limit: 2, delay: "1 second" } }

function createRegistry(boundary: typeof boundaries[number], original: unknown): WorkflowDefinitionRegistry {
  return {
    reject: async () => ({
      default: {
        options: { rootStep: boundary === "root step" },
        handler: async (_payload, { step }) => {
          const fail = () => { throw original }
          return boundary === "explicit step" ? await step!.do!("validate", stepOptions, fail) : fail()
        },
      },
    }),
  }
}

function createStep() {
  const caught = vi.fn()
  const step = {
    async do<TResult>(_name: string, _options: unknown, run: () => TResult | Promise<TResult>): Promise<TResult> {
      try {
        return await run()
      }
      catch (error) {
        caught(error)
        throw error
      }
    },
  } satisfies WorkflowProviderStep
  vi.spyOn(step, "do")
  return { caught, step }
}

describe("generated Cloudflare Workflow errors", () => {
  it.each(boundaries)("retains the diagnostic cause at the %s boundary", async (boundary) => {
    const original = Object.assign(new Diagnostic({
      code: "WORKFLOW_TEST_REJECTED",
      why: "Step input is invalid.",
      fix: "Use a non-empty key.",
      docs: "https://example.test/workflow",
      sources: ["server/workflows/reject.ts:9:3"],
      cause: new Error("Missing key"),
    }), { isRetryable: false })
    const originalStack = original.stack
    const descriptors = Object.getOwnPropertyDescriptors(original)
    const { constructions, NonRetryableError, run } = loadGeneratedDispatcher(createRegistry(boundary, original))
    const { caught, step } = createStep()
    const converted = await run(step).catch((error: unknown) => error)

    expect(converted).toBeInstanceOf(NonRetryableError)
    if (!(converted instanceof NonRetryableError)) throw new Error("Expected a native non-retryable error")
    expect(converted).toMatchObject({ name: original.name, message: original.message })
    expect(converted.cause).toBe(original)
    expect(original.stack).toBe(originalStack)
    expect(Object.getOwnPropertyDescriptor(converted, "cause")).toEqual({
      value: original, configurable: true, enumerable: false, writable: true,
    })
    expect(Object.getOwnPropertyDescriptors(original)).toEqual(descriptors)
    expect(constructions).toHaveBeenCalledExactlyOnceWith(original.message, original.name)
    if (boundary === "root") {
      expect(step.do).not.toHaveBeenCalled()
    }
    else {
      expect(caught).toHaveBeenCalledExactlyOnceWith(converted)
      if (boundary === "explicit step") expect(step.do).toHaveBeenCalledWith("validate", stepOptions, expect.any(Function))
    }
  })

  it.each(boundaries)("passes retryable errors through the %s boundary", async (boundary) => {
    for (const original of [new Error("Retry me"), Object.assign(new Error("Retry me"), { isRetryable: true })]) {
      const { constructions, run } = loadGeneratedDispatcher(createRegistry(boundary, original))
      const { caught, step } = createStep()
      await expect(run(step)).rejects.toBe(original)
      expect(constructions).not.toHaveBeenCalled()
      if (boundary !== "root") expect(caught).toHaveBeenCalledExactlyOnceWith(original)
    }
  })
})
