import { expect, it } from "vitest"
import { isPagePath, pagePathOf } from "../src/operations-core/path.ts"
import { normalizeCommentPage } from "../src/page.ts"

it.each(["/a/..//evil.example/x", "/..//evil.example/x", "/a/%2e%2e//evil.example/x", "/%2e.//evil.example/x"])("rejects paths that normalize to protocol-relative links: %s", (path) => {
  expect(isPagePath(path)).toBe(false)
})

it.each(["/", "/pricing", "/a/../pricing", "/a/%2e%2e/pricing"])("accepts same-origin normalized paths: %s", (path) => {
  expect(isPagePath(path)).toBe(true)
})

it.each([
  ["https://drop.vitehub.dev/d/x/y", "/d/x/y"],
  ["HTTP://site.test/pricing/?plan=pro#top", "/pricing"],
  ["https://site.test", "/"],
  ["/pricing", "/pricing"],
  ["pricing", "/pricing"],
])("keys the page of %s as %s", (value, key) => {
  expect(normalizeCommentPage(value)).toBe(key)
})

it.each(["/pricing", "pricing page", "ftp://site.test/x", "https://"])("leaves %s that is no http(s) URL unchanged", (value) => {
  expect(pagePathOf(value)).toBe(value)
})
