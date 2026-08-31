import { describe, expectTypeOf, it } from "vitest"

import { claudeCodeDriver, codexDriver, defineAgent, runAgentInline, type AgentProviderEnvironment, type AgentProviderEnvironmentResolver, type AgentProviderLaunchCommand, type AgentProviderLaunchContext, type AgentProviderLaunchResolver, type AgentRuntimeContext, type BuiltInAgentDriver } from "../src/index.ts"

import type { StandardSchemaV1 } from "@standard-schema/spec"

describe("provider Agent Driver types", () => {
  it("exports reusable provider environment and launch resolver contracts", () => {
    const env: AgentProviderEnvironmentResolver = context => {
      expectTypeOf(context.abortSignal).toEqualTypeOf<AbortSignal | undefined>()
      return { PROVIDER_TOKEN: "secret" } satisfies AgentProviderEnvironment
    }
    const launch: AgentProviderLaunchResolver = (context: AgentProviderLaunchContext) => {
      expectTypeOf(context.environment).toEqualTypeOf<Readonly<AgentProviderEnvironment>>()
      return { args: [context.command], command: "wrapper" } satisfies AgentProviderLaunchCommand
    }

    codexDriver({ env, launch })
    claudeCodeDriver({ env, launch })
  })

  it("accepts omitted permissions and explicit full access for both built-in providers", () => {
    const defaultCodex = { kind: "codex" } satisfies BuiltInAgentDriver
    const defaultClaude = { kind: "claude-code" } satisfies BuiltInAgentDriver
    const fullAccessCodex = codexDriver({ permissions: "allow-all" })
    const fullAccessClaude = claudeCodeDriver({ permissions: "allow-all" })
    const configuredCodex = codexDriver({
      credentialProfile: "support",
      credentials: async () => ({ unseal: () => "{}" }),
      env(context) {
        expectTypeOf(context.abortSignal).toEqualTypeOf<AbortSignal | undefined>()
        return { CRABBOX_TOKEN: "secret" }
      },
      launch(context) {
        expectTypeOf(context.command).toEqualTypeOf<string>()
        expectTypeOf(context.cwd).toEqualTypeOf<string>()
        expectTypeOf(context.environment).toEqualTypeOf<Readonly<Record<string, string | undefined>>>()
        return { args: ["codex"], command: "crabbox" }
      },
      model: "gpt-5.6-sol",
      providerSettings: { launchArgs: "--enable responses_websockets_v2" },
      reasoningEffort: "high",
      reasoningSummary: "detailed",
      sessionStorePath: ".vitehub/provider-sessions.sqlite",
    })

    expectTypeOf(defaultCodex.kind).toEqualTypeOf<"codex">()
    expectTypeOf(defaultClaude.kind).toEqualTypeOf<"claude-code">()
    expectTypeOf(fullAccessCodex.permissions).toEqualTypeOf<"ask" | "allow-edits" | "allow-all" | undefined>()
    expectTypeOf(fullAccessClaude.permissions).toEqualTypeOf<"ask" | "allow-edits" | "allow-all" | undefined>()
    expectTypeOf(configuredCodex.reasoningSummary).toEqualTypeOf<"auto" | "concise" | "detailed" | "none" | undefined>()
    expectTypeOf(configuredCodex.sessionStorePath).toEqualTypeOf<string | undefined>()
    claudeCodeDriver({ sessionStorePath: ".vitehub/claude-sessions.sqlite" })

    // @ts-expect-error Provider runtime modes are not public permission options.
    codexDriver({ permissions: "full-access" })
    // @ts-expect-error Provider runtime modes are not public permission options.
    claudeCodeDriver({ permissions: "approval-required" })
    // @ts-expect-error Credentials are Codex-specific.
    claudeCodeDriver({ credentials: "{}" })
    // @ts-expect-error Reasoning summaries use the provider's supported values.
    codexDriver({ reasoningSummary: "verbose" })
    // @ts-expect-error Codex options are not accepted by model drivers.
    defineAgent({ driver: { model: "openai/gpt-5", reasoningEffort: "high" } })
    // @ts-expect-error Provider settings are not accepted by inline run drivers.
    defineAgent({ driver: { providerSettings: {}, run: async () => new Response() } })
    // @ts-expect-error Provider launchers are not accepted by inline run drivers.
    defineAgent({ driver: { launch: { command: "wrapper" }, run: async () => new Response() } })
    // @ts-expect-error Session stores are not accepted by inline run drivers.
    defineAgent({ driver: { run: async () => new Response(), sessionStorePath: ".vitehub/sessions.sqlite" } })
  })

  it("types Codex credential profiles and invocation-time credential resolvers", () => {
    const driver = codexDriver({
      credentialProfile: "support",
      credentials(context) {
        expectTypeOf(context.abortSignal).toEqualTypeOf<AbortSignal | undefined>()
        return { unseal: () => '{"OPENAI_API_KEY":"secret"}' }
      },
      reasoningEffort: "high",
      reasoningSummary: "detailed",
    })

    expectTypeOf(driver.credentialProfile).toEqualTypeOf<string | undefined>()
    // @ts-expect-error Credential projection is currently Codex-specific.
    claudeCodeDriver({ credentials: () => "{}" })
    codexDriver({ reasoningEffort: "ultra" })
  })

  it("preserves structured output inference while invocation input evidences its options", () => {
    // SAFETY: This compile-time fixture intentionally supplies the exact asserted public contract.
    const schema = {} as StandardSchemaV1<unknown, { summary: string }>
    const codex = defineAgent({
      driver: codexDriver({ output: { schema } }),
    })
    const claude = defineAgent({
      driver: claudeCodeDriver({ output: { schema } }),
    })
    const driver = codexDriver({ output: { schema } })

    // @ts-expect-error Built-in drivers do not claim call options without an input-bearing Agent contract.
    void driver.withCallOptions

    // SAFETY: This compile-time fixture intentionally supplies the exact asserted public contract.
    expectTypeOf(runAgentInline(codex, {} as AgentRuntimeContext, { options: { checkout: "/repo" } }))
      .resolves.toEqualTypeOf<Response | { summary: string }>()
    // SAFETY: This compile-time fixture intentionally supplies the exact asserted public contract.
    expectTypeOf(runAgentInline(claude, {} as AgentRuntimeContext, { options: { checkout: "/repo" } }))
      .resolves.toEqualTypeOf<Response | { summary: string }>()
  })
})
