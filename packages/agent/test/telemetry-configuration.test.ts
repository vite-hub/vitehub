import type { AgentInspectionValue } from "../src/types.ts"
import { expect, it, vi } from "vitest"
import { createAgentInvocationContextStore } from "../src/invocation-context.ts"
import { agentTelemetryConfigurationFingerprint, getAgentTelemetryConfiguration, setAgentTelemetryConfiguration, setAgentCapabilityInspection, updateAgentTelemetryConfiguration } from "../src/internal/agent-telemetry.ts"

it("preserves raw configuration fingerprints and public redaction across updates", async () => {
  const context = createAgentInvocationContextStore()
  const configuration = {
    driver: { kind: "provider" as const, model: { id: "model", provider: "Bearer provider-secret" } },
    runtime: { name: "node" },
    instructions: ["Authorization: Bearer instruction-secret"],
  }
  await setAgentTelemetryConfiguration(context, configuration)
  const initial = getAgentTelemetryConfiguration(context)!.value
  expect(initial.fingerprint).toBe(await agentTelemetryConfigurationFingerprint(configuration))

  await updateAgentTelemetryConfiguration(context, {})
  expect(getAgentTelemetryConfiguration(context)!.value).toEqual(initial)
  await updateAgentTelemetryConfiguration(context, { driver: { model: { id: "model" } } })
  expect(getAgentTelemetryConfiguration(context)!.value).toEqual(initial)

  await updateAgentTelemetryConfiguration(context, { driver: { model: { id: "next-model" } } })
  const updated = getAgentTelemetryConfiguration(context)!.value
  expect(updated.fingerprint).not.toBe(initial.fingerprint)
  expect(updated.fingerprint).toBe(await agentTelemetryConfigurationFingerprint({
    ...configuration,
    driver: { ...configuration.driver, model: { ...configuration.driver.model, id: "next-model" } },
  }))
  for (const value of [initial, updated]) {
    expect(JSON.stringify(value)).not.toContain("provider-secret")
    expect(JSON.stringify(value)).not.toContain("instruction-secret")
  }
})


it("redacts secret schema descendants without changing ordinary shared defaults", async () => {
  const context = createAgentInvocationContextStore()
  const shared = { default: "opaque-value", examples: ["opaque-example"], nested: { repository: "opaque-repository" } }
  const configuration = {
    driver: { kind: "provider" as const },
    runtime: { name: "node" },
    tools: [{ name: "configure", inputSchema: { properties: {
      ordinary: shared,
      apiKey: shared,
      password: { default: "opaque-password" },
    } } }],
  }
  await setAgentTelemetryConfiguration(context, configuration)
  const initial = getAgentTelemetryConfiguration(context)!.value
  expect(initial.tools?.[0]?.inputSchema).toEqual({ properties: {
    ordinary: shared,
    apiKey: { default: "[redacted]", examples: ["[redacted]"], nested: { repository: "[redacted]" } },
    password: { default: "[redacted]" },
  } })
  expect(JSON.stringify(initial)).not.toContain("opaque-password")
  expect(shared.default).toBe("opaque-value")
  expect(initial.fingerprint).toBe(await agentTelemetryConfigurationFingerprint(configuration))
  await updateAgentTelemetryConfiguration(context, {})
  expect(getAgentTelemetryConfiguration(context)!.value).toEqual(initial)
})


it("redacts repository credentials while preserving ordinary workspace repositories", async () => {
  const context = createAgentInvocationContextStore()
  await setAgentTelemetryConfiguration(context, {
    driver: { kind: "provider" },
    runtime: { name: "node" },
    tools: [{ name: "configure", inputSchema: {
      repo: "Authorization: Bearer repo-secret",
      repository: "Authorization: Bearer repository-secret",
      nested: { repository: "Authorization: Bearer nested-secret" },
    } }],
    workspace: { mode: "read", sources: [
      { id: "docs", repository: "owner/repo" },
      { id: "token-name", repository: "owner/phc_123456789012345678901234567890" },
      { id: "invalid", repository: "Authorization: Bearer source-secret" },
    ] },
  })
  const value = getAgentTelemetryConfiguration(context)!.value
  expect(value.tools?.[0]?.inputSchema).toEqual({
    repo: "Authorization: Bearer [REDACTED]",
    repository: "Authorization: Bearer [REDACTED]",
    nested: { repository: "Authorization: Bearer [REDACTED]" },
  })
  expect(value.workspace?.sources).toEqual([
    { id: "docs", repository: "owner/repo" },
    { id: "token-name", repository: "owner/[REDACTED]" },
    { id: "invalid", repository: "Authorization: Bearer [REDACTED]" },
  ])
  await updateAgentTelemetryConfiguration(context, {})
  expect(getAgentTelemetryConfiguration(context)!.value).toEqual(value)
})


it("retains the latest setup inspection through configuration initialization", async () => {
  const context = createAgentInvocationContextStore()
  await setAgentCapabilityInspection(context, "custom", { label: "Custom", state: { status: "Preparing" } })
  await setAgentCapabilityInspection(context, "custom", { label: "Custom", state: { status: "Ready", password: "private-value" } })
  const configuration = { capabilities: [{ id: "custom" }], driver: { kind: "run" as const }, runtime: { name: "unknown" } }
  await setAgentTelemetryConfiguration(context, configuration)
  const initial = getAgentTelemetryConfiguration(context)!.value
  expect(initial.capabilities?.[0]?.inspection).toEqual({ label: "Custom", state: { status: "Ready", password: "[redacted]" } })
  await setAgentTelemetryConfiguration(context, configuration)
  expect(getAgentTelemetryConfiguration(context)!.value).toEqual(initial)
  await Promise.all([
    setAgentCapabilityInspection(context, "custom", { label: "Custom", state: { status: "Finished" } }),
    updateAgentTelemetryConfiguration(context, { tools: [{ name: "lookup" }] }),
  ])
  const final = getAgentTelemetryConfiguration(context)!.value
  expect(final.capabilities?.[0]?.inspection?.state).toEqual({ status: "Finished" })
  expect(final.tools).toEqual([{ name: "lookup" }])
})

it("retains deep inspection state and marks each unsupported omission", async () => {
  const context = createAgentInvocationContextStore()
  await setAgentTelemetryConfiguration(context, { capabilities: [{ id: "custom" }], driver: { kind: "run" }, runtime: { name: "unknown" } })
  let nested: Record<string, AgentInspectionValue> = { leaf: "retained" }
  for (let index = 0; index < 16; index++) nested = { child: nested }
  await setAgentCapabilityInspection(context, "custom", { label: "Custom", state: { nested } })
  expect(getAgentTelemetryConfiguration(context)!.value.capabilities?.[0]?.inspection).toEqual({ label: "Custom", state: { nested } })
  const cycle: Record<string, AgentInspectionValue> = {}
  cycle.self = cycle
  for (const omitted of [cycle, new Date(), Infinity, () => undefined]) {
    // @ts-expect-error Exercise unsupported runtime values at the inspection boundary.
    await setAgentCapabilityInspection(context, "custom", { label: "Custom", state: { omitted } })
    expect(getAgentTelemetryConfiguration(context)!.value.capabilities?.[0]?.inspection?.truncated).toBe(true)
  }
  for (let index = 0; index < 64; index++) nested = { child: nested }
  await setAgentCapabilityInspection(context, "custom", { label: "Custom", state: { nested } })
  expect(getAgentTelemetryConfiguration(context)!.value.capabilities?.[0]?.inspection?.truncated).toBe(true)
})

it("uses a private discriminator for credentials while retaining secret changes", async () => {
  const configuration = {
    driver: { kind: "run" as const },
    runtime: { name: "node" },
    instructions: ["password=1234"],
  }
  const first = await agentTelemetryConfigurationFingerprint(configuration)
  expect(first).toMatch(/^hmac_sha256_[a-f0-9]{64}$/)
  expect(await agentTelemetryConfigurationFingerprint(configuration)).toBe(first)
  expect(await agentTelemetryConfigurationFingerprint({ ...configuration, instructions: ["password=1235"] })).not.toBe(first)
  expect(await agentTelemetryConfigurationFingerprint({ ...configuration, instructions: ["Public instructions"] })).toMatch(/^sha256_[a-f0-9]{64}$/)
})

it("excludes only capability inspection snapshots from execution fingerprints", async () => {
  const configuration = {
    driver: { kind: "run" as const },
    runtime: { name: "node" },
    capabilities: [{ id: "custom", inspection: { label: "Preparing" } }],
    tools: [{ name: "lookup", inputSchema: { properties: { inspection: { const: "first" } } } }],
  }
  const first = await agentTelemetryConfigurationFingerprint(configuration)
  expect(await agentTelemetryConfigurationFingerprint({ ...configuration, capabilities: [{ id: "custom", inspection: { label: "Ready" } }] })).toBe(first)
  expect(await agentTelemetryConfigurationFingerprint({ ...configuration, tools: [{ name: "lookup", inputSchema: { properties: { inspection: { const: "second" } } } }] })).not.toBe(first)
})

it("does not expose a repeatable credential digest across runtime instances", async () => {
  const configuration = { driver: { kind: "run" as const }, runtime: { name: "node" }, instructions: ["password=1234"] }
  const first = await agentTelemetryConfigurationFingerprint(configuration)
  vi.resetModules()
  const fresh = await import("../src/internal/agent-telemetry.ts")
  expect(await fresh.agentTelemetryConfigurationFingerprint(configuration)).not.toBe(first)
  const publicConfiguration = { ...configuration, instructions: ["Public instructions"] }
  expect(await fresh.agentTelemetryConfigurationFingerprint(publicConfiguration)).toBe(await agentTelemetryConfigurationFingerprint(publicConfiguration))
})
