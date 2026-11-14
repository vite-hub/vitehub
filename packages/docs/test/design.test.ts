import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import { describe, expect, it } from "vitest"

const runtime = fileURLToPath(new URL("../runtime/", import.meta.url))
const design = readFileSync(join(runtime, "theme/design.css"), "utf8")
const sharedUi = readFileSync(fileURLToPath(new URL("../../ui/styles.css", import.meta.url)), "utf8")
// The ViteHub design system declares the colors. design.css adds layout and the grain on top of it.
const theme = readFileSync(fileURLToPath(new URL("../../ui/theme.css", import.meta.url)), "utf8")

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? files(join(dir, entry.name)) : [join(dir, entry.name)])
}

const sources = files(runtime).filter(file => /\.(?:vue|css|ts)$/.test(file)).map(file => readFileSync(file, "utf8"))

// The value of a custom property in the rules of a stylesheet whose selector list names `selector`, such as `:root.dark`.
function token(selector: string, name: string, css = design): string {
  let value = ""
  for (const [, selectors, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!selectors!.replace(/\/\*[\s\S]*?\*\//g, "").split(",").map(part => part.trim().replace(":where(.vh-docs)", "")).includes(selector)) continue
    value = body!.match(new RegExp(`${name}:\\s*([^;]+);`))?.[1]?.trim() ?? value
  }
  // A token that reads a shadcn/ui name, such as `--ui-bg: var(--background)`, takes the value of that name.
  const read = /^var\((--[\w-]+)\)$/.exec(value)?.[1]
  return read ? token(selector, read, css) : value
}

// Gray OKLCH (`oklch(L 0 0)`) to relative luminance. With no chroma, OKLab's L cubed is the linear luminance. A
// translucent white (`rgb(255 255 255 / 5%)`), as the dark surfaces are, is blended over `page` in sRGB.
function luminance(value: string, page?: string): number {
  const lightness = value.match(/^oklch\(([\d.]+) 0 0\)$/)?.[1]
  if (lightness) return Number(lightness) ** 3
  const alpha = value.match(/^rgb\(255 255 255 \/ ([\d.]+)%\)$/)?.[1]
  if (!alpha || !page) throw new Error(`Not a gray this test can read: ${value}`)
  const encode = (linear: number) => linear <= 0.0031308 ? linear * 12.92 : 1.055 * linear ** (1 / 2.4) - 0.055
  const decode = (channel: number) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  const share = Number(alpha) / 100
  return decode(share + encode(luminance(page)) * (1 - share))
}

function contrast(a: string, b: string, page: string): number {
  const [light, dark] = [luminance(a, page), luminance(b, page)].sort((x, y) => y - x)
  return (light! + 0.05) / (dark! + 0.05)
}

describe("docs design", () => {
  it("declares every --vh-* token that the shell reads", () => {
    const declared = new Set([...sources, sharedUi, theme].flatMap(source => [...source.matchAll(/(--vh-[\w-]+)\s*:/g)].map(match => match[1]!)))
    // Vue binds some on the element in a template, as `'--vh-docs-logo': ...`, and scripts set others with `setProperty()`.
    for (const source of sources) {
      for (const match of source.matchAll(/'(--vh-[\w-]+)'\s*:|setProperty\("(--vh-[\w-]+)"/g)) declared.add((match[1] ?? match[2])!)
    }
    // A read with a fallback, such as `var(--vh-code-panel-top, ...)`, works undeclared.
    const read = new Set(sources.flatMap(source => [...source.matchAll(/var\((--vh-[\w-]+)\s*\)/g)].map(match => match[1]!)))

    expect([...read].filter(name => !declared.has(name))).toEqual([])
  })

  it.each([":root", ":root.dark"])("keeps body text at 4.5:1 or more on the page and the muted surface in %s", (selector) => {
    const page = token(selector, "--ui-bg", theme)
    for (const text of ["--ui-text-dimmed", "--ui-text-muted", "--ui-text", "--ui-text-highlighted"]) {
      for (const surface of ["--ui-bg", "--ui-bg-muted", "--ui-bg-elevated"]) {
        expect(contrast(token(selector, text, theme), token(selector, surface, theme), page), `${text} on ${surface}`).toBeGreaterThanOrEqual(4.5)
      }
    }
  })

  it("takes its colors from the design system", () => {
    expect([...design.matchAll(/^\s*(--ui-(?:bg|border|text)[\w-]*|--ui-radius|--font-[\w-]+)\s*:/gm)].map(match => match[1])).toEqual([])
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
