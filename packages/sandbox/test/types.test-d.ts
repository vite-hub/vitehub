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

describe("types", () => {
  it("augments Vite user config with sandbox options", () => {
    const config: UserConfig = {
      sandbox: {
        provider: "cloudflare",
        binding: "SANDBOX",
      },
    }

    expectTypeOf(config.sandbox).toMatchTypeOf<AgentSandboxConfig | false | undefined>()
  })

  it("types sandbox definitions and run results", () => {
    const definition = defineSandbox(async (payload?: { value: string }) => ({ value: payload?.value || "" }))

    expectTypeOf(definition).toMatchTypeOf<SandboxDefinition<{ value: string } | undefined, { value: string }>>()
    expectTypeOf(runSandbox("release-notes", { value: "ok" })).resolves.toMatchTypeOf<SandboxRunResult>()
  })

  it("returns a Vite plugin with an attached Nitro module", () => {
    const plugin = hubSandbox()

    expectTypeOf(plugin).toMatchTypeOf<{ nitro?: { name?: string } }>()
  })
})
