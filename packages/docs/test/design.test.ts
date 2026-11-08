import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import { describe, expect, it } from "vitest"

const runtime = fileURLToPath(new URL("../runtime/", import.meta.url))
const design = readFileSync(join(runtime, "theme/design.css"), "utf8")
const sharedUi = readFileSync(fileURLToPath(new URL("../../ui/styles.css", import.meta.url)), "utf8")

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? files(join(dir, entry.name)) : [join(dir, entry.name)])
}

const sources = files(runtime).filter(file => /\.(?:vue|css|ts)$/.test(file)).map(file => readFileSync(file, "utf8"))

// The value of a custom property in the rules of design.css whose selector list names `selector`, such as `:root.dark`.
// The design scopes its rules with `:where(.vh-docs)`, which adds no specificity, so `:root.dark` finds them too.
function token(selector: string, name: string): string {
  let value = ""
  for (const [, selectors, body] of design.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!selectors!.replace(/\/\*[\s\S]*?\*\//g, "").split(",").map(part => part.trim().replace(":where(.vh-docs)", "")).includes(selector)) continue
    value = body!.match(new RegExp(`${name}:\\s*([^;]+);`))?.[1]?.trim() ?? value
  }
  return value
}

// Gray OKLCH (`oklch(L 0 0)`) or #fff to relative luminance. With no chroma, OKLab's L cubed is the linear luminance.
function luminance(value: string): number {
  if (value === "#fff") return 1
  const lightness = value.match(/^oklch\(([\d.]+) 0 0\)$/)?.[1]
  if (!lightness) throw new Error(`Not a gray this test can read: ${value}`)
  return Number(lightness) ** 3
}

function contrast(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (light! + 0.05) / (dark! + 0.05)
}

describe("docs design", () => {
  it("declares every --vh-* token that the shell reads", () => {
    const declared = new Set([...sources, sharedUi].flatMap(source => [...source.matchAll(/(--vh-[\w-]+)\s*:/g)].map(match => match[1]!)))
    // Vue binds some on the element in a template, as `'--vh-docs-logo': ...`, and scripts set others with `setProperty()`.
    for (const source of sources) {
      for (const match of source.matchAll(/'(--vh-[\w-]+)'\s*:|setProperty\("(--vh-[\w-]+)"/g)) declared.add((match[1] ?? match[2])!)
    }
    // A read with a fallback, such as `var(--vh-code-panel-top, ...)`, works undeclared.
    const read = new Set(sources.flatMap(source => [...source.matchAll(/var\((--vh-[\w-]+)\s*\)/g)].map(match => match[1]!)))

    expect([...read].filter(name => !declared.has(name))).toEqual([])
  })

  it.each([":root", ":root.dark"])("keeps body text at 4.5:1 or more on the page and the muted surface in %s", (selector) => {
    for (const text of ["--ui-text-dimmed", "--ui-text-muted", "--ui-text", "--ui-text-highlighted"]) {
      for (const surface of ["--ui-bg", "--ui-bg-muted", "--ui-bg-elevated"]) {
        expect(contrast(token(selector, text), token(selector, surface)), `${text} on ${surface}`).toBeGreaterThanOrEqual(4.5)
      }
    }
  })

  it("paints a faint grain that `--vh-grain: none` turns off", () => {
    expect(token(":root", "--vh-grain")).toContain("feTurbulence")
    expect(token(":root", "--vh-grain")).toContain("opacity='0.035'")
    expect(design).toMatch(/body,\s*\.vh-grain-surface\s*\{[^}]*background-image:\s*var\(--vh-grain\)/)
  })

  it("puts comark-ui's layer between Tailwind's base and its utilities", () => {
    const module = readFileSync(fileURLToPath(new URL("../src/nuxt.ts", import.meta.url)), "utf8")

    expect(module).toContain("`@layer theme, base, comark, components, utilities;`")
    expect(module.indexOf("@layer theme, base, comark")).toBeLessThan(module.indexOf("@import \"tailwindcss\""))
  })
})
