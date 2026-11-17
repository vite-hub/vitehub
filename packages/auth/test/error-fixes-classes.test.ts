import { expect, it } from "vitest"

import { authErrorDiagnostics } from "../src/error-diagnostics.ts"
import { createDatabaseAuthEventStore, parseAuthEventWindow } from "../src/events.ts"
import { verifyPasswordWithNoble } from "../src/password.ts"

const codes = {
  AUTH_EVENT_CALLBACK_FAILED: authErrorDiagnostics.AUTH_EVENT_CALLBACK_FAILED({ type: "user.signed_in" }),
  AUTH_EVENT_QUERY_INVALID: authErrorDiagnostics.AUTH_EVENT_QUERY_INVALID({ problem: "order" }),
  AUTH_EVENT_RETENTION_INVALID: authErrorDiagnostics.AUTH_EVENT_RETENTION_INVALID(),
  AUTH_PASSWORD_HASH_INVALID: authErrorDiagnostics.AUTH_PASSWORD_HASH_INVALID(),
}

it("gives each code that replaced a plain error a fix and its own docs page", () => {
  for (const [code, error] of Object.entries(codes)) {
    expect(error.code, code).toBe(code)
    expect(error.message, code).toMatch(/\S/)
    expect(error.fix, code).toMatch(/\S/)
    expect(error.docs, code).toBe(`https://vitehub.dev/docs/auth/diagnostics/${code.toLowerCase()}`)
  }
})

it("throws the event and password codes from the public functions", async () => {
  expect(() => parseAuthEventWindow({ from: "2026-02-01T00:00:00.000Z", to: "2026-01-01T00:00:00.000Z" })).toThrow(expect.objectContaining({ code: "AUTH_EVENT_QUERY_INVALID", fix: expect.stringContaining("`from` before `to`") }))
  expect(() => createDatabaseAuthEventStore({ db: {} as never, retention: { maxRecords: 0 } })).toThrow(expect.objectContaining({ code: "AUTH_EVENT_RETENTION_INVALID", fix: expect.stringContaining("retention: false") }))
  await expect(verifyPasswordWithNoble({ hash: "no-separator", password: "secret" })).rejects.toMatchObject({ code: "AUTH_PASSWORD_HASH_INVALID", message: "Invalid password hash" })
})
