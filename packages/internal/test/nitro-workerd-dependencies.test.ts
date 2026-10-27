import { describe, expect, it } from "vitest"
import { resolveConfig } from "vite"

import { nitroWorkerdDependencies } from "../src/build/nitro-workerd-dependencies.ts"

import type { EnvironmentOptions, InlineConfig } from "vite"

/** The `nitro` environment as Nitro adds it: workerd runs every dependency as source, Node only Nitro's own. */
function nitroEnvironment(runner: "workerd" | "node", nitro: EnvironmentOptions = {}): InlineConfig {
  const noExternal = runner === "workerd" ? true : [/^nitro(\/|$)/]
  const conditions = runner === "workerd" ? ["workerd", "worker"] : ["node"]
  return {
    configFile: false,
    logLevel: "silent",
    plugins: [
      { name: "nitro-stand-in", config: () => ({ environments: { nitro: { consumer: "server", resolve: { noExternal, conditions } } } }) },
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

  it.each([true, false])("keeps explicit noDiscovery: %s and existing exclusions while excluding Nitro", async (noDiscovery) => {
    const config = await resolveConfig(nitroEnvironment("workerd", {
      optimizeDeps: { noDiscovery, include: ["some-dependency"], exclude: ["app-excluded-dependency"] },
    }), "serve")

    expect(config.environments.nitro!.optimizeDeps.noDiscovery).toBe(noDiscovery)
    expect(config.environments.nitro!.optimizeDeps.include).toEqual(["some-dependency"])
    expect(config.environments.nitro!.optimizeDeps.exclude).toEqual(["app-excluded-dependency", "nitro"])
  })

  it.each([{ conditions: undefined }, { conditions: ["node"] }])("leaves unrelated inlined server environments with $conditions conditions alone", async ({ conditions }) => {
    const config = await resolveConfig({
      configFile: false,
      logLevel: "silent",
      plugins: [nitroWorkerdDependencies()],
      environments: { custom: { consumer: "server", resolve: { noExternal: true, conditions } } },
    }, "serve")

    expect(config.environments.custom!.optimizeDeps.noDiscovery).toBe(true)
    expect(config.environments.custom!.optimizeDeps.exclude ?? []).not.toContain("nitro")
  })

  it.each(["workerd", "worker"])("pre-bundles a named service given %s conditions by Nitro's environment hook", async (condition) => {
    const config = await resolveConfig({
      configFile: false,
      logLevel: "silent",
      plugins: [
        {
          name: "nitro-service-stand-in",
          configEnvironment(name) {
            if (name === "api") return { consumer: "server", resolve: { noExternal: true, conditions: [condition] } }
          },
        },
        nitroWorkerdDependencies(),
      ],
      environments: { api: {} },
    }, "serve")

    expect(config.environments.api!.optimizeDeps.noDiscovery).toBe(false)
    expect(config.environments.api!.optimizeDeps.exclude).toContain("nitro")
  })

  it("leaves client environments alone even with worker conditions and inlined dependencies", async () => {
    const config = await resolveConfig({
      configFile: false,
      logLevel: "silent",
      plugins: [nitroWorkerdDependencies()],
      environments: { client: { resolve: { noExternal: true, conditions: ["worker"] } } },
    }, "serve")

    expect(config.environments.client!.optimizeDeps.exclude ?? []).not.toContain("nitro")
  })
})
