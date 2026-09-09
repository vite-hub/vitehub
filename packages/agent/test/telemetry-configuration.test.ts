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
