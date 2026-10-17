import type { UserConfig } from "vite"

import { describe, expectTypeOf, it } from "vitest"

import {
  defineSandboxTask,
  runSandboxTask,
  type AgentSandboxTaskConfig,
  type SandboxTaskDefinition,
  type SandboxTaskRunResult,
} from "../src/index.ts"
import { hubSandboxTask } from "../src/vite.ts"

declare module "#vitehub-sandbox-task-registry" {
  interface SandboxTaskDefinitionModules {
    "package-entry": {
      payload: { value: string }
      result: { length: number }
    }
    "unknown-package-entry": {
      payload: unknown
      result: string
    }
  }
}

describe("types", () => {
  it("augments Vite user config with sandboxTask options", () => {
    const config: UserConfig = {
      sandboxTask: {
        provider: "cloudflare",
        binding: "SANDBOX",
        name: "custom-sandbox",
      },
    }

    expectTypeOf(config.sandboxTask).toMatchTypeOf<AgentSandboxTaskConfig | false | undefined>()
  })

  it("types sandbox definitions and run results", async () => {
    const definition = defineSandboxTask({
      project: false,
      run: async (payload?: { value: string }) => ({ value: payload?.value || "" }),
    })

    expectTypeOf(definition).toMatchTypeOf<SandboxTaskDefinition<{ value: string } | undefined, { value: string }>>()
    expectTypeOf(runSandboxTask("release-notes", { value: "ok" })).resolves.toMatchTypeOf<SandboxTaskRunResult>()
    expectTypeOf(runSandboxTask("package-entry", { value: "ok" })).resolves.toEqualTypeOf<SandboxTaskRunResult>()
    expectTypeOf(runSandboxTask("unknown-package-entry", { anything: true })).resolves.toEqualTypeOf<SandboxTaskRunResult>()

    const result = await runSandboxTask("package-entry", { value: "ok" })
    expectTypeOf(result).toEqualTypeOf<Response>()
  })

  it("returns a Vite plugin", () => {
    const plugin = hubSandboxTask()

    expectTypeOf(hubSandboxTask({ provider: "cloudflare" })).toMatchTypeOf<typeof plugin>()
  })
})
