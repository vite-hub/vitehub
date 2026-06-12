import { describe, expect, it } from "vitest"

import { collectViteHubCliNamespaces, collectViteHubProvisionSteps } from "../src/cli.ts"

import type { ProvisionStep } from "../src/provision.ts"

function step(id: string, provider: ProvisionStep["provider"]): ProvisionStep {
  return { id, provider, plan: async () => [] }
}

describe("CLI primitives", () => {
  it("collects package-contributed command namespaces", async () => {
    const namespaces = await collectViteHubCliNamespaces([
      {
        name: "@vite-hub/agent/vite",
        vitehub: {
          cli: {
            namespaces: [{
              features: [{ name: "eval", run: () => undefined }],
              name: "agent",
            }],
          },
        },
      },
    ])

    expect(namespaces).toEqual([
      expect.objectContaining({
        features: [expect.objectContaining({ name: "eval" })],
        name: "agent",
      }),
    ])
  })

  it("merges features for the same namespace", async () => {
    const namespaces = await collectViteHubCliNamespaces([
      {
        vitehub: {
          cli: {
            namespaces: [{ features: [{ name: "eval", run: () => undefined }], name: "agent" }],
          },
        },
      },
      {
        vitehub: {
          cli: () => ({
            namespaces: [{ features: [{ name: "doctor", run: () => undefined }], name: "agent" }],
          }),
        },
      },
    ])

    expect(namespaces).toHaveLength(1)
    expect(namespaces[0]?.features.map(feature => feature.name)).toEqual(["eval", "doctor"])
  })

  it("collects package-contributed provision steps and dedupes by id", async () => {
    const steps = await collectViteHubProvisionSteps([
      { vitehub: { cli: { namespaces: [], provision: [step("queue:cloudflare-queues", "cloudflare")] } } },
      { vitehub: { cli: () => ({ namespaces: [], provision: [step("blob:vercel-blob", "vercel"), step("queue:cloudflare-queues", "cloudflare")] }) } },
    ])

    expect(steps.map(item => item.id)).toEqual(["queue:cloudflare-queues", "blob:vercel-blob"])
  })
})
