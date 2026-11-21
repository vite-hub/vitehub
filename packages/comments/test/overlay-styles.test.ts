import { expect, it } from "vitest"
import { overlayStyles } from "../src/overlay/styles.ts"

// The overlay's styles are outside the cascade layers of @vite-hub/ui/styles.css, so any rule of theirs beats a layered ui
// rule. A rule here on a part of the comment field once kept a wrapped new comment in a narrow column beside empty space.
it("leaves the comment field's layout to @vite-hub/ui", () => {
  const selectors = [...overlayStyles.matchAll(/([^{}]+)\{/g)].flatMap((rule) => (rule[1] ?? "").split(",").map((selector) => selector.trim()))
  const fieldParts = selectors.filter((selector) => /\[data-slot="(?:prompt-input-[a-z-]+|comment-composer)"\][^\s>+~]*$/.test(selector))
  expect(fieldParts).toEqual([])
})

// A dark page hides a shadow, and a Nuxt UI page's `.dark` tokens can give a card the page's color.
it("keeps a hairline around a card or a new comment, so it shows on a dark page", () => {
  const popover = /\n\[data-slot="comment-layer-popover"\] \{([^}]*)\}/.exec(overlayStyles)?.[1]
  expect(popover).toMatch(/box-shadow: 0 0 0 1px var\(--vh-bubble-edge, var\(--vh-border\)\),/)
})
