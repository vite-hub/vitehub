import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

const css = (path: string) => readFileSync(new URL(`../src/console/runtime/components/${path}`, import.meta.url), "utf8")

// The declarations of every rule whose selector list contains the selector.
function declarations(source: string, selector: string): string[] {
  return [...source.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^}]*)\}/g)]
    .filter(([, selectors]) => selectors!.split(",").some(part => part.trim() === selector))
    .map(([, , body]) => body!)
}

describe("Console focus rings", () => {
  it.each([
    ["console-session.css", ".session-inspector__surface-launcher > button:focus-visible"],
    ["invocation/invocation.css", ".vh-invocation-preparation__action:focus-visible"],
  ])("%s draws an outline for %s", (file, selector) => {
    const rules = declarations(css(file), selector)
    expect(rules.length).toBeGreaterThan(0)
    expect(rules.some(body => /outline:\s*2px solid/.test(body))).toBe(true)
    expect(rules.some(body => /outline:\s*none/.test(body))).toBe(false)
  })
})
