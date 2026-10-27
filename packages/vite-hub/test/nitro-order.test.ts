import { resolveConfig } from "vite"
import { describe, expect, it, vi } from "vitest"

import type { ConfigEnv, Plugin, UserConfig } from "vite"

import { nitroOrderPlugins } from "../src/nitro-order.ts"

describe("Nitro plugin selection", () => {
  it.each(["before", "after"] as const)("uses Vite's selection when Nitro comes %s ViteHub", async (position) => {
    let applicationCalls = 0
    const apply = vi.fn((config: UserConfig) => ++applicationCalls === 1 && config.mode === "production")
    const application: Plugin = { name: "application", apply, config: vi.fn(() => undefined) }
    let selectedCalls = 0
    const selectedApply = vi.fn((_config: UserConfig, env: ConfigEnv) => ++selectedCalls === 1 && env.command === "build")
    const selectedConfig = vi.fn((config: UserConfig) => {
      expect(config.define?.hubConfigured).toBe(true)
      return { define: { nitroConfigured: true } }
    })
    const selected: Plugin = { name: "nitro:init", apply: selectedApply, config: selectedConfig }
    const excludedApply = vi.fn((_config: UserConfig, env: ConfigEnv) => env.command === "serve")
    const excluded: Plugin = { name: "nitro:env", apply: excludedApply, config: vi.fn(() => undefined) }
    const hub: Plugin[] = [
      { name: "hub-config", config: () => ({ define: { hubConfigured: true } }) },
      ...nitroOrderPlugins(),
    ]
    const plugins = position === "before" ? [[selected, excluded], hub] : [hub, [selected, excluded]]
    const config = await resolveConfig({ configFile: false, plugins: [application, ...plugins] }, "build", "production")

    expect(apply).toHaveBeenCalledTimes(1)
    expect(selectedApply).toHaveBeenCalledTimes(1)
    expect(excludedApply).toHaveBeenCalledTimes(1)
    expect(config.plugins).toContain(application)
    expect(config.plugins).toContain(selected)
    expect(config.plugins).not.toContain(excluded)
    expect(application.config).toHaveBeenCalledTimes(1)
    expect(selectedConfig).toHaveBeenCalledTimes(1)
    expect(excluded.config).not.toHaveBeenCalled()
    expect(config.define?.nitroConfigured).toBe(true)
    expect(selected.config).toBe(selectedConfig)
  })

  it("replays a selected post hook after Vite invokes its placeholder", async () => {
    const handler = vi.fn(() => ({ define: { nitroConfigured: true } }))
    const hook = { order: "post", handler } as const
    const plugin: Plugin = { name: "nitro:init", config: hook }
    const config = await resolveConfig({ configFile: false, plugins: [plugin, nitroOrderPlugins()] }, "build")

    expect(handler).toHaveBeenCalledTimes(1)
    expect(config.define?.nitroConfigured).toBe(true)
    expect(plugin.config).toBe(hook)
  })

  it.each([
    { order: "post" },
    { order: "pre", handler: () => undefined },
  ] as const)("ignores an unsupported hook on an excluded Nitro plugin: %j", async (hook) => {
    const apply = vi.fn(() => false)
    const excluded = { name: "nitro:init", apply, config: hook } as Plugin
    const config = await resolveConfig({ configFile: false, plugins: [excluded, nitroOrderPlugins()] }, "build")

    expect(apply).toHaveBeenCalledTimes(1)
    expect(config.plugins).not.toContain(excluded)
    expect(excluded.config).toBe(hook)
  })
})
