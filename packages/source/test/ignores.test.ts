import { describe, expect, it } from "vitest"

import { sourceIgnores } from "../src/index.ts"

describe("Source ignores", () => {
  it("publishes frozen composable ignore groups", () => {
    expect(sourceIgnores.defaults).toEqual([
      ...sourceIgnores.dependencies,
      ...sourceIgnores.generated,
      ...sourceIgnores.media,
      ...sourceIgnores.secrets,
      ...sourceIgnores.system,
    ])
    expect(Object.isFrozen(sourceIgnores)).toBe(true)
    expect(Object.values(sourceIgnores).every(Object.isFrozen)).toBe(true)
    expect(sourceIgnores.defaults).toContain("**/node_modules/**")
    expect(sourceIgnores.defaults).toContain("**/.env.*")
  })
})
