import { describe, expect, it, vi } from "vitest"

import { collectViteHubCliContribution, getStableStdoutWrite, withStdoutOnStderr } from "../src/cli.ts"

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

  it("sends stdout writes to stderr while project config loads", async () => {
    const write = process.stdout.write
    const stderr: Array<string | Uint8Array> = []
    const callback = vi.fn()
    await expect(withStdoutOnStderr(async () => {
      process.stdout.write("ℹ Using index.html as renderer template.\n", callback)
      process.stdout.write(Buffer.from("vite info\n"))
      throw new Error("config failed")
    }, { write: chunk => stderr.push(chunk) })).rejects.toThrow("config failed")

    expect(stderr.map(String).join("")).toBe("ℹ Using index.html as renderer template.\nvite info\n")
    expect(callback).toHaveBeenCalledOnce()
    expect(process.stdout.write).toBe(write)
  })

  it("serializes concurrent stdout redirects", async () => {
    const write = process.stdout.write
    const firstStarted = Promise.withResolvers<void>()
    const releaseFirst = Promise.withResolvers<void>()
    const firstStderr: string[] = []
    const secondStderr: string[] = []

    const first = withStdoutOnStderr(async () => {
      firstStarted.resolve()
      await releaseFirst.promise
      process.stdout.write("first\n")
    }, { write: chunk => firstStderr.push(String(chunk)) })
    await firstStarted.promise

    let secondStarted = false
    const second = withStdoutOnStderr(async () => {
      secondStarted = true
      process.stdout.write("second\n")
    }, { write: chunk => secondStderr.push(String(chunk)) })
    await Promise.resolve()
    expect(secondStarted).toBe(false)

    releaseFirst.resolve()
    await Promise.all([first, second])
    expect(firstStderr).toEqual(["first\n"])
    expect(secondStderr).toEqual(["second\n"])
    expect(process.stdout.write).toBe(write)
  })

  it("keeps first-use default payload writes out of an active redirect", async () => {
    const original = process.stdout.write
    const payload = vi.fn(() => true)
    const release = Promise.withResolvers<void>()
    try {
      process.stdout.write = payload as typeof process.stdout.write
      const redirect = withStdoutOnStderr(async () => {
        await release.promise
      }, { write: () => undefined })
      await Promise.resolve()
      getStableStdoutWrite()("payload\n")
      expect(payload).toHaveBeenCalledWith("payload\n")
      release.resolve()
      await redirect
    } finally {
      process.stdout.write = original
    }
  })

  it("waits for promise-based stderr writes before completing callbacks", async () => {
    const callback = vi.fn()
    const write = vi.fn((_chunk: string | Uint8Array, done: (error?: Error | null) => void) => {
      const result = Promise.resolve().then(() => done())
      return result
    })

    await withStdoutOnStderr(async () => {
      process.stdout.write("config\n", callback)
      await Promise.resolve()
    }, { write })

    expect(callback).toHaveBeenCalledOnce()
  })

  it("refreshes the default stdout writer when the process writer changes", () => {
    const original = process.stdout.write
    const first = vi.fn(() => true)
    const second = vi.fn(() => true)
    try {
      process.stdout.write = first as typeof process.stdout.write
      const firstWriter = getStableStdoutWrite()
      process.stdout.write = second as typeof process.stdout.write
      const secondWriter = getStableStdoutWrite()

      firstWriter("first\n")
      secondWriter("second\n")
      expect(first).toHaveBeenCalledWith("first\n")
      expect(second).toHaveBeenCalledWith("second\n")
    }
    finally {
      process.stdout.write = original
    }
  })
})
