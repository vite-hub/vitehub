import { expect, it } from "vitest"
import { parseConsoleRecordLink } from "../src/console/runtime/definitions.ts"

it.each(["/\\evil.test/x", "/\t/evil.test/x", "/\n/evil.test/x", "/\r/evil.test/x"])("rejects browser-normalized cross-origin app path %j", (href) => {
  expect(new URL(href, "https://console.test").origin).toBe("https://evil.test")
  expect(parseConsoleRecordLink({ href, label: "Open" })).toBeUndefined()
})

it.each(["/", "/pricing?comments#comment-t1", "/page?next=https://example.test/", "https://example.test/thread"])("preserves supported link %j", (href) => {
  expect(parseConsoleRecordLink({ href, label: "Open" })).toEqual({ href, label: "Open" })
})
