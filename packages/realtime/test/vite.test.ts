import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe("hubRealtime", () => {
  it("uses Nitro's Durable Object transport for standalone Cloudflare realtime", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-realtime-vite-"))
    tempDirs.push(root)
    await mkdir(join(root, "server/realtime"), { recursive: true })
    await writeFile(join(root, "server/realtime/document.ts"), "export default {}\n")

    const { hubRealtime } = await import("../src/vite.ts")
    const plugin = hubRealtime()
    const config = { base: "/wiki/", root, nitro: { preset: "cloudflare" } }
    const hook = plugin.config as unknown as (config: Record<string, unknown>) => Promise<void>
    await hook(config)

    expect(config.nitro).toMatchObject({
      preset: "cloudflare-durable",
      cloudflare: {
        wrangler: {
          durable_objects: {
            bindings: [{ class_name: "$DurableObject", name: "$DurableObject" }],
          },
          migrations: [{ new_sqlite_classes: ["$DurableObject"], tag: "vitehub-realtime-v1" }],
        },
      },
    })
    expect(config).toMatchObject({
      define: { __VITEHUB_APP_BASE_URL__: JSON.stringify("/wiki/") },
    })
  })

  it("requires an explicit authority for non-Cloudflare production", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-realtime-vite-"))
    tempDirs.push(root)
    await mkdir(join(root, "server/realtime"), { recursive: true })
    await writeFile(join(root, "server/realtime/document.ts"), "export default {}\n")

    const { hubRealtime } = await import("../src/vite.ts")
    const plugin = hubRealtime()
    const config = { root, nitro: { preset: "vercel" } }
    const hook = plugin.config as unknown as (config: Record<string, unknown>, environment: { command: string }) => Promise<void>

    await expect(hook(config, { command: "build" }))
      .rejects.toThrow("require one room authority")
  })

  it("rejects Cloudflare authority with a non-Cloudflare Nitro preset", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-realtime-vite-"))
    tempDirs.push(root)
    await mkdir(join(root, "server/realtime"), { recursive: true })
    await writeFile(join(root, "server/realtime/document.ts"), "export default {}\n")

    const { hubRealtime } = await import("../src/vite.ts")
    const plugin = hubRealtime({ authority: "cloudflare" })
    const config = { root, nitro: { preset: "node-server" } }
    const hook = plugin.config as unknown as (config: Record<string, unknown>) => Promise<void>

    await expect(hook(config)).rejects.toThrow("conflicts with the node deployment preset")
    expect(config.nitro.preset).toBe("node-server")
  })

  it("allows an acknowledged single-process memory authority", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-realtime-vite-"))
    tempDirs.push(root)
    await mkdir(join(root, "server/realtime"), { recursive: true })
    await writeFile(join(root, "server/realtime/document.ts"), "export default {}\n")

    const { hubRealtime } = await import("../src/vite.ts")
    const plugin = hubRealtime({ authority: "memory" })
    const config = { root } as Record<string, unknown>
    const hook = plugin.config as unknown as (config: Record<string, unknown>, environment: { command: string }) => Promise<void>

    await expect(hook(config, { command: "build" })).resolves.toBeUndefined()
    expect(config.nitro).toMatchObject({ features: { websocket: true } })
  })

  it("rejects memory authority for distributed Deno deployments", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-realtime-vite-"))
    tempDirs.push(root)
    await mkdir(join(root, "server/realtime"), { recursive: true })
    await writeFile(join(root, "server/realtime/document.ts"), "export default {}\n")

    const { hubRealtime } = await import("../src/vite.ts")
    const plugin = hubRealtime({ authority: "memory" })
    const config = { root, nitro: { preset: "deno-deploy" } }
    const hook = plugin.config as unknown as (config: Record<string, unknown>) => Promise<void>

    await expect(hook(config)).rejects.toThrow("cannot use the deno deployment preset")
  })
})
