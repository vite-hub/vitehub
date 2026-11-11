import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

import { consolePageToolColors, consoleStandaloneStyles, consoleThemeColors } from "../src/console/standalone-page.ts"

// The server pages cannot read @vite-hub/ui/theme.css, so standalone-page.ts keeps a copy of its tokens. These checks
// fail when the copy drifts from the theme or from the Tailwind shades that the theme takes its status colors from.
const themeCss = readFileSync(resolve(import.meta.dirname, "../../ui/theme.css"), "utf8")
const tailwindCss = readFileSync(createRequire(import.meta.url).resolve("tailwindcss/theme.css"), "utf8")

function declarations(css: string): Map<string, string> {
  return new Map(Array.from(css.matchAll(/(--[\w-]+):\s*([^;]+);/g), ([, name, value]) => [name!, value!.trim()]))
}

function block(selector: string): Map<string, string> {
  const start = themeCss.indexOf(`${selector} {`)
  return declarations(themeCss.slice(start, themeCss.indexOf("}", start)))
}

// Tailwind writes `oklch(50.5% 0.213 27.518)`; the copy writes `oklch(0.505 0.213 27.518)`.
function tailwind(name: string): string {
  const value = declarations(tailwindCss).get(`--color-${name}`)!
  return value.replace(/oklch\(([\d.]+)%/, (_, lightness: string) => `oklch(${Number((Number(lightness) / 100).toFixed(5))}`)
}

const standalone = new Map(Array.from(consoleStandaloneStyles.matchAll(/(--[\w-]+): light-dark\((.+), (.+)\);/g), ([, name, light, dark]) => [name!, { light: light!, dark: dark! }]))

describe("standalone page tokens", () => {
  it("match the light and dark tokens of the theme", () => {
    const light = block(":root")
    const dark = block(":root.dark")
    const shared = Array.from(standalone.keys()).filter(name => light.has(name) && !light.get(name)!.startsWith("var("))
    expect(shared.length).toBeGreaterThan(8)
    for (const name of shared) {
      expect(standalone.get(name), name).toEqual({ light: light.get(name), dark: dark.get(name) })
    }
  })

  it("use the Tailwind shades of the theme's status text colors", () => {
    expect(block(":root").get("--vh-text-error")).toBe("var(--ui-color-error-700)")
    expect(standalone.get("--vh-text-error")).toEqual({ light: tailwind("red-700"), dark: tailwind("red-400") })
    expect(block(":root").get("--vh-text-warning")).toBe("var(--ui-color-warning-800)")
    expect(standalone.get("--vh-text-warning")).toEqual({ light: tailwind("amber-800"), dark: tailwind("amber-400") })
  })

  it("give the page tool the warning dot shade and the focus blue", () => {
    expect(consolePageToolColors.draft).toBe(tailwind("amber-500"))
    expect(consolePageToolColors.picker).toBe(block(":root").get("--vh-focus"))
  })

  it("give the browser chrome the page color of the theme", () => {
    // `--ui-bg` is gray, so only its lightness counts: oklch L cubed is linear sRGB, then the sRGB transfer function.
    const hex = (value: string) => {
      const lightness = Number(/^oklch\(([\d.]+) 0 0\)$/.exec(value)![1])
      const linear = lightness ** 3
      const channel = Math.round(255 * (linear <= 0.0031308 ? 12.92 * linear : 1.055 * linear ** (1 / 2.4) - 0.055))
      return `#${channel.toString(16).padStart(2, "0").repeat(3)}`
    }
    expect(consoleThemeColors).toEqual({ light: hex(block(":root").get("--ui-bg")!), dark: hex(block(":root.dark").get("--ui-bg")!) })
  })
})
