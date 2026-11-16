import { describe, expect, it } from "vitest"

import { defineConsoleAuthorize } from "../src/console/auth.ts"
import { withConsoleAccess } from "../src/console/runtime/server/access.ts"
import { viteHubErrorDiagnostics } from "../src/error-diagnostics.ts"
import { createLogBuffer } from "../src/logs/memory.ts"
import { createSandboxCliNamespace } from "../src/sandbox-cli.ts"

import type { ViteHubCliContext } from "@vite-hub/internal/cli"

/** The codes that replaced plain errors in the Console, Logs, and `vitehub sandbox` sources. */
const codes = [
  "VITE_HUB_CONSOLE_ACCESS_HANDLER_INVALID",
  "VITE_HUB_CONSOLE_ACCESS_SCOPE_INVALID",
  "VITE_HUB_CONSOLE_AUTHORIZE_FILE_MISSING",
  "VITE_HUB_CONSOLE_AUTHORIZE_NOT_FUNCTION",
  "VITE_HUB_CONSOLE_AUTHORIZE_PATH_INVALID",
  "VITE_HUB_LOGS_MAX_ENTRIES_INVALID",
  "VITE_HUB_LOGS_MAX_ENTRY_BYTES_INVALID",
  "VITE_HUB_LOGS_SOURCE_MISSING",
  "VITE_HUB_SANDBOX_CLI_DRAIN_TIMEOUT_INVALID",
  "VITE_HUB_SANDBOX_CLI_DRIVER_INVALID",
  "VITE_HUB_SANDBOX_CLI_OPTION_MISSING",
  "VITE_HUB_SANDBOX_CLI_PORT_INVALID",
  "VITE_HUB_SANDBOX_CLI_TIMEOUT_INVALID",
] as const

function sandboxCheck(args: string[]): Promise<number | void> {
  const check = createSandboxCliNamespace().features.find(feature => feature.name === "check")!
  const context: ViteHubCliContext = {
    cwd: "/app",
    env: {},
    rootDir: "/app",
    spawn: async () => ({ exitCode: 0 }),
    stderr: { write: () => true },
    stdout: { write: () => true },
  }
  return Promise.resolve(check.run(args, context))
}

describe("vite-hub plain error codes", () => {
  it.each(codes)("%s has a fix and its own docs page", (code) => {
    // Each code takes its own params. One object that has all of them fits every code.
    const create = viteHubErrorDiagnostics[code] as (params: { file: string, option: string, site: "file" }) => Error & { docs?: string, fix?: string }
    const error = create({ file: "server/authorize.ts", option: "--user", site: "file" })
    expect(error.fix).toMatch(/\S/)
    expect(error.docs).toBe(`https://vitehub.dev/docs/development/diagnostics/${code.toLowerCase()}`)
  })

  it("reports a function-less Console authorize with its code and fix", () => {
    expect(() => defineConsoleAuthorize(JSON.parse("true"))).toThrow(expect.objectContaining({
      code: "VITE_HUB_CONSOLE_AUTHORIZE_NOT_FUNCTION",
      fix: expect.stringContaining("defineConsoleAuthorize("),
      message: expect.stringContaining("defineConsoleAuthorize() requires a function."),
    }))
  })

  it("reports a Console route without a scope with its code and fix", () => {
    expect(() => withConsoleAccess(() => "ok", JSON.parse("{}"))).toThrow(expect.objectContaining({
      code: "VITE_HUB_CONSOLE_ACCESS_SCOPE_INVALID",
      fix: expect.stringContaining("anySection: true"),
    }))
  })

  it("reports a log buffer limit out of range with its code and fix", () => {
    expect(() => createLogBuffer({ maxEntries: 0 })).toThrow(expect.objectContaining({
      code: "VITE_HUB_LOGS_MAX_ENTRIES_INVALID",
      fix: expect.stringContaining("maxEntries"),
    }))
  })

  it("reports a bad vitehub sandbox check option with its code and fix", async () => {
    await expect(sandboxCheck(["--timeout", "0"])).rejects.toMatchObject({
      code: "VITE_HUB_SANDBOX_CLI_TIMEOUT_INVALID",
      fix: expect.stringContaining("--timeout"),
    })
  })
})
