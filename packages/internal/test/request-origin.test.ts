import { describe, expect, it } from "vitest"

import { forwardedRequestOrigin } from "../src/runtime/request-origin.ts"

function origin(host: string) {
  return forwardedRequestOrigin(new Request("http://internal.local/resource", {
    headers: { "x-forwarded-host": host, "x-forwarded-proto": "https" },
  }))
}

describe("forwarded host authority", () => {
  it.each(["public.example/path", "public.example?query", "public.example#fragment", "user@public.example", "public.example\\path", "pub\tlic.example"])("rejects malformed host %s", (host) => {
    expect(origin(host)).toBe("http://internal.local")
  })

  it.each([
    ["public.example", "https://public.example"],
    ["public.example:8443", "https://public.example:8443"],
    ["[2001:db8::1]:8443", "https://[2001:db8::1]:8443"],
    ["public.example, proxy.local", "https://public.example"],
  ])("accepts host %s", (host, expected) => {
    expect(origin(host)).toBe(expected)
  })
})
