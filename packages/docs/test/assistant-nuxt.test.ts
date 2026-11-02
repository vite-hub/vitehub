import { describe, expect, it } from "vitest"

import { setupDocsAssistant } from "../src/assistant-nuxt.ts"

type Hook = () => Promise<void>

function fakeNuxt(options: { modules: unknown[], dev?: boolean, preset?: string, vitehub?: Record<string, unknown> }) {
  const hooks = new Map<string, Hook>()
  const nuxt = {
    options: { modules: options.modules, dev: options.dev ?? false, nitro: { preset: options.preset }, ...(options.vitehub ? { vitehub: options.vitehub } : {}) },
    hook: (name: string, hook: Hook) => { hooks.set(name, hook) },
  }
  // SAFETY: setupDocsAssistant reads only `options.modules`, `options.dev`, `options.nitro`, `options.vitehub`, and `hook`.
  setupDocsAssistant(nuxt as never, { assistant: { agent: "docs" } })
  return async () => await hooks.get("modules:done")?.()
}

describe("setupDocsAssistant", () => {
  it("does nothing when the assistant is off", () => {
    const hooks: string[] = []
    // SAFETY: only `hook` is read when the assistant is off.
    setupDocsAssistant({ hook: (name: string) => hooks.push(name) } as never, { assistant: false })
    expect(hooks).toEqual([])
  })

  it("accepts vite-hub/nuxt with Agents on a Node host", async () => {
    const viteHub = Object.assign(() => undefined, { getMeta: async () => ({ name: "vite-hub/nuxt" }) })
    await expect(fakeNuxt({ modules: [["vite-hub/nuxt", { agent: true }]], preset: "node-server" })()).resolves.toBeUndefined()
    await expect(fakeNuxt({ modules: ["vite-hub/nuxt"], vitehub: { agent: true }, preset: "node-server" })()).resolves.toBeUndefined()
    await expect(fakeNuxt({ modules: [[viteHub, { agent: true }]], preset: "node-server" })()).resolves.toBeUndefined()
  })

  it("fails the build when ViteHub Agents are missing", async () => {
    await expect(fakeNuxt({ modules: [] })()).rejects.toThrow(/docs.assistant needs ViteHub Agents.*vitehub: \{ agent: true, connections: true \}/)
    await expect(fakeNuxt({ modules: [["vite-hub/nuxt", { agent: false }]] })()).rejects.toThrow("docs.assistant needs ViteHub Agents")
  })

  it("fails a Cloudflare build and allows a Cloudflare development server", async () => {
    const modules = [["vite-hub/nuxt", { agent: true }]]
    await expect(fakeNuxt({ modules, preset: "cloudflare-module" })()).rejects.toThrow(/Codex needs a Node.js host. The Nitro preset is "cloudflare-module"/)
    await expect(fakeNuxt({ modules, preset: "cloudflare-module", dev: true })()).resolves.toBeUndefined()
  })
})
