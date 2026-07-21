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
import type { SandboxPayload, SandboxResult } from "../src/runtime/registry-types.ts"

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
  })

  it("infers direct package-project handlers", () => {
    type Handler = (
      payload: { value: string },
      context?: Record<string, unknown>,
    ) => Promise<{ context: boolean, value: string }>

    expectTypeOf<SandboxPayload<Handler>>().toEqualTypeOf<{ value: string }>()
    expectTypeOf<SandboxResult<Handler>>().toEqualTypeOf<{ context: boolean, value: string }>()
  })

  it("returns a Vite plugin", () => {
    const plugin = hubSandbox()

    expectTypeOf(hubSandbox({ provider: "cloudflare" })).toMatchTypeOf<typeof plugin>()
  })
})
