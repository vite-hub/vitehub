import { describe, expect, it } from "vitest"

import { codemodsRange, withVersionPlaceholder } from "./fixture-version.ts"

describe("withVersionPlaceholder", () => {
  it("replaces the codemods range only on ViteHub packages", () => {
    const text = JSON.stringify({ dependencies: { "@vite-hub/blob": codemodsRange, "nuxt-auth-utils": codemodsRange, "vite-hub": codemodsRange } }, null, 2)
    expect(JSON.parse(withVersionPlaceholder(text) ?? "{}")).toEqual({ dependencies: { "@vite-hub/blob": "^<version>", "nuxt-auth-utils": codemodsRange, "vite-hub": "^<version>" } })
  })
})
