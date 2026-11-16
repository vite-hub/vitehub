import { expect, it } from "vitest"

import { sandboxErrorDiagnostics } from "../src/error-diagnostics.ts"
import { sshLaunch } from "../src/ssh.ts"

/** The codes that replaced plain errors in the SSH runner, the Cloudflare log stream, and the trusted host. */
const codes = [
  "SANDBOX_CLOUDFLARE_LOG_STREAM_FAILED",
  "SANDBOX_SSH_DRAIN_TIMEOUT_INVALID",
  "SANDBOX_SSH_LAUNCH_INVALID",
  "SANDBOX_SSH_POSIX_REQUIRED",
  "SANDBOX_TRUSTED_HOST_CLOSING",
] as const

it.each(codes)("gives %s a fix and its own docs page", (code) => {
  // Each code takes its own params. One object that has all of them fits every code.
  const create = sandboxErrorDiagnostics[code] as (params: { detail: string, problem: "host" }) => Error & { docs?: string, fix?: string }
  const error = create({ detail: "exit", problem: "host" })
  expect(error.fix).toMatch(/\S/)
  expect(error.docs).toBe(`https://vitehub.dev/docs/sandbox/diagnostics/${code.toLowerCase()}`)
})

it("reports an invalid sshLaunch() host with its code and fix", () => {
  expect(() => sshLaunch({ host: "-oProxyCommand=x", identityFile: "/keys/runner", user: "agent" })).toThrow(expect.objectContaining({
    code: "SANDBOX_SSH_LAUNCH_INVALID",
    fix: expect.stringContaining("sshLaunch()"),
    message: "[vitehub] SSH host is invalid.",
  }))
})

it("reports a lowercase forwarded environment name with its code and fix", () => {
  expect(() => sshLaunch({ forwardEnvironment: ["api_token"], host: "runner.internal", identityFile: "/keys/runner", user: "agent" })).toThrow(expect.objectContaining({
    code: "SANDBOX_SSH_LAUNCH_INVALID",
    fix: expect.stringContaining("forwardEnvironment"),
    message: "[vitehub] SSH environment names must be uppercase shell identifiers.",
  }))
})
