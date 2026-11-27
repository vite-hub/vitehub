import { describe, expect, it } from "vitest"

import { docsIconStroke } from "../src/navigation.ts"

// Bodies as @iconify-json/lucide, @iconify-json/simple-icons, and @vite-hub/icons ship them.
const lucideSun = `<g fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2"/></g>`
const githubLogo = `<path fill="currentColor" d="M12 .297c-6.63 0-12 5.373-12 12"/>`
const viteHubKv = `<g fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5"><rect x="3" y="5" width="18" height="14" rx="2"/></g>`

describe("docs icon stroke", () => {
  it("draws Lucide lines at the stroke of the ViteHub set", () => {
    expect(docsIconStroke(lucideSun, 1.5)).toBe(lucideSun.replace('stroke-width="2"', 'stroke-width="1.5"'))
  })

  it("leaves filled logos and the ViteHub set as they are", () => {
    expect(docsIconStroke(githubLogo, 1.5)).toBe(githubLogo)
    expect(docsIconStroke(viteHubKv, 1.5)).toBe(viteHubKv)
  })
})
