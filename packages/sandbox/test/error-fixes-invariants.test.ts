import { expect, it } from "vitest"

import { sandboxErrorDiagnostics } from "../src/error-diagnostics.ts"
import { parseDuration } from "../src/internal/cloudflare-durable-object.ts"

const codes = [
  "SANDBOX_CLOUDFLARE_COMMAND_TIMED_OUT",
  "SANDBOX_CLOUDFLARE_CONTAINER_MISSING",
  "SANDBOX_CLOUDFLARE_PROCESS_NOT_FOUND",
  "SANDBOX_CLOUDFLARE_SLEEP_AFTER_INVALID",
  "SANDBOX_TRUSTED_HOST_KILL_TIMED_OUT",
] as const

it.each(codes)("gives %s a fix and its own docs page", (code) => {
  const create = sandboxErrorDiagnostics[code] as (params: { processId: string, timeout: number, value: string }) => Error & { docs?: string, fix?: string }
  const error = create({ processId: "p1", timeout: 50, value: "\"soon\"" })
  expect(error.fix).toMatch(/\S/)
  expect(error.docs).toBe(`https://vitehub.dev/docs/sandbox/diagnostics/${code.toLowerCase()}`)
})

it("reports an invalid Cloudflare sleepAfter with its code and fix", () => {
  expect(() => parseDuration("soon")).toThrow(expect.objectContaining({
    code: "SANDBOX_CLOUDFLARE_SLEEP_AFTER_INVALID",
    fix: expect.stringContaining("`sleepAfter`"),
    message: "[vitehub] Invalid Cloudflare sleepAfter \"soon\". Use seconds or a value such as \"30s\", \"5m\" or \"1h\".",
  }))
})
