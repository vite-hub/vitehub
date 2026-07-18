import { ViteHubError } from "@vite-hub/runtime"
import { describe, expect, it } from "vitest"

import { createMemoryRuntimeScheduleStore, ScheduleError, schedules, validateRuntimeScheduleCron } from "../src/index.ts"

describe("ScheduleError", () => {
  it("preserves its public identity and serializes only stable ViteHub fields", () => {
    const cause = new Error("private-provider-cause")
    const error = new ScheduleError("SCHEDULE_NOT_FOUND", {
      cause,
      requestId: "request-1",
    })

    expect(error).toBeInstanceOf(Error)
    expect(error).toBeInstanceOf(ViteHubError)
    expect(error).toBeInstanceOf(ScheduleError)
    expect(error.name).toBe("ScheduleError")
    expect(error.cause).toBe(cause)
    expect(error.httpStatus).toBe(404)
    expect(error.toJSON()).toEqual({
      code: "SCHEDULE_NOT_FOUND",
      message: "Runtime Schedule was not found.",
      requestId: "request-1",
    })

    const json = JSON.stringify(error)
    expect(json).not.toContain("private-provider-cause")
    expect(json).not.toContain("cause")
    expect(json).not.toContain("httpStatus")
    expect(json).not.toContain("stack")
  })

  it("rejects unknown codes without echoing them", () => {
    const secret = "PROVIDER_TOKEN_private-secret"
    let error: unknown
    try {
      new ScheduleError(secret as never)
    }
    catch (cause) {
      error = cause
    }

    expect(error).toBeInstanceOf(TypeError)
    expect(String(error)).not.toContain(secret)
  })

  it("normalizes hostile options to fixed JSON-safe output", () => {
    const secret = "https://example.test/path?token=private-token"
    const details = {
      get field() {
        throw new Error(secret)
      },
      value: 1n,
    }
    const error = new ScheduleError("SCHEDULE_NOT_FOUND", {
      details,
      requestId: secret,
    } as never)

    expect(error.toJSON()).toEqual({
      code: "SCHEDULE_NOT_FOUND",
      message: "Runtime Schedule was not found.",
    })
    expect(JSON.stringify(error)).not.toContain(secret)
  })

  it("keeps its trusted public shape immutable after construction", () => {
    const error = new ScheduleError("SCHEDULE_INVALID_CRON", {
      details: { field: "cron", valueType: "string" },
      requestId: "request-1",
    })
    const secret = "https://user:token@example.com/private"

    expect(Reflect.set(error, "code", "PROVIDER_SECRET")).toBe(false)
    expect(Reflect.set(error, "message", secret)).toBe(false)
    expect(Reflect.set(error, "requestId", secret)).toBe(false)
    expect(Reflect.set(error, "retryable", true)).toBe(false)
    expect(Reflect.set(error.details!, "field", secret)).toBe(false)
    expect(JSON.stringify(error)).not.toContain(secret)
  })

  it("keeps the built Schedule error shape immutable", async () => {
    const { ScheduleError: BuiltScheduleError } = await import("../dist/index.js")
    const error = new BuiltScheduleError("SCHEDULE_INVALID_CRON", {
      details: { field: "cron", valueType: "string" },
      requestId: "request-1",
    } as never)
    const secret = "https://user:token@example.com/private"

    expect(Reflect.set(error, "code", "PROVIDER_SECRET")).toBe(false)
    expect(Reflect.set(error, "message", secret)).toBe(false)
    expect(Reflect.set(error.details!, "field", secret)).toBe(false)
    expect(JSON.stringify(error)).not.toContain(secret)
  })

  it("redacts invalid cron values from messages, details, and JSON", () => {
    const secret = "private-cron-value"

    let error: unknown
    try {
      validateRuntimeScheduleCron(secret)
    }
    catch (cause) {
      error = cause
    }

    expect(error).toBeInstanceOf(ScheduleError)
    expect(error).toMatchObject({
      code: "SCHEDULE_INVALID_CRON",
      details: { field: "cron", valueType: "string" },
    })
    expect(JSON.stringify(error)).not.toContain(secret)
  })

  it("redacts unsupported input keys and values", async () => {
    const secretKey = "privateSecretField"
    const secretValue = "private-secret-value"
    const error = await schedules.create({
      cron: "0 9 * * *",
      [secretKey]: secretValue,
      target: "report",
    } as never).then(() => undefined, cause => cause)

    expect(error).toBeInstanceOf(ScheduleError)
    expect(error).toMatchObject({
      code: "SCHEDULE_INVALID_INPUT",
      details: { field: "input", valueType: "object" },
    })
    const json = JSON.stringify(error)
    expect(json).not.toContain(secretKey)
    expect(json).not.toContain(secretValue)
  })

  it("redacts invalid schedule ids before storage access", async () => {
    const secret = { token: "private-id-value" }
    const error = await schedules.run(secret as never).then(() => undefined, cause => cause)

    expect(error).toBeInstanceOf(ScheduleError)
    expect(error).toMatchObject({
      code: "SCHEDULE_INVALID_ID",
      details: { field: "id", valueType: "object" },
    })
    expect(JSON.stringify(error)).not.toContain(secret.token)
  })

  it("redacts invalid ids passed directly to a public store", () => {
    const secret = { token: "private-store-id-value" }
    const store = createMemoryRuntimeScheduleStore()

    let error: unknown
    try {
      store.create({ id: secret } as never)
    }
    catch (cause) {
      error = cause
    }

    expect(error).toBeInstanceOf(ScheduleError)
    expect(error).toMatchObject({
      code: "SCHEDULE_INVALID_ID",
      details: { field: "id", valueType: "object" },
    })
    expect(JSON.stringify(error)).not.toContain(secret.token)
  })
})
