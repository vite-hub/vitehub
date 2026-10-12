import { runInNewContext } from "node:vm"

import { describe, expect, it, vi } from "vitest"

import type { WorkflowProviderStep } from "../src/types.ts"
import { runCloudflareWorkflow } from "../src/runtime/cloudflare-runner.ts"

describe("Cloudflare workflow errors", () => {
  it("translates an explicitly non-retryable error from another realm", async () => {
    // SAFETY: The VM fixture intentionally creates the cross-realm error that a worker can receive.
    const original = runInNewContext("Object.assign(new Error('invalid input'), { isRetryable: false })") as Error & { isRetryable: false }
    const converted = new Error("non-retryable: invalid input")
    const createNonRetryableError = vi.fn((_error: Error & { isRetryable: false }) => converted)
    const step = {
      do: vi.fn(async (_name: string, _options: unknown, run: () => unknown) => await run()),
    } as WorkflowProviderStep

    await expect(runCloudflareWorkflow({
      config: { provider: "cloudflare" },
      createNonRetryableError,
      env: {},
      event: { id: "run-foreign" },
      name: "foreign-error",
      registry: {
        "foreign-error": async () => ({
          default: {
            handler: async () => {
              throw original
            },
          },
        }),
      },
      step,
    })).rejects.toBe(converted)

    expect(createNonRetryableError).toHaveBeenCalledWith(original)
  })

  it.each(["own", "inherited"])("translates a cross-realm error with %s Symbol.toStringTag when Error.isError is unavailable", async (tagPlacement) => {
    const original = runInNewContext(`(() => {
      const error = new Error("tagged input")
      Object.defineProperty(${tagPlacement === "own" ? "error" : "Object.getPrototypeOf(error)"}, Symbol.toStringTag, { value: "Error" })
      error.isRetryable = false
      return error
    })()`) as Error & { isRetryable: false }
    const converted = new Error("non-retryable: tagged input")
    const createNonRetryableError = vi.fn((_error: Error & { isRetryable: false }) => converted)
    const step = {
      do: vi.fn(async (_name: string, _options: unknown, run: () => unknown) => await run()),
    } as WorkflowProviderStep
    const descriptor = Object.getOwnPropertyDescriptor(Error, "isError")
    try {
      Reflect.deleteProperty(Error, "isError")
      await expect(runCloudflareWorkflow({
        config: { provider: "cloudflare" },
        createNonRetryableError,
        env: {},
        event: { id: `tagged-${tagPlacement}` },
        name: "tagged-error",
        registry: {
          "tagged-error": async () => ({
            default: { handler: async () => { throw original } },
          }),
        },
        step,
      })).rejects.toBe(converted)
      expect(createNonRetryableError).toHaveBeenCalledWith(original)
    }
    finally {
      if (descriptor) Object.defineProperty(Error, "isError", descriptor)
    }
  })

})
