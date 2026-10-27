import { describe, expect, it } from "vitest"
import { resolveConfig } from "vite"

import { nitroWorkerdDependencies } from "../src/build/nitro-workerd-dependencies.ts"

import type { EnvironmentOptions, InlineConfig } from "vite"

/** The `nitro` environment as Nitro adds it: workerd runs every dependency as source, Node only Nitro's own. */
function nitroEnvironment(runner: "workerd" | "node", nitro: EnvironmentOptions = {}): InlineConfig {
  const noExternal = runner === "workerd" ? true : [/^nitro(\/|$)/]
  return {
    configFile: false,
    logLevel: "silent",
    plugins: [
      { name: "nitro-stand-in", config: () => ({ environments: { nitro: { consumer: "server", resolve: { noExternal } } } }) },
      nitroWorkerdDependencies(),
    ],
    environments: { nitro },
  }
}

describe("nitroWorkerdDependencies", () => {
  it("pre-bundles the dependencies of Nitro's workerd dev server, without Nitro itself", async () => {
    const { optimizeDeps } = (await resolveConfig(nitroEnvironment("workerd"), "serve")).environments.nitro!

    expect(optimizeDeps.noDiscovery).toBe(false)
    expect(optimizeDeps.exclude).toContain("nitro")
  })

  it("leaves the Node runner, the build, and the client alone", async () => {
    const node = await resolveConfig(nitroEnvironment("node"), "serve")
    const build = await resolveConfig(nitroEnvironment("workerd"), "build")

    expect(node.environments.nitro!.optimizeDeps.noDiscovery).toBe(true)
    expect(build.environments.nitro!.optimizeDeps.noDiscovery).toBe(true)
    expect(node.environments.client!.optimizeDeps.exclude ?? []).not.toContain("nitro")
  })

  it("keeps the app's own discovery setting", async () => {
    const config = await resolveConfig(nitroEnvironment("workerd", { optimizeDeps: { noDiscovery: true, include: ["some-dependency"] } }), "serve")

    expect(config.environments.nitro!.optimizeDeps.noDiscovery).toBe(true)
    expect(config.environments.nitro!.optimizeDeps.exclude ?? []).not.toContain("nitro")
  })
})
