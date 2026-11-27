import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { VITEHUB_NITRO_CONFIG_CONTEXT } from "@vite-hub/internal/build/vite"
import { describe, expect, it } from "vitest"

import type { Plugin } from "vite"

import { vitehub } from "../src/index.ts"

/** The management handler that the Connections plugin writes for one `vitehub()` config in `vite dev`. */
async function developmentHandler(options: Parameters<typeof vitehub>[0]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "vitehub-connections-api-"))
  try {
    // SAFETY: vitehub() returns a flat list of concrete plugins in these integration tests.
    const plugins = vitehub(options) as Plugin[]
    const connections = plugins.find(plugin => plugin.name === "@vite-hub/connections/vite")
    const hook = connections?.config
    if (!hook) throw new TypeError("Expected the Connections config hook.")
    const config: { nitro: { handlers?: Array<{ handler: string }> }, root: string, [VITEHUB_NITRO_CONFIG_CONTEXT]: true } = { nitro: {}, root, [VITEHUB_NITRO_CONFIG_CONTEXT]: true }
    await Reflect.apply("handler" in hook ? hook.handler : hook, {}, [config, { command: "serve", mode: "development" }])
    return await readFile(config.nitro.handlers![0]!.handler, "utf8")
  }
  finally {
    await rm(root, { force: true, recursive: true })
  }
}

describe("the Connections management API", () => {
  it.each([{ auth: false } as const, false as const])("is the app's own API and never uses Console access (console: %s)", async (console) => {
    const handler = await developmentHandler({ connections: true, console, database: true, host: "node" })
    expect(handler).toContain('actor: "development"')
    expect(handler).not.toContain("console")
  })

  it("uses the actor module that the app sets", async () => {
    const handler = await developmentHandler({ connections: { management: { actor: "./server/connections-actor.ts" } }, console: true, database: true, host: "node" })
    expect(handler).toContain("connections-actor.ts")
    expect(handler).not.toContain("#vitehub/console")
  })
})
