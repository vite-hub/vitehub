import type { UserConfig } from "vite"

import { describe, expectTypeOf, it } from "vitest"

import {
  defineSandbox,
  runSandbox,
  type AgentSandboxConfig,
  type SandboxDefinition,
  type SandboxRunResult,
} from "../src/index.ts"
import { hubSandbox } from "../src/vite.ts"

declare module "#vitehub-sandbox-registry" {
  interface SandboxDefinitionModules {
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
  it("augments Vite user config with sandbox options", () => {
    const config: UserConfig = {
      sandbox: {
        provider: "cloudflare",
        binding: "SANDBOX",
        name: "custom-sandbox",
      },
    }

    expectTypeOf(config.sandbox).toMatchTypeOf<AgentSandboxConfig | false | undefined>()
  })

  it("types sandbox definitions and run results", () => {
    const definition = defineSandbox({
      run: async (payload?: { value: string }) => ({ value: payload?.value || "" }),
    })

    expectTypeOf(definition).toMatchTypeOf<SandboxDefinition<{ value: string } | undefined, { value: string }>>()
    expectTypeOf(runSandbox("release-notes", { value: "ok" })).resolves.toMatchTypeOf<SandboxRunResult>()
    expectTypeOf(runSandbox("package-entry", { value: "ok" })).resolves.toEqualTypeOf<SandboxRunResult<{ length: number }>>()
    expectTypeOf(runSandbox("unknown-package-entry", { anything: true })).resolves.toEqualTypeOf<SandboxRunResult<string>>()
  })

  it("returns a Vite plugin", () => {
    const plugin = hubSandbox()

    expectTypeOf(hubSandbox({ provider: "cloudflare" })).toMatchTypeOf<typeof plugin>()
  })
})
