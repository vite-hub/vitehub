import { expect, it } from "vitest"
import { overlayStyles } from "../src/overlay/styles.ts"

// The overlay's styles are outside the cascade layers of @vite-hub/ui/styles.css, so any rule of theirs beats a layered ui
// rule. A rule here on a part of the comment field once kept a wrapped new comment in a narrow column beside empty space.
it("leaves the comment field's layout to @vite-hub/ui", () => {
  const selectors = [...overlayStyles.matchAll(/([^{}]+)\{/g)].flatMap((rule) => (rule[1] ?? "").split(",").map((selector) => selector.trim()))
  const fieldParts = selectors.filter((selector) => /\[data-slot="(?:prompt-input-[a-z-]+|comment-composer)"\][^\s>+~]*$/.test(selector))
  expect(fieldParts).toEqual([])
})
