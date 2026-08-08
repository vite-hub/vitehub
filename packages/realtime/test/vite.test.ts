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
    const config = { root, nitro: { preset: "cloudflare" } }
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
  })
})
