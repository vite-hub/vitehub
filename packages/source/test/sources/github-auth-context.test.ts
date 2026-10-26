import { afterEach, describe, expect, it, vi } from "vitest"

import { github } from "../../src/github.ts"
import { createSource } from "../../src/index.ts"
import { requestAuthorization, stubGitHubSource } from "./fixtures/github.ts"

afterEach(() => vi.unstubAllGlobals())

describe.each([false, true])("GitHub Source reader credentials with cache=%s", (cached) => {
  it.each(["keys", "meta", "read"] as const)("keeps an anonymous reader anonymous during %s", async (operation) => {
    stubGitHubSource({ "README.md": "# Readme\n" })
    let token: string | undefined
    const source = github({
      auth: () => token,
      cache: cached ? { maxAge: 3600 } : false,
      ref: "main",
      repo: `acme/auth-${operation}-${cached}`,
    })
    const anonymous = createSource(source, { abortSignal: new AbortController().signal })
    await anonymous.revision()

    token = "another-reader-token"
    const authenticated = createSource(source)
    await authenticated.revision()
    vi.mocked(fetch).mockClear()

    if (operation === "keys") await anonymous.keys()
    else if (operation === "meta") await anonymous.meta("README.md")
    else await anonymous.read("README.md")

    const authorizations = vi.mocked(fetch).mock.calls.map(([, init]) => requestAuthorization(init))
    expect(authorizations.length).toBeGreaterThan(0)
    expect(authorizations).toEqual(authorizations.map(() => undefined))

    vi.mocked(fetch).mockClear()
    await authenticated.meta("README.md")
    expect(vi.mocked(fetch).mock.calls.map(([, init]) => requestAuthorization(init)))
      .toEqual(["Bearer another-reader-token"])
  })
})
