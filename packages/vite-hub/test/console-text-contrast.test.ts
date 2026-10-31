import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

const styles = readFileSync(new URL("../src/console/runtime/client/styles.css", import.meta.url), "utf8")

function block(selector: string): string {
  const start = styles.indexOf(`${selector} {`)
  expect(start).toBeGreaterThan(-1)
  return styles.slice(start, styles.indexOf("}", start))
}

function token(css: string, name: string): string {
  const value = new RegExp(`--${name}:\\s*([^;]+);`).exec(css)?.[1]
  expect(value, name).toBeDefined()
  return value!.trim()
}

// Linear sRGB channels from the oklch() and hex forms that the Console theme uses.
function linear(color: string): [number, number, number] {
  const hex = /^#([\da-f]{6})$/i.exec(color)?.[1]
  if (hex) {
    return [0, 2, 4].map((index) => {
      const value = Number.parseInt(hex.slice(index, index + 2), 16) / 255
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
    }) as [number, number, number]
  }
  const match = /^oklch\(([\d.]+) ([\d.]+) ([\d.]+)\)$/.exec(color)
  expect(match, color).not.toBeNull()
  const [lightness, chroma, hue] = match!.slice(1).map(Number) as [number, number, number]
  const a = chroma * Math.cos((hue * Math.PI) / 180)
  const b = chroma * Math.sin((hue * Math.PI) / 180)
  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ].map(value => Math.min(1, Math.max(0, value))) as [number, number, number]
}

function contrast(foreground: string, background: string): number {
  const luminance = (color: string) => {
    const [red, green, blue] = linear(color)
    return 0.2126 * red + 0.7152 * green + 0.0722 * blue
  }
  const [light, dark] = [luminance(foreground), luminance(background)].sort((left, right) => right - left)
  return (light! + 0.05) / (dark! + 0.05)
}

describe("Console text contrast", () => {
  const themes = {
    "dark": block(".dark"),
    "light": block(":root"),
    "system dark": block(":root:not(.light):not(.dark)"),
  }

  it.each(Object.entries(themes))("keeps every text tone it sets at 4.5:1 on the %s page", (_name, theme) => {
    const background = token(theme, "ui-bg")
    const tones = ["ui-text", "ui-text-toned", "ui-text-muted", "ui-text-dimmed", "ui-text-highlighted"]
      .filter(name => theme.includes(`--${name}:`))
    expect(tones).toContain("ui-text-dimmed")
    for (const name of tones) {
      const value = token(theme, name)
      expect(contrast(value, background), `${name} ${value} on ${background}`).toBeGreaterThanOrEqual(4.5)
    }
  })
})
