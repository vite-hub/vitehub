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

  it("does not translate a spoofed error tag when Error.isError is unavailable", async () => {
    const original = { isRetryable: false, [Symbol.toStringTag]: "Error" }
    const createNonRetryableError = vi.fn((_error: Error & { isRetryable: false }) => new Error("converted"))
    const descriptor = Object.getOwnPropertyDescriptor(Error, "isError")
    try {
      Reflect.deleteProperty(Error, "isError")
      await expect(runCloudflareWorkflow({
        config: { provider: "cloudflare" },
        createNonRetryableError,
        env: {},
        event: { id: "spoofed-error" },
        name: "spoofed-error",
        registry: {
          "spoofed-error": async () => ({
            default: { handler: async () => { throw original } },
          }),
        },
      })).rejects.toBe(original)
      expect(createNonRetryableError).not.toHaveBeenCalled()
    }
    finally {
      if (descriptor) Object.defineProperty(Error, "isError", descriptor)
    }
  })

  it("translates a cross-realm error with a non-cloneable own field when Error.isError is unavailable", async () => {
    const original = runInNewContext("(() => { const error = new Error('non-cloneable input'); error.context = () => {}; error.isRetryable = false; return error })()") as Error & { isRetryable: false }
    const createNonRetryableError = vi.fn((_error: Error & { isRetryable: false }) => new Error("converted"))
    const descriptor = Object.getOwnPropertyDescriptor(Error, "isError")
    try {
      Reflect.deleteProperty(Error, "isError")
      await expect(runCloudflareWorkflow({
        config: { provider: "cloudflare" },
        createNonRetryableError,
        env: {},
        event: { id: "non-cloneable-error" },
        name: "non-cloneable-error",
        registry: {
          "non-cloneable-error": async () => ({
            default: { handler: async () => { throw original } },
          }),
        },
      })).rejects.toMatchObject({ message: "converted" })
      expect(createNonRetryableError).toHaveBeenCalledWith(original)
    }
    finally {
      if (descriptor) Object.defineProperty(Error, "isError", descriptor)
    }
  })

  it("does not translate a sealed non-cloneable error without a trusted brand predicate when Error.isError is unavailable", async () => {
    const original = runInNewContext("(() => { const error = new Error('sealed non-cloneable input'); Object.defineProperty(error, 'cause', { value: () => {}, configurable: false }); error.isRetryable = false; return error })()") as Error & { isRetryable: false }
    const createNonRetryableError = vi.fn((_error: Error & { isRetryable: false }) => new Error("converted"))
    const descriptor = Object.getOwnPropertyDescriptor(Error, "isError")
    try {
      Reflect.deleteProperty(Error, "isError")
      await expect(runCloudflareWorkflow({
        config: { provider: "cloudflare" },
        createNonRetryableError,
        env: {},
        event: { id: "sealed-non-cloneable-error" },
        name: "sealed-non-cloneable-error",
        registry: {
          "sealed-non-cloneable-error": async () => ({
            default: { handler: async () => { throw original } },
          }),
        },
      })).rejects.toBe(original)
      expect(createNonRetryableError).not.toHaveBeenCalled()
    }
    finally {
      if (descriptor) Object.defineProperty(Error, "isError", descriptor)
    }
  })

  it("does not trust a proxy-backed candidate Error.isError predicate", async () => {
    const spoofConstructor = new Proxy(function Error() {}, {
      get(target, property, receiver) {
        if (property === "name") return "Error"
        if (property === "prototype") return receiverPrototype
        if (property === "isError") return () => true
        return Reflect.get(target, property, receiver)
      },
    })
    const receiverPrototype = Object.create(null) as Record<PropertyKey, unknown>
    Object.defineProperty(receiverPrototype, "constructor", { value: spoofConstructor })
    const original = Object.create(receiverPrototype) as Error & { isRetryable: false }
    original.isRetryable = false
    const createNonRetryableError = vi.fn((_error: Error & { isRetryable: false }) => new Error("converted"))
    const descriptor = Object.getOwnPropertyDescriptor(Error, "isError")
    try {
      Reflect.deleteProperty(Error, "isError")
      await expect(runCloudflareWorkflow({
        config: { provider: "cloudflare" },
        createNonRetryableError,
        env: {},
        event: { id: "constructor-predicate-spoof" },
        name: "constructor-predicate-spoof",
        registry: {
          "constructor-predicate-spoof": async () => ({
            default: { handler: async () => { throw original } },
          }),
        },
      })).rejects.toBe(original)
      expect(createNonRetryableError).not.toHaveBeenCalled()
    }
    finally {
      if (descriptor) Object.defineProperty(Error, "isError", descriptor)
    }
  })

  it.each(["local", "foreign"])("does not translate a %s Error.prototype spoof when Error.isError is unavailable", async (realm) => {
    const original = (realm === "local" ? Object.create(Error.prototype) : runInNewContext("Object.create(Error.prototype)")) as Error & { isRetryable: false }
    Object.defineProperty(original, Symbol.toStringTag, { value: "Error" })
    original.isRetryable = false
    const createNonRetryableError = vi.fn((_error: Error & { isRetryable: false }) => new Error("converted"))
    const descriptor = Object.getOwnPropertyDescriptor(Error, "isError")
    try {
      Reflect.deleteProperty(Error, "isError")
      await expect(runCloudflareWorkflow({
        config: { provider: "cloudflare" },
        createNonRetryableError,
        env: {},
        event: { id: "prototype-spoofed-error" },
        name: "prototype-spoofed-error",
        registry: {
          "prototype-spoofed-error": async () => ({
            default: { handler: async () => { throw original } },
          }),
        },
      })).rejects.toBe(original)
      expect(createNonRetryableError).not.toHaveBeenCalled()
    }
    finally {
      if (descriptor) Object.defineProperty(Error, "isError", descriptor)
    }
  })

  it.each(["local", "foreign"])("does not translate a %s Error.prototype spoof with an inherited message", async (realm) => {
    const original = (realm === "local" ? Object.create(Error.prototype) : runInNewContext("Object.create(Error.prototype)")) as Error & { isRetryable: false }
    Object.defineProperty(original, Symbol.toStringTag, { value: "Error" })
    original.isRetryable = false
    const createNonRetryableError = vi.fn((_error: Error & { isRetryable: false }) => new Error("converted"))
    const descriptor = Object.getOwnPropertyDescriptor(Error, "isError")
    try {
      Reflect.deleteProperty(Error, "isError")
      await expect(runCloudflareWorkflow({
        config: { provider: "cloudflare" },
        createNonRetryableError,
        env: {},
        event: { id: "inherited-message-spoofed-error" },
        name: "inherited-message-spoofed-error",
        registry: {
          "inherited-message-spoofed-error": async () => ({
            default: { handler: async () => { throw original } },
          }),
        },
      })).rejects.toBe(original)
      expect(createNonRetryableError).not.toHaveBeenCalled()
    }
    finally {
      if (descriptor) Object.defineProperty(Error, "isError", descriptor)
    }
  })

  it("does not translate an Error.prototype spoof with a fabricated message", async () => {
    const original = Object.create(Error.prototype) as Error & { isRetryable: false }
    Object.defineProperties(original, {
      [Symbol.toStringTag]: { value: "Error" },
      message: { value: "spoofed" },
      isRetryable: { value: false },
    })
    const createNonRetryableError = vi.fn((_error: Error & { isRetryable: false }) => new Error("converted"))
    const descriptor = Object.getOwnPropertyDescriptor(Error, "isError")
    try {
      Reflect.deleteProperty(Error, "isError")
      await expect(runCloudflareWorkflow({
        config: { provider: "cloudflare" },
        createNonRetryableError,
        env: {},
        event: { id: "message-spoofed-error" },
        name: "message-spoofed-error",
        registry: {
          "message-spoofed-error": async () => ({
            default: { handler: async () => { throw original } },
          }),
        },
      })).rejects.toBe(original)
      expect(createNonRetryableError).not.toHaveBeenCalled()
    }
    finally {
      if (descriptor) Object.defineProperty(Error, "isError", descriptor)
    }
  })

  it("does not translate an Error.prototype spoof with a fabricated stack", async () => {
    const original = Object.create(Error.prototype) as Error & { isRetryable: false }
    Object.defineProperties(original, {
      [Symbol.toStringTag]: { value: "Error" },
      stack: { value: "spoofed stack" },
      isRetryable: { value: false },
    })
    const createNonRetryableError = vi.fn((_error: Error & { isRetryable: false }) => new Error("converted"))
    const descriptor = Object.getOwnPropertyDescriptor(Error, "isError")
    try {
      Reflect.deleteProperty(Error, "isError")
      await expect(runCloudflareWorkflow({
        config: { provider: "cloudflare" },
        createNonRetryableError,
        env: {},
        event: { id: "stack-spoofed-error" },
        name: "stack-spoofed-error",
        registry: {
          "stack-spoofed-error": async () => ({
            default: { handler: async () => { throw original } },
          }),
        },
      })).rejects.toBe(original)
      expect(createNonRetryableError).not.toHaveBeenCalled()
    }
    finally {
      if (descriptor) Object.defineProperty(Error, "isError", descriptor)
    }
  })

})
