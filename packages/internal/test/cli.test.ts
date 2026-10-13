import { describe, expect, it, vi } from "vitest"

import { collectViteHubCliContribution } from "../src/cli.ts"

import type { ProvisionStep } from "../src/provision.ts"

function step(id: string, provider: ProvisionStep["provider"]): ProvisionStep {
  return { id, provider, plan: async () => [] }
}

describe("CLI primitives", () => {
  it("collects package-contributed command namespaces", async () => {
    const { namespaces } = await collectViteHubCliContribution([
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

  it("ignores inherited plugin metadata", async () => {
    const inherited = Object.create({
      vitehub: {
        cli: {
          namespaces: [{ features: [{ name: "unexpected", run: () => undefined }], name: "inherited" }],
        },
      },
    }) as object

    const { namespaces, provision } = await collectViteHubCliContribution([inherited])

    expect(namespaces).toEqual([])
    expect(provision).toEqual([])
  })

  it("merges features for the same namespace", async () => {
    const { namespaces } = await collectViteHubCliContribution([
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

  it("collects one contribution per plugin while preserving order and last-wins overrides", async () => {
    const original = { name: "run", run: vi.fn() }
    const replacement = { name: "run", run: vi.fn() }
    const namespace = { description: "Original description", features: [original], name: "example" }
    const firstStep = step("first", "cloudflare")
    const replacedStep = step("first", "vercel")
    const first = vi.fn(async () => ({ namespaces: [namespace], provision: [firstStep] }))
    const second = vi.fn(async () => ({
      namespaces: [{ description: "Later description", features: [replacement, { name: "status", run: vi.fn() }], name: "example" }],
      provision: [step("second", "cloudflare"), replacedStep],
    }))

    const contribution = await collectViteHubCliContribution([
      null, undefined, false, "unrelated", {},
      { vitehub: { cli: async () => undefined } },
      { vitehub: { cli: first } },
      { vitehub: { cli: second } },
    ])

    expect(first).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledTimes(1)
    expect(contribution.namespaces).toHaveLength(1)
    expect(contribution.namespaces[0]?.description).toBe("Original description")
    expect(contribution.namespaces[0]?.features.map(feature => feature.name)).toEqual(["run", "status"])
    expect(contribution.namespaces[0]?.features[0]).toBe(replacement)
    expect(contribution.provision.map(item => item.id)).toEqual(["first", "second"])
    expect(contribution.provision[0]).toBe(replacedStep)
    expect(namespace.features).toEqual([original])
  })

  it("collects package-contributed provision steps and dedupes by id", async () => {
    const { provision: steps } = await collectViteHubCliContribution([
      { vitehub: { cli: { namespaces: [], provision: [step("queue:cloudflare-queues", "cloudflare")] } } },
      { vitehub: { cli: () => ({ namespaces: [], provision: [step("blob:vercel-blob", "vercel"), step("queue:cloudflare-queues", "cloudflare")] }) } },
    ])

    expect(steps.map(item => item.id)).toEqual(["queue:cloudflare-queues", "blob:vercel-blob"])
  })
})
