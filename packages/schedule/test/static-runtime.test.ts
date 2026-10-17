import { runInNewContext } from "node:vm"

import { describe, expect, it } from "vitest"

import { executeCloudflareStaticSchedules, executeMatchingStaticSchedules, executeStaticSchedule, missingScheduleDefinitionError, normalizeScheduleRuntimeError, unwrapScheduleDefinition } from "../src/runtime/static.ts"

import type { ScheduleDefinition, ScheduleDefinitionRegistry } from "../src/types.ts"

describe("Static Schedule runtime", () => {
  it("identifies a missing generated Schedule Definition", () => {
    expect(missingScheduleDefinitionError("cleanup")).toMatchObject({
      code: "SCHEDULE_R0034",
      message: "Missing schedule definition: cleanup",
    })
  })

  it("rejects an invalid scheduledAt value before formatting the run id", async () => {
    await expect(executeStaticSchedule({
      cron: "0 4 * * *",
      definition: { cron: "0 4 * * *", handler: async () => {} },
      name: "report",
      scheduledAt: new Date("invalid"),
    })).rejects.toMatchObject({
      code: "SCHEDULE_INVALID_SCHEDULED_AT",
      details: { field: "scheduledAt", valueType: "date" },
    })
  })

  it("rejects dates whose brand lookup throws", async () => {
    const scheduledAt = Object.defineProperty({}, Symbol.toStringTag, {
      get() {
        throw new Error("spoofed date")
      },
    }) as Date
    await expect(executeStaticSchedule({
      cron: "0 4 * * *",
      definition: { cron: "0 4 * * *", handler: async () => {} },
      name: "report",
      scheduledAt,
    })).rejects.toMatchObject({
      code: "SCHEDULE_INVALID_SCHEDULED_AT",
    })
  })

  it("rejects an invalid scheduledAt value before loading matching definitions", async () => {
    let loaded = false
    await expect(executeMatchingStaticSchedules({
      cron: "0 4 * * *",
      registry: {
        report: async () => {
          loaded = true
          return { cron: "0 4 * * *", handler: async () => {} }
        },
      },
      scheduledAt: new Date("invalid"),
    })).rejects.toMatchObject({
      code: "SCHEDULE_INVALID_SCHEDULED_AT",
      details: { field: "scheduledAt", valueType: "date" },
    })
    expect(loaded).toBe(false)
  })

  it.each([42, true, {}, ["0 4 * * *"], "   "])("rejects malformed provider cron values before loading definitions: %j", async (cron) => {
    let loaded = false
    const registry = { report: async () => {
      loaded = true
      return { cron: "0 4 * * *", handler: async () => {} }
    } }
    await expect(executeMatchingStaticSchedules({ cron: cron as never, registry }))
      .rejects.toMatchObject({ code: "SCHEDULE_INVALID_CRON", details: { field: "cron" } })
    await expect(executeCloudflareStaticSchedules({ controller: { cron: cron as never } }, { registry }))
      .rejects.toMatchObject({ code: "SCHEDULE_R0027" })
    expect(loaded).toBe(false)
  })

  it("executes all static schedules matching a cron", async () => {
    const calls: string[] = []
    const registry: ScheduleDefinitionRegistry = {
      cleanup: async () => ({
        default: {
          cron: "0 4 * * *",
          handler: async ({ scheduledAt }) => calls.push(`cleanup:${scheduledAt.toISOString()}`),
        },
      }),
      report: async () => ({
        cron: "0 4 * * *",
        handler: async ({ scheduledAt }) => calls.push(`report:${scheduledAt.toISOString()}`),
      }),
      // A registry entry without a cron is not a Static Schedule Definition, so cron dispatch skips it.
      cronless: async () => ({ handler: async () => calls.push("cronless") }) as unknown as ScheduleDefinition,
      skipped: async () => ({
        default: {
          cron: "0 5 * * *",
          handler: async () => calls.push("skipped"),
        },
      }),
    }

    await executeMatchingStaticSchedules({
      cron: "0 4 * * *",
      registry,
      scheduledAt: new Date("2026-06-12T04:00:00.000Z"),
    })

    expect(calls).toEqual([
      "cleanup:2026-06-12T04:00:00.000Z",
      "report:2026-06-12T04:00:00.000Z",
    ])
  })

  it("matches equivalent cron whitespace from provider events", async () => {
    const calls: string[] = []
    await executeMatchingStaticSchedules({
      cron: "0 4 * * *",
      registry: {
        report: async () => ({
          cron: "0  4   * * *",
          handler: async () => calls.push("report"),
        }),
      },
    })
    expect(calls).toEqual(["report"])
  })

  it("skips malformed cron values without aborting other matching schedules", async () => {
    const calls: string[] = []
    await executeMatchingStaticSchedules({
      cron: "0 4 * * *",
      registry: {
        malformed: async () => ({ cron: 42 as never, handler: () => calls.push("invalid") }),
        report: async () => ({ cron: "0  4 * * *", handler: () => calls.push("report") }),
      },
    })
    expect(calls).toEqual(["report"])
    expect(unwrapScheduleDefinition({ default: { cron: null, handler: () => {} } })).toBeUndefined()
  })

  it("executes and unwraps static definitions with cross-realm handlers", async () => {
    const calls: string[] = []
    const handler = runInNewContext('() => calls.push("cross-realm")', { calls }) as () => void
    const definition = { cron: "0 4 * * *", handler }
    expect(handler).not.toBeInstanceOf(Function)
    expect(unwrapScheduleDefinition({ default: definition })).toBe(definition)

    await executeMatchingStaticSchedules({
      cron: definition.cron,
      registry: { report: async () => definition },
    })
    expect(calls).toEqual(["cross-realm"])
  })

  it("ignores inherited schedule definition markers", async () => {
    const calls: string[] = []
    const inherited = {
      default: {
        cron: "0 4 * * *",
        handler: async () => calls.push("inherited"),
      },
    }
    const registry: ScheduleDefinitionRegistry = {
      inherited: async () => Object.create(inherited),
    }

    await executeMatchingStaticSchedules({
      cron: "0 4 * * *",
      registry,
    })

    expect(calls).toEqual([])
  })

  it("executes Cloudflare scheduled events with runtime env active", async () => {
    const seen: Array<string | undefined> = []
    const deferred: Promise<unknown>[] = []
    let deferredEnv: string | undefined
    let releaseDeferred: (() => void) | undefined
    const registry: ScheduleDefinitionRegistry = {
      sync: async () => ({
        default: {
          cron: "0 4 * * *",
          handler: async ({ waitUntil }) => {
            // SAFETY: This test installs __env__ through the Cloudflare runtime boundary immediately before the handler runs.
            seen.push((globalThis as { __env__?: Record<string, unknown> }).__env__?.AIRTABLE_TOKEN as string | undefined)
            waitUntil(new Promise<string>((resolve) => {
              releaseDeferred = () => {
                // SAFETY: Deferred work runs while the same Cloudflare runtime environment remains installed.
                deferredEnv = (globalThis as { __env__?: Record<string, unknown> }).__env__?.AIRTABLE_TOKEN as string | undefined
                resolve("recorded")
              }
            }))
          },
        },
      }),
    }

    await executeCloudflareStaticSchedules({
      controller: {
        cron: "0 4 * * *",
        scheduledTime: "2026-06-12T04:00:00.000Z",
      },
      env: {
        AIRTABLE_TOKEN: "airtable-secret",
      },
      waitUntil: (promise: Promise<unknown>) => deferred.push(promise),
    }, { registry })

    expect(seen).toEqual(["airtable-secret"])
    expect(releaseDeferred).toBeTypeOf("function")
    // SAFETY: The Cloudflare runtime installs __env__ for the full deferred-work lifetime asserted here.
    expect((globalThis as { __env__?: Record<string, unknown> }).__env__?.AIRTABLE_TOKEN).toBe("airtable-secret")
    releaseDeferred!()
    await expect(Promise.all(deferred)).resolves.toEqual(["recorded", undefined])
    expect(deferredEnv).toBe("airtable-secret")
    // SAFETY: The runtime owns the optional __env__ bridge and removes it after deferred work settles.
    expect((globalThis as { __env__?: Record<string, unknown> }).__env__).toBeUndefined()
  })

  it("accepts Cloudflare waitUntil separately from the scheduled event", async () => {
    const deferred: Promise<unknown>[] = []
    await executeCloudflareStaticSchedules({
      controller: { cron: "0 4 * * *", scheduledTime: "2026-06-12T04:00:00.000Z" },
    }, {
      registry: {
        report: async () => ({
          cron: "0 4 * * *",
          handler: async ({ waitUntil }) => waitUntil(Promise.resolve("recorded")),
        }),
      },
      waitUntil: promise => deferred.push(Promise.resolve(promise)),
    })

    await expect(Promise.all(deferred)).resolves.toEqual(["recorded"])
  })

  it("forwards deferred work to a Cloudflare waitUntil from another realm", async () => {
    const deferred: Promise<unknown>[] = []
    // SAFETY: The VM expression returns the documented single-argument waitUntil callback used by this test.
    const waitUntil = runInNewContext("promise => deferred.push(promise)", { deferred }) as (promise: Promise<unknown>) => void

    await executeCloudflareStaticSchedules({
      controller: { cron: "0 4 * * *", scheduledTime: "2026-06-12T04:00:00.000Z" },
      context: { waitUntil },
    }, {
      registry: {
        report: async () => ({
          cron: "0 4 * * *",
          handler: async ({ waitUntil }) => waitUntil(Promise.resolve("recorded")),
        }),
      },
    })

    await expect(Promise.all(deferred)).resolves.toEqual(["recorded"])
  })

  it("drains deferred work before returning a handler failure", async () => {
    let releaseDeferred: (() => void) | undefined
    let deferredCompleted = false
    const execution = executeStaticSchedule({
      cron: "0 4 * * *",
      definition: {
        cron: "0 4 * * *",
        handler: async ({ waitUntil }) => {
          waitUntil(new Promise<void>((resolve) => {
            releaseDeferred = () => {
              deferredCompleted = true
              resolve()
            }
          }))
          throw new Error("handler failed")
        },
      },
      name: "report",
    })

    await expect.poll(() => releaseDeferred).toBeTypeOf("function")
    releaseDeferred!()

    await expect(execution).rejects.toThrow("handler failed")
    expect(deferredCompleted).toBe(true)
  })
})

it("preserves errors raised in another runtime realm", async () => {
  const foreign = runInNewContext("new Error('foreign failure')") as Error
  expect(normalizeScheduleRuntimeError(foreign)).toBe(foreign)
})

it("uses the intrinsic Error prototype when Error.isError is unavailable", () => {
  const errorConstructor = Error as ErrorConstructor & { isError?: (value: unknown) => boolean }
  const nativeIsError = errorConstructor.isError
  errorConstructor.isError = undefined
  try {
    const taggedForeign = runInNewContext(`(() => {
      const error = new Error('tagged foreign failure')
      Object.defineProperty(error, Symbol.toStringTag, { value: 'ProviderError' })
      return error
    })()`) as Error
    const fake = Object.create({ [Symbol.toStringTag]: "Error" })
    const foreignPrototypeSpoof = runInNewContext("Object.create(Error.prototype)")
    expect(normalizeScheduleRuntimeError(taggedForeign)).toBe(taggedForeign)
    expect(normalizeScheduleRuntimeError(fake)).toMatchObject({ code: "SCHEDULE_R0035", cause: fake })
    expect(normalizeScheduleRuntimeError(foreignPrototypeSpoof)).toMatchObject({
      code: "SCHEDULE_R0035",
      cause: foreignPrototypeSpoof,
    })
  }
  finally {
    errorConstructor.isError = nativeIsError
  }
})

it("wraps spoofed and hostile thrown values safely", () => {
  const spoof = { [Symbol.toStringTag]: "Error" }
  const customPrototypeSpoof = Object.create({ [Symbol.toStringTag]: "Error" })
  const hostile = new Proxy({}, {
    get() {
      throw new Error("tag access failed")
    },
    getPrototypeOf() {
      throw new Error("prototype access failed")
    },
  })

  expect(normalizeScheduleRuntimeError(spoof)).toMatchObject({ code: "SCHEDULE_R0035", cause: spoof })
  expect(normalizeScheduleRuntimeError(customPrototypeSpoof)).toMatchObject({ code: "SCHEDULE_R0035", cause: customPrototypeSpoof })
  const normalizedHostile = normalizeScheduleRuntimeError(hostile)
  expect(normalizedHostile).toMatchObject({ code: "SCHEDULE_R0035" })
  expect(normalizedHostile.cause).toBe(hostile)
})

it("does not trust a replaced Error.isError predicate", () => {
  const errorConstructor = Error as ErrorConstructor & { isError?: (value: unknown) => boolean }
  const nativeIsError = errorConstructor.isError
  errorConstructor.isError = () => true
  const spoof = { message: "not an Error" }
  let normalized: Error
  try {
    normalized = normalizeScheduleRuntimeError(spoof)
  }
  finally {
    errorConstructor.isError = nativeIsError
  }
  expect(normalized).toMatchObject({ code: "SCHEDULE_R0035", cause: spoof })
})

it("does not trust a replaced util.types.isNativeError predicate", () => {
  const processWithBuiltinModule = process as typeof process & {
    getBuiltinModule?: (name: string) => unknown
  }
  const util = processWithBuiltinModule.getBuiltinModule?.("util") as {
    types?: { isNativeError?: (value: unknown) => boolean }
  } | undefined
  if (typeof util?.types?.isNativeError !== "function") return

  const nativeIsNativeError = util.types.isNativeError
  util.types.isNativeError = () => true
  const spoof = { message: "not an Error" }
  let normalized: Error
  try {
    normalized = normalizeScheduleRuntimeError(spoof)
  }
  finally {
    util.types.isNativeError = nativeIsNativeError
  }
  expect(normalized).toMatchObject({ code: "SCHEDULE_R0035", cause: spoof })
})

it("wraps values whose coercion throws the runtime failure message", () => {
  const thrownValue = {
    toString() {
      throw new Error("runtime error coercion failed")
    },
  }
  const normalized = normalizeScheduleRuntimeError(thrownValue)
  expect(normalized).toMatchObject({ code: "SCHEDULE_R0035" })
  expect(normalized.cause).toBe(thrownValue)
})
