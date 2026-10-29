import { expect, it } from "vitest"
import { isPagePath } from "../src/operations-core/path.ts"

it.each(["/a/..//evil.example/x", "/..//evil.example/x", "/a/%2e%2e//evil.example/x", "/%2e.//evil.example/x"])("rejects paths that normalize to protocol-relative links: %s", (path) => {
  expect(isPagePath(path)).toBe(false)
})

it.each(["/", "/pricing", "/a/../pricing", "/a/%2e%2e/pricing"])("accepts same-origin normalized paths: %s", (path) => {
  expect(isPagePath(path)).toBe(true)
})
