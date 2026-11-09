import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

const css = (path: string) => readFileSync(new URL(`../src/console/runtime/components/${path}`, import.meta.url), "utf8")

// The declarations of every rule whose selector list contains the selector.
function declarations(source: string, selector: string): string[] {
  return [...source.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^}]*)\}/g)]
    .filter(([, selectors]) => selectors!.split(",").some(part => part.trim() === selector))
    .map(([, , body]) => body!)
}

// @vite-hub/ui/theme.css draws the one focus ring. These parts only make sure the focused control can be seen.
describe("Console focus", () => {
  it("shows a step action that hides until hover when it gets keyboard focus", () => {
    const rules = declarations(css("invocation/invocation.css"), ".vh-invocation-preparation__action:focus-visible")
    expect(rules.some(body => /opacity:\s*1/.test(body))).toBe(true)
  })

  it.each(["console-session.css", "invocation/invocation.css"])("%s leaves the focus ring to the theme", (file) => {
    const focusRules = [...css(file).replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^}]*)\}/g)]
      .filter(([, selectors]) => /:focus/.test(selectors!))
    expect(focusRules.filter(([, , body]) => /\b(?:outline|box-shadow)\s*:/.test(body!))).toEqual([])
  })
})
