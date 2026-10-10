import { describe, expect, it } from "vitest"

import { describeDeploymentPlanOutput } from "../src/build/deployment-plan-output.ts"
import { resolveDeploymentPlan } from "../src/deployment.ts"
import {
  collectViteHubDefinitionInspectors,
  collectViteHubProviderOutputEntries,
  redactInspectionText,
  redactInspectionValue,
  summarizeDefinitions,
} from "../src/inspect.ts"

describe("inspection contributors", () => {
  it("collects object and factory contributors and skips plugins without inspection", async () => {
    const plugins = [
      null,
      { name: "plain" },
      { vitehub: { cli: { namespaces: [] } } },
      { vitehub: { inspect: { definitions: [{ kind: "queue", label: "Queues", list: () => [] }] } } },
      { vitehub: { inspect: async () => ({ definitions: [{ kind: "schedule", label: "Schedules", list: () => [] }] }) } },
      { vitehub: { inspect: () => undefined } },
    ]

    const inspectors = await collectViteHubDefinitionInspectors(plugins)
    expect(inspectors.map(inspector => inspector.kind)).toEqual(["queue", "schedule"])
  })

  it("keeps one inspector per kind and one Provider Output entry per path", async () => {
    const plugins = [
      { vitehub: { inspect: { definitions: [{ kind: "queue", label: "First", list: () => [] }], providerOutput: [{ description: "first", owner: "a", path: "/app/out.json" }] } } },
      { vitehub: { inspect: { definitions: [{ kind: "queue", label: "Second", list: () => [] }], providerOutput: [{ description: "second", owner: "b", path: "/app/out.json" }] } } },
    ]

    expect((await collectViteHubDefinitionInspectors(plugins)).map(inspector => inspector.label)).toEqual(["Second"])
    expect(await collectViteHubProviderOutputEntries(plugins)).toEqual([{ description: "second", owner: "b", path: "/app/out.json" }])
  })

  it("summarizes Definitions relative to the project root", () => {
    expect(summarizeDefinitions("/app", [
      { handler: "/app/server/agents/support.ts", name: "support" },
      { handler: "/app/server/agents/billing.ts", name: "billing", source: "server-agent" },
    ], "agent")).toEqual([
      { fields: [], file: "server/agents/support.ts", name: "support", source: "agent" },
      { fields: [], file: "server/agents/billing.ts", name: "billing", source: "server-agent" },
    ])
  })
})

describe("redactInspectionValue", () => {
  it("redacts secret-like keys, Worker vars, and credential URLs", () => {
    expect(redactInspectionValue({
      d1_databases: [{ binding: "DB", database_id: "db-id" }],
      nested: { apiKey: "k", "Api key": "k", authorization: "Bearer x", password: "p", token: "t" },
      urls: ["https://user:pass@example.com/db", "https://example.com/public"],
      header: "Bearer abc",
      vars: { PUBLIC_FLAG: "on", STRIPE_KEY: "sk_live" },
    })).toEqual({
      d1_databases: [{ binding: "DB", database_id: "db-id" }],
      nested: { apiKey: "[redacted]", "Api key": "[redacted]", authorization: "[redacted]", password: "[redacted]", token: "[redacted]" },
      urls: ["[redacted]", "https://example.com/public"],
      header: "[redacted]",
      vars: { PUBLIC_FLAG: "[redacted]", STRIPE_KEY: "[redacted]" },
    })
  })

  it("keeps non-secret primitives unchanged", () => {
    expect(redactInspectionValue(3)).toBe(3)
    expect(redactInspectionValue(null)).toBe(null)
    expect(redactInspectionValue("queue")).toBe("queue")
  })
})

describe("redactInspectionText", () => {
  it("redacts credentials inside free text", () => {
    expect(redactInspectionText("GET https://user:hunter2@example.test/db failed, Authorization: Bearer abc.def; api_key=sk_live token: t1 done"))
      .toBe("GET https://[redacted]@example.test/db failed, Authorization: [redacted]; api_key=[redacted] token: [redacted] done")
    expect(redactInspectionText("Target report failed after 3 attempts.")).toBe("Target report failed after 3 attempts.")
  })
})

describe("describeDeploymentPlanOutput", () => {
  it("uses the configured Nitro output directory", () => {
    expect(describeDeploymentPlanOutput(resolveDeploymentPlan("cloudflare"), "/app", "custom").map(entry => entry.path)).toEqual([
      "/app/custom/deployment.json", "/app/custom/server/wrangler.json",
    ])
    expect(describeDeploymentPlanOutput(resolveDeploymentPlan("netlify"), "/app", "/app/custom/functions-internal").map(entry => entry.path)).toEqual([
      "/app/custom/deployment.json", "/app/custom/functions-internal", "/app/custom/functions/server.mjs", "/app/custom/v1",
    ])
  })
  it.each([
    ["cloudflare", ["/app/.output/deployment.json", "/app/.output/server/wrangler.json"]],
    ["vercel", ["/app/.vercel/output/deployment.json", "/app/.vercel/output/config.json"]],
    ["netlify", ["/app/.netlify/deployment.json", "/app/.netlify/functions-internal", "/app/.netlify/functions/server.mjs", "/app/.netlify/v1"]],
    ["node", ["/app/.output/deployment.json"]],
  ] as const)("lists the %s preset output", (preset, paths) => {
    const entries = describeDeploymentPlanOutput(resolveDeploymentPlan(preset), "/app")
    expect(entries.map(entry => entry.path)).toEqual(paths)
    expect(entries.every(entry => entry.owner === "vite-hub")).toBe(true)
  })
})
