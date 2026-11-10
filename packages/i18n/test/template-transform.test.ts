import { compileTemplate } from "@vue/compiler-sfc"
import { describe, expect, it } from "vitest"

import { hubI18n } from "../src/vite.ts"

describe("production template descriptors", () => {
  it("keeps source text in both SSR slot branches and removes it from browser templates", () => {
    const options = { template: { compilerOptions: { nodeTransforms: [] } } }
    const plugin = hubI18n()
    const hook = plugin.configResolved!
    const resolved = typeof hook === "function" ? hook : hook.handler
    resolved.call({} as never, { isProduction: true, plugins: [{ name: "vite:vue", api: { options } }] } as never)
    const template = {
      source: "<Wrapper><p>{{ t`Slot fallback` }}</p></Wrapper>",
      filename: "Slot.vue",
      id: "slot",
      compilerOptions: options.template.compilerOptions,
    }
    const server = compileTemplate({ ...template, ssr: true, ssrCssVars: [] })
    expect(server.errors).toEqual([])
    // Vue emits an SSR branch and a VNode fallback branch for render-function components.
    expect(server.code.match(/Slot fallback/g)).toHaveLength(2)
    const browser = compileTemplate(template)
    expect(browser.errors).toEqual([])
    expect(browser.code).not.toContain("Slot fallback")
  })
})
