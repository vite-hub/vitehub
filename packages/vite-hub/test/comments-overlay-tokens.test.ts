import { readFileSync } from "node:fs"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

// The UI stylesheet defines its tokens as `currentColor` and `Canvas`, which are white on white inside a shadow root: a
// pressed button has `currentColor` for its background and the inverted color for its text. The overlay gives every
// token a color of its own, in both schemes. A browser does the cascade; this reads the same declarations.
const overlayCss = readFileSync(join(import.meta.dirname, "../src/comments-overlay/overlay.css"), "utf8")
const uiCss = readFileSync(join(import.meta.dirname, "../../ui/styles.css"), "utf8")

type Scheme = "dark" | "light"

/** The `--vh-ui-*` declarations of the first `:host` rule of the overlay stylesheet. */
function hostTokens(): Map<string, string> {
  const block = /:host \{([\s\S]*?)\n\}/.exec(overlayCss)?.[1] ?? ""
  return new Map([...block.matchAll(/(--vh-ui-[\w-]+):\s*([^;]+);/g)].map(([, name, value]) => [name!, value!.trim()]))
}

/** Splits `a, b` at the commas outside parentheses. */
function split(list: string): string[] {
  const parts: string[] = []
  let depth = 0
  let start = 0
  for (let index = 0; index < list.length; index++) {
    const char = list[index]
    if (char === "(") depth++
    else if (char === ")") depth--
    else if (char === "," && depth === 0) {
      parts.push(list.slice(start, index).trim())
      start = index + 1
    }
  }
  parts.push(list.slice(start).trim())
  return parts
}

/** A value as the browser computes it in a scheme: `var(--ui-x, fallback)` has no `--ui-x` here, and `light-dark()` picks. */
function evaluate(value: string, scheme: Scheme): string {
  const text = value.trim()
  const call = /^([\w-]+)\(([\s\S]*)\)$/.exec(text)
  if (!call) return text
  const [, name, inner] = call
  const args = split(inner!)
  if (name === "var") return evaluate(args[1] ?? "", scheme)
  if (name === "light-dark") return evaluate(args[scheme === "light" ? 0 : 1] ?? "", scheme)
  return text
}

function luminance(hex: string): number {
  const channels = [1, 3, 5].map(offset => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255)
  const [red, green, blue] = channels.map(channel => channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4)
  return 0.2126 * red! + 0.7152 * green! + 0.0722 * blue!
}

function contrast(first: string, second: string): number {
  const [high, low] = [luminance(first), luminance(second)].sort((a, b) => b - a)
  return (high! + 0.05) / (low! + 0.05)
}

describe("the overlay tokens", () => {
  const tokens = hostTokens()
  const color = (name: string, scheme: Scheme) => evaluate(tokens.get(`--vh-ui-${name}`) ?? "", scheme)

  it("defines every token that the parts use", () => {
    const used = new Set([...uiCss.matchAll(/var\((--vh-ui-[\w-]+)/g)].map(([, name]) => name!))
    expect([...used].filter(name => !tokens.has(name))).toEqual([])
  })

  it("leaves no token to currentColor or the system colors", () => {
    for (const [name, value] of tokens) expect(value, name).not.toMatch(/currentColor|Canvas|CanvasText/i)
  })

  it("gives every color token a concrete color in the light and the dark scheme", () => {
    for (const scheme of ["light", "dark"] as const) {
      for (const name of tokens.keys()) {
        if (/radius|ring/.test(name)) continue
        expect(color(name.slice("--vh-ui-".length), scheme), `${name} in ${scheme}`).toMatch(/^#[\da-f]{6}$/i)
      }
    }
  })

  it("reads, in both schemes, wherever the parts put one token on another", () => {
    const pairs: Array<[string, string, string]> = [
      ["highlighted", "inverted", "a pressed button and the count badge of a pin"],
      ["primary", "inverted", "a pin"],
      ["error", "inverted", "the Delete thread button"],
      ["bg-accented", "highlighted", "the initials of an avatar"],
      ["bg", "text", "the page of the overlay"],
      ["bg-elevated", "text", "a popover"],
      ["bg", "muted", "secondary text"],
      ["bg", "highlighted", "headings"],
      ["bg", "error", "an error message"],
    ]
    for (const scheme of ["light", "dark"] as const) {
      for (const [first, second, where] of pairs) {
        expect(contrast(color(first, scheme), color(second, scheme)), `${first} on ${second} in ${scheme}: ${where}`).toBeGreaterThanOrEqual(4.5)
      }
    }
  })

  it("makes light-dark() follow the app's choice through the dark class", () => {
    expect(overlayCss).toMatch(/:host \{[^}]*color-scheme: light dark;/)
    expect(overlayCss).toMatch(/:host\(\.dark\) \{ color-scheme: dark; \}/)
  })

  it("keeps the solid buttons readable", () => {
    expect(overlayCss).toContain('button[data-variant="solid"] { background: var(--vh-ui-highlighted); color: var(--vh-ui-inverted); }')
    expect(overlayCss).toContain('button[data-variant="solid"][data-color="error"] { background: var(--vh-ui-error); color: var(--vh-ui-inverted); }')
  })
})
