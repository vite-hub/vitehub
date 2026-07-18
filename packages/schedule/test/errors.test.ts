import { ViteHubError } from "@vite-hub/runtime"
import { describe, expect, it } from "vitest"

import { createMemoryRuntimeScheduleStore, ScheduleError, schedules, validateRuntimeScheduleCron } from "../src/index.ts"

describe("ScheduleError", () => {
  it("preserves its public identity and serializes only stable ViteHub fields", () => {
    const error = new ScheduleError("Runtime Schedule not found: daily", {
      cause: new Error("private-provider-cause"),
      code: "SCHEDULE_NOT_FOUND",
      details: { id: "daily" },
      httpStatus: 404,
      requestId: "request-1",
      retryable: false,
    })

    expect(error).toBeInstanceOf(Error)
    expect(error).toBeInstanceOf(ViteHubError)
    expect(error).toBeInstanceOf(ScheduleError)
    expect(error.name).toBe("ScheduleError")
    expect(error.httpStatus).toBe(404)
    expect(error.toJSON()).toEqual({
      code: "SCHEDULE_NOT_FOUND",
      details: { id: "daily" },
      message: "Runtime Schedule not found: daily",
      requestId: "request-1",
      retryable: false,
    })

    const json = JSON.stringify(error)
    expect(json).not.toContain("private-provider-cause")
    expect(json).not.toContain("cause")
    expect(json).not.toContain("httpStatus")
    expect(json).not.toContain("stack")
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
