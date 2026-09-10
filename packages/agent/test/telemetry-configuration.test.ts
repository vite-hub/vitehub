import { expect, it } from "vitest"
import { createAgentInvocationContextStore } from "../src/invocation-context.ts"
import { agentTelemetryConfigurationFingerprint, getAgentTelemetryConfiguration, setAgentTelemetryConfiguration, updateAgentTelemetryConfiguration } from "../src/internal/agent-telemetry.ts"

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
